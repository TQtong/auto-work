[CmdletBinding()]
param(
    [string]$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AutoWork'),
    [string]$RepositoryRoot = 'D:\company',
    [ValidateRange(1024, 65535)][int]$Port = 3760,
    [switch]$NoStart
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-AutoWorkWindows
Assert-AutoWorkRuntime
$PackageRoot = Resolve-AutoWorkPath $PackageRoot
$InstallRoot = Assert-AutoWorkInstallRoot $InstallRoot
$RepositoryRoot = Resolve-AutoWorkPath $RepositoryRoot
Test-AutoWorkReleaseChecksums $PackageRoot
$manifest = Get-AutoWorkReleaseManifest $PackageRoot
if (Get-AutoWorkCurrentVersion $InstallRoot) { throw '目标位置已有安装，请使用 Upgrade-AutoWork.ps1。' }

$dataRoot = Join-Path $InstallRoot 'data'
$releaseRoot = Get-AutoWorkVersionRoot $InstallRoot $manifest.version
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'releases'), $dataRoot | Out-Null
Copy-AutoWorkRelease -PackageRoot $PackageRoot -Destination $releaseRoot
Write-AutoWorkEnvironment -ReleaseRoot $releaseRoot -DataRoot $dataRoot -RepositoryRoot $RepositoryRoot -Port $Port
Invoke-AutoWorkPnpm -WorkingDirectory $releaseRoot -Arguments @('install', '--prod', '--frozen-lockfile')
Invoke-AutoWorkPnpm -WorkingDirectory $releaseRoot -Arguments @('db:generate')
Invoke-AutoWorkPnpm -WorkingDirectory $releaseRoot -Arguments @('db:deploy')
Invoke-AutoWorkPnpm -WorkingDirectory $releaseRoot -Arguments @('db:status')
Set-AutoWorkCurrentVersion -InstallRoot $InstallRoot -Version $manifest.version
Write-Host "Auto Work $($manifest.version) 已安装到 $InstallRoot。"
if (-not $NoStart) { & (Join-Path $releaseRoot 'scripts/windows/Start-AutoWork.ps1') -InstallRoot $InstallRoot }
