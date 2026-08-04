[CmdletBinding()]
param(
    [string]$BridgeRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path 'data\desktop-bridge'),
    [int]$PollMilliseconds = 250,
    [int]$MaxRequestAgeSeconds = 600,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PollMilliseconds -lt 100 -or $PollMilliseconds -gt 5000) { throw 'PollMilliseconds 必须在 100 到 5000 之间。' }
if ($MaxRequestAgeSeconds -lt 30 -or $MaxRequestAgeSeconds -gt 3600) { throw 'MaxRequestAgeSeconds 必须在 30 到 3600 之间。' }
$BridgeRoot = [System.IO.Path]::GetFullPath($BridgeRoot)
$requestRoot = Join-Path $BridgeRoot 'requests'
$responseRoot = Join-Path $BridgeRoot 'responses'
$workRoot = Join-Path $BridgeRoot 'working'
New-Item -ItemType Directory -Force -Path $requestRoot, $responseRoot, $workRoot | Out-Null
$runner = Join-Path $PSScriptRoot 'Invoke-DingTalkDesktopAutomation.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "桌面自动化脚本不存在：$runner" }
$heartbeatPath = Join-Path $BridgeRoot 'heartbeat.json'
$heartbeatStagingPath = Join-Path $BridgeRoot ".heartbeat.$PID.tmp"
$lastHeartbeatAt = [DateTimeOffset]::MinValue

function Write-BridgeHeartbeat {
    $heartbeat = @{
        version = 1
        processId = $PID
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($heartbeatStagingPath, $heartbeat, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $heartbeatStagingPath -Destination $heartbeatPath -Force
    $script:lastHeartbeatAt = [DateTimeOffset]::UtcNow
}

Write-Host "Auto Work 钉钉桌面桥接已启动：$BridgeRoot"
while ($true) {
    if (([DateTimeOffset]::UtcNow - $lastHeartbeatAt).TotalSeconds -ge 1) {
        Write-BridgeHeartbeat
    }
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
        $expiresAt = if ($payload.PSObject.Properties.Name -contains 'bridgeExpiresAt') {
            [DateTimeOffset]::Parse([string]$payload.bridgeExpiresAt)
        } else {
            [DateTimeOffset]($request.LastWriteTimeUtc.AddSeconds($MaxRequestAgeSeconds))
        }
        if ([DateTimeOffset]::UtcNow -gt $expiresAt) {
            throw 'DINGTALK_DESKTOP_REQUEST_EXPIRED|桌面自动化请求已过期，为避免误提交旧周报已拒绝执行'
        }
        if ($payload.operation -eq 'submit') {
            $payload | Add-Member -NotePropertyName evidenceDirectory -NotePropertyValue (Join-Path (Split-Path $BridgeRoot -Parent) 'dingtalk-desktop-evidence') -Force
            [System.IO.File]::WriteAllText($working, ($payload | ConvertTo-Json -Depth 12 -Compress), [System.Text.UTF8Encoding]::new($true))
        }
        # Run each request in an isolated PowerShell process. The runner uses process exit codes
        # for direct API mode; isolation prevents those exit codes from stopping this bridge loop.
        # Publish the response only after the isolated runner has exited. Writing directly to
        # the watched response directory lets the API consume/delete the file before this
        # process checks it, which can incorrectly replace a valid result with a bridge error.
        $runnerArguments = @(
            '-NoProfile',
            '-NonInteractive',
            '-Sta',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            ('"{0}"' -f $runner),
            '-InputPath',
            ('"{0}"' -f $working),
            '-OutputPath',
            ('"{0}"' -f $stagingResponse)
        )
        $runnerProcess = Start-Process `
            -FilePath (Join-Path $PSHOME 'powershell.exe') `
            -ArgumentList $runnerArguments `
            -PassThru `
            -WindowStyle Hidden
        while (-not $runnerProcess.WaitForExit(1000)) {
            Write-BridgeHeartbeat
        }
        Write-BridgeHeartbeat
        if (-not (Test-Path -LiteralPath $stagingResponse -PathType Leaf)) {
            throw "Desktop runner exited without a response (exit code $($runnerProcess.ExitCode))."
        }
        Move-Item -LiteralPath $stagingResponse -Destination $response -Force
    } catch {
        $parts = $_.Exception.Message -split '\|', 2
        $knownCode = $parts.Count -eq 2 -and $parts[0] -match '^DINGTALK_DESKTOP_[A-Z0-9_]+$'
        $errorCode = if ($knownCode) { $parts[0] } else { 'DINGTALK_DESKTOP_BRIDGE_FAILED' }
        $message = if ($knownCode) { $parts[1] } else { $_.Exception.Message }
        $fallback = @{ success = $false; status = 'failed'; errorCode = $errorCode; message = $message } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($stagingResponse, $fallback, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $stagingResponse -Destination $response -Force
    } finally {
        Remove-Item -LiteralPath $working -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stagingResponse -Force -ErrorAction SilentlyContinue
        Write-BridgeHeartbeat
    }
    if ($Once) { break }
}
