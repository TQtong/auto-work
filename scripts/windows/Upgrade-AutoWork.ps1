[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AutoWork'),
    [int]$BackupTimeoutSeconds = 240,
    [switch]$NoStart
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-AutoWorkWindows
Assert-AutoWorkRuntime
$PackageRoot = Resolve-AutoWorkPath $PackageRoot
$InstallRoot = Assert-AutoWorkInstallRoot $InstallRoot
Test-AutoWorkReleaseChecksums $PackageRoot
$newManifest = Get-AutoWorkReleaseManifest $PackageRoot
$currentVersion = Get-AutoWorkCurrentVersion $InstallRoot
if (-not $currentVersion) { throw '没有现有安装，请使用 Install-AutoWork.ps1。' }
if ($currentVersion -eq $newManifest.version) { throw '目标版本与当前版本相同。' }
$currentRoot = Get-AutoWorkVersionRoot $InstallRoot $currentVersion
$currentManifest = Get-AutoWorkReleaseManifest $currentRoot
$envFile = Join-Path $currentRoot '.env'
$port = [int]((Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^AUTO_WORK_PORT=' } | Select-Object -First 1) -replace '^AUTO_WORK_PORT=', '')
$dataRoot = ((Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^AUTO_WORK_DATA_DIR=' } | Select-Object -First 1) -replace '^AUTO_WORK_DATA_DIR=', '').Replace('/', '\')
$repositoryRoot = ((Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^AUTO_WORK_REPOSITORY_ROOT=' } | Select-Object -First 1) -replace '^AUTO_WORK_REPOSITORY_ROOT=', '').Replace('/', '\')

Write-Host '正在创建并隔离校验升级前数据库备份……'
$backup = Invoke-AutoWorkApiBackup -Port $port -TimeoutSeconds $BackupTimeoutSeconds
& (Join-Path $currentRoot 'scripts/windows/Stop-AutoWork.ps1') -InstallRoot $InstallRoot

$newRoot = Get-AutoWorkVersionRoot $InstallRoot $newManifest.version
Copy-AutoWorkRelease -PackageRoot $PackageRoot -Destination $newRoot
Write-AutoWorkEnvironment -ReleaseRoot $newRoot -DataRoot $dataRoot -RepositoryRoot $repositoryRoot -Port $port
try {
    Invoke-AutoWorkPnpm -WorkingDirectory $newRoot -Arguments @('install', '--prod', '--frozen-lockfile')
    Invoke-AutoWorkPnpm -WorkingDirectory $newRoot -Arguments @('db:generate')
    Invoke-AutoWorkPnpm -WorkingDirectory $newRoot -Arguments @('db:deploy')
    Invoke-AutoWorkPnpm -WorkingDirectory $newRoot -Arguments @('db:status')
}
catch {
    Write-Warning "升级失败，当前版本指针仍为 $currentVersion。数据库备份：$($backup.fileName)，SHA-256：$($backup.sha256)。请按运行手册执行恢复，禁止直接启动旧版本猜测兼容性。"
    throw
}

$historyRoot = Join-Path $InstallRoot 'upgrade-history'
New-Item -ItemType Directory -Force -Path $historyRoot | Out-Null
$history = @{ fromVersion = $currentVersion; toVersion = $newManifest.version; fromSchema = $currentManifest.schemaChecksum; toSchema = $newManifest.schemaChecksum; backupFileName = $backup.fileName; backupSha256 = $backup.sha256; backupSchema = $backup.schemaChecksum; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }
[System.IO.File]::WriteAllText((Join-Path $historyRoot "$($newManifest.version).json"), ($history | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $InstallRoot 'previous.version'), "$currentVersion`n", [System.Text.UTF8Encoding]::new($false))
Set-AutoWorkCurrentVersion -InstallRoot $InstallRoot -Version $newManifest.version
Write-Host "Auto Work 已从 $currentVersion 升级到 $($newManifest.version)，备份 $($backup.fileName) 已验证。"
if (-not $NoStart) { & (Join-Path $newRoot 'scripts/windows/Start-AutoWork.ps1') -InstallRoot $InstallRoot }
