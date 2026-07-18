[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AutoWork'),
    [switch]$Force
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-AutoWorkWindows
$InstallRoot = Assert-AutoWorkInstallRoot $InstallRoot
$pidPath = Join-Path (Join-Path $InstallRoot 'run') 'auto-work.pid.json'
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Host 'Auto Work 未运行。'
    exit 0
}
$record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Host '已清理过期 PID 文件。'
    exit 0
}
$startedAt = [DateTimeOffset]::Parse($record.startedAt)
$actualStart = [DateTimeOffset]$process.StartTime.ToUniversalTime()
if ([Math]::Abs(($actualStart - $startedAt).TotalSeconds) -gt 10) {
    throw 'PID 已被其他进程复用，拒绝停止；请人工核对。'
}
Stop-Process -Id $process.Id
if (-not $process.WaitForExit(15000)) {
    if (-not $Force) { throw '进程 15 秒内未退出；确认后使用 -Force。' }
    Stop-Process -Id $process.Id -Force
}
Remove-Item -LiteralPath $pidPath -Force
Write-Host "Auto Work PID $($record.pid) 已停止。"
