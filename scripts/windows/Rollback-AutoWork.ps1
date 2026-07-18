[CmdletBinding()]
param(
    [string]$TargetVersion,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AutoWork'),
    [string]$BackupFile,
    [string]$ExpectedSha256,
    [string]$BackupSchemaChecksum,
    [string]$Confirmation,
    [switch]$NoStart
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-AutoWorkWindows
$InstallRoot = Assert-AutoWorkInstallRoot $InstallRoot
$currentVersion = Get-AutoWorkCurrentVersion $InstallRoot
if (-not $currentVersion) { throw '没有可回滚的安装。' }
if (-not $TargetVersion) {
    $previousPath = Join-Path $InstallRoot 'previous.version'
    if (-not (Test-Path -LiteralPath $previousPath -PathType Leaf)) { throw '缺少 previous.version，请显式传入 -TargetVersion。' }
    $TargetVersion = (Get-Content -LiteralPath $previousPath -Raw -Encoding UTF8).Trim()
}
if ($TargetVersion -eq $currentVersion) { throw '目标版本与当前版本相同。' }
$currentRoot = Get-AutoWorkVersionRoot $InstallRoot $currentVersion
$targetRoot = Get-AutoWorkVersionRoot $InstallRoot $TargetVersion
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) { throw "目标版本未安装：$TargetVersion" }
$currentManifest = Get-AutoWorkReleaseManifest $currentRoot
$targetManifest = Get-AutoWorkReleaseManifest $targetRoot

if ($currentManifest.schemaChecksum -ne $targetManifest.schemaChecksum) {
    if (-not $BackupFile -or $ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or -not $BackupSchemaChecksum) {
        throw '数据库 schema 不向后兼容；必须提供升级前 -BackupFile、-ExpectedSha256、-BackupSchemaChecksum 和确认文本。'
    }
    if ($Confirmation -ne "恢复备份并回滚 $TargetVersion") {
        throw "确认文本不匹配，请输入：恢复备份并回滚 $TargetVersion"
    }
    $dataRoot = Join-Path $InstallRoot 'data'
    $backupRoot = Resolve-AutoWorkPath (Join-Path $dataRoot 'backups')
    $backupPath = Resolve-AutoWorkPath $BackupFile
    if (-not $backupPath.StartsWith($backupRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '恢复文件必须位于当前安装的数据 backups 目录。'
    }
    if ((Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) {
        throw '恢复备份 SHA-256 不匹配。'
    }
    if ($BackupSchemaChecksum -ne $targetManifest.schemaChecksum) {
        throw '备份 schema 与目标版本不兼容。'
    }
}

& (Join-Path $currentRoot 'scripts/windows/Stop-AutoWork.ps1') -InstallRoot $InstallRoot
if ($currentManifest.schemaChecksum -ne $targetManifest.schemaChecksum) {
    $dataRoot = Join-Path $InstallRoot 'data'
    $backupRoot = Resolve-AutoWorkPath (Join-Path $dataRoot 'backups')
    $backupPath = Resolve-AutoWorkPath $BackupFile
    $databasePath = Join-Path $dataRoot 'auto-work.db'
    $pending = @{ restoreId = [guid]::NewGuid().ToString(); artifactId = [guid]::NewGuid().ToString(); sourcePath = $backupPath; sourceSha256 = $ExpectedSha256; targetDatabasePath = $databasePath; schemaChecksum = $BackupSchemaChecksum; safetyBackupArtifactId = [guid]::NewGuid().ToString(); requestedAt = [DateTimeOffset]::UtcNow.ToString('o') }
    [System.IO.File]::WriteAllText((Join-Path $dataRoot 'pending-restore.json'), ($pending | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Write-Host '已写入启动前原子恢复清单；目标版本启动时将先校验哈希并保留紧急备份。'
}

[System.IO.File]::WriteAllText((Join-Path $InstallRoot 'previous.version'), "$currentVersion`n", [System.Text.UTF8Encoding]::new($false))
Set-AutoWorkCurrentVersion -InstallRoot $InstallRoot -Version $TargetVersion
Write-Host "应用版本已回滚到 $TargetVersion。"
if (-not $NoStart) { & (Join-Path $targetRoot 'scripts/windows/Start-AutoWork.ps1') -InstallRoot $InstallRoot }
