[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AutoWork'),
    [int]$ReadyTimeoutSeconds = 45
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-AutoWorkWindows
$InstallRoot = Assert-AutoWorkInstallRoot $InstallRoot
$version = Get-AutoWorkCurrentVersion $InstallRoot
if (-not $version) { throw '尚未安装 Auto Work。' }
$releaseRoot = Get-AutoWorkVersionRoot $InstallRoot $version
$entrypoint = Join-Path $releaseRoot 'apps/api/dist/main.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "启动入口不存在：$entrypoint" }

$runRoot = Join-Path $InstallRoot 'run'
$logRoot = Join-Path $InstallRoot 'logs'
New-Item -ItemType Directory -Force -Path $runRoot, $logRoot | Out-Null
$pidPath = Join-Path $runRoot 'auto-work.pid.json'
if (Test-Path -LiteralPath $pidPath) {
    $existing = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue) {
        throw "Auto Work 已在运行，PID $($existing.pid)。"
    }
}

$process = Start-Process -FilePath 'node' -ArgumentList 'apps/api/dist/main.js' -WorkingDirectory $releaseRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'app.stdout.log') -RedirectStandardError (Join-Path $logRoot 'app.stderr.log')
$pidRecord = @{ pid = $process.Id; version = $version; releaseRoot = $releaseRoot; startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
[System.IO.File]::WriteAllText($pidPath, ($pidRecord | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

$manifest = Get-AutoWorkReleaseManifest $releaseRoot
$portLine = Get-Content -LiteralPath (Join-Path $releaseRoot '.env') -Encoding UTF8 | Where-Object { $_ -match '^AUTO_WORK_PORT=' } | Select-Object -First 1
$port = [int]($portLine -replace '^AUTO_WORK_PORT=', '')
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
$startedSuccessfully = $false
try {
    do {
        if ($process.HasExited) { throw "Auto Work 启动失败，退出码 $($process.ExitCode)，请检查 logs/app.stderr.log。" }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 3
            if ($health.data.liveness -eq 'ok') {
                $startedSuccessfully = $true
                Write-Host "Auto Work $($manifest.version) 已启动：http://127.0.0.1:$port"
                return
            }
        }
        catch { Start-Sleep -Milliseconds 750 }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Auto Work 在 $ReadyTimeoutSeconds 秒内未通过健康检查。"
}
finally {
    if (-not $startedSuccessfully) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
}
