[CmdletBinding()]
param(
    [string]$BridgeRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path 'data\desktop-bridge'),
    [int]$PollMilliseconds = 250,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PollMilliseconds -lt 100 -or $PollMilliseconds -gt 5000) { throw 'PollMilliseconds 必须在 100 到 5000 之间。' }
$BridgeRoot = [System.IO.Path]::GetFullPath($BridgeRoot)
$requestRoot = Join-Path $BridgeRoot 'requests'
$responseRoot = Join-Path $BridgeRoot 'responses'
$workRoot = Join-Path $BridgeRoot 'working'
New-Item -ItemType Directory -Force -Path $requestRoot, $responseRoot, $workRoot | Out-Null
$runner = Join-Path $PSScriptRoot 'Invoke-DingTalkDesktopAutomation.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "桌面自动化脚本不存在：$runner" }

Write-Host "Auto Work 钉钉桌面桥接已启动：$BridgeRoot"
while ($true) {
    $request = Get-ChildItem -LiteralPath $requestRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object CreationTimeUtc |
        Select-Object -First 1
    if (-not $request) { Start-Sleep -Milliseconds $PollMilliseconds; continue }
    $working = Join-Path $workRoot $request.Name
    try {
        Move-Item -LiteralPath $request.FullName -Destination $working -ErrorAction Stop
    } catch { continue }
    $response = Join-Path $responseRoot $request.Name
    $stagingResponse = Join-Path $workRoot "$($request.BaseName).response.json"
    try {
        # API 在容器内看到的证据路径不属于 Windows；桥接端始终重写到共享目录的同级宿主机目录。
        $payload = Get-Content -LiteralPath $working -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($payload.operation -eq 'submit') {
            $payload | Add-Member -NotePropertyName evidenceDirectory -NotePropertyValue (Join-Path (Split-Path $BridgeRoot -Parent) 'dingtalk-desktop-evidence') -Force
            [System.IO.File]::WriteAllText($working, ($payload | ConvertTo-Json -Depth 12 -Compress), [System.Text.UTF8Encoding]::new($true))
        }
        # Run each request in an isolated PowerShell process. The runner uses process exit codes
        # for direct API mode; isolation prevents those exit codes from stopping this bridge loop.
        # Publish the response only after the isolated runner has exited. Writing directly to
        # the watched response directory lets the API consume/delete the file before this
        # process checks it, which can incorrectly replace a valid result with a bridge error.
        & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File $runner -InputPath $working -OutputPath $stagingResponse
        if (-not (Test-Path -LiteralPath $stagingResponse -PathType Leaf)) {
            throw "Desktop runner exited without a response (exit code $LASTEXITCODE)."
        }
        Move-Item -LiteralPath $stagingResponse -Destination $response -Force
    } catch {
        $fallback = @{ success = $false; status = 'failed'; errorCode = 'DINGTALK_DESKTOP_BRIDGE_FAILED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($stagingResponse, $fallback, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $stagingResponse -Destination $response -Force
    } finally {
        Remove-Item -LiteralPath $working -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stagingResponse -Force -ErrorAction SilentlyContinue
    }
    if ($Once) { break }
}
