Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-AutoWorkWindows {
    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
        throw 'Auto Work 发布脚本只支持 Windows。'
    }
}

function Resolve-AutoWorkPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-AutoWorkInstallRoot {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $resolved = Resolve-AutoWorkPath $InstallRoot
    $root = [System.IO.Path]::GetPathRoot($resolved)
    if ($resolved.TrimEnd('\') -eq $root.TrimEnd('\')) {
        throw "安装目录不能是磁盘根目录：$resolved"
    }
    if ($resolved.Split([System.IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries).Count -lt 2) {
        throw "安装目录层级过浅：$resolved"
    }
    return $resolved
}

function Assert-AutoWorkCommand {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "缺少必需命令：$Name"
    }
}

function Assert-AutoWorkRuntime {
    Assert-AutoWorkCommand 'node'
    Assert-AutoWorkCommand 'pnpm'
    $nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
    if ($nodeVersion -lt [version]'22.14.0' -or $nodeVersion.Major -ge 23) {
        throw "Node.js 版本不受支持：$nodeVersion；要求 >=22.14.0 <23。"
    }
    $pnpmVersion = (& pnpm --version).Trim()
    if ($pnpmVersion -ne '10.14.0') {
        throw "pnpm 版本不匹配：$pnpmVersion；发布包固定要求 10.14.0。"
    }
}

function Get-AutoWorkReleaseManifest {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)
    $manifestPath = Join-Path $ReleaseRoot 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "发布包缺少 release-manifest.json：$ReleaseRoot"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $packagePath = Join-Path $ReleaseRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw '发布包缺少根 package.json。' }
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.product -ne 'auto-work' -or $manifest.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
        throw '发布清单产品名或版本无效。'
    }
    if ($manifest.version -ne $package.version) { throw '发布清单版本与根 package.json 不一致。' }
    if ($manifest.schemaChecksum -notmatch '^20[0-9]{12}_[a-z0-9_]+$') { throw '发布清单 schemaChecksum 无效。' }
    if ($manifest.gitCommit -notmatch '^[a-f0-9]{40}$') { throw '发布清单 Git commit 无效。' }
    return $manifest
}

function Test-AutoWorkReleaseChecksums {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)
    $resolvedRoot = Resolve-AutoWorkPath $ReleaseRoot
    $checksumPath = Join-Path $resolvedRoot 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
        throw '发布包缺少 SHA256SUMS。'
    }
    $checked = 0
    foreach ($line in Get-Content -LiteralPath $checksumPath -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([a-f0-9]{64}) \*(.+)$') {
            throw "无法解析校验和行：$line"
        }
        $relativePath = $Matches[2].Replace('/', '\')
        $target = Resolve-AutoWorkPath (Join-Path $resolvedRoot $relativePath)
        if (-not $target.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "校验和清单包含越界路径：$relativePath"
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "校验和清单文件不存在：$relativePath"
        }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $Matches[1]) {
            throw "发布文件校验失败：$relativePath"
        }
        $checked++
    }
    if ($checked -lt 10) { throw "校验和清单异常，仅包含 $checked 个文件。" }
    Write-Host "发布包校验通过：$checked 个文件。"
}

function Get-AutoWorkCurrentVersion {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $pointer = Join-Path $InstallRoot 'current.version'
    if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return $null }
    $version = (Get-Content -LiteralPath $pointer -Raw -Encoding UTF8).Trim()
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
        throw "当前版本指针损坏：$version"
    }
    return $version
}

function Set-AutoWorkCurrentVersion {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )
    $pointer = Join-Path $InstallRoot 'current.version'
    $temporary = "$pointer.tmp"
    [System.IO.File]::WriteAllText($temporary, "$Version`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $pointer -Force
}

function Get-AutoWorkVersionRoot {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )
    return Join-Path (Join-Path $InstallRoot 'releases') $Version
}

function Copy-AutoWorkRelease {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        throw "目标版本目录已经存在，拒绝覆盖：$Destination"
    }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $PackageRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse
    }
}

function Write-AutoWorkEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $databasePath = (Join-Path $DataRoot 'auto-work.db').Replace('\', '/')
    $webPath = (Join-Path $ReleaseRoot 'apps/web/dist').Replace('\', '/')
    $lines = @(
        'AUTO_WORK_HOST=127.0.0.1',
        "AUTO_WORK_PORT=$Port",
        "AUTO_WORK_DATA_DIR=$($DataRoot.Replace('\', '/'))",
        "AUTO_WORK_WEB_DIST=$webPath",
        "AUTO_WORK_DATABASE_URL=file:$databasePath",
        "AUTO_WORK_REPOSITORY_ROOT=$($RepositoryRoot.Replace('\', '/'))",
        'AUTO_WORK_LOG_LEVEL=info',
        'NODE_ENV=production'
    )
    [System.IO.File]::WriteAllText((Join-Path $ReleaseRoot '.env'), ($lines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
}

function Invoke-AutoWorkPnpm {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previousEnvironment = @{}
    $environmentPath = Join-Path $WorkingDirectory '.env'
    if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $environmentPath -Encoding UTF8) {
            if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
            $pair = $line.Split('=', 2)
            if ($pair.Count -ne 2 -or $pair[0] -notmatch '^[A-Z][A-Z0-9_]+$') {
                throw "无法解析运行环境行：$line"
            }
            $previousEnvironment[$pair[0]] = [Environment]::GetEnvironmentVariable($pair[0], 'Process')
            [Environment]::SetEnvironmentVariable($pair[0], $pair[1], 'Process')
        }
    }
    Push-Location $WorkingDirectory
    try {
        & pnpm @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm $($Arguments -join ' ') 执行失败，退出码 $LASTEXITCODE。"
        }
    }
    finally {
        Pop-Location
        foreach ($name in $previousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
    }
}

function Invoke-AutoWorkApiBackup {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSeconds = 240
    )
    $baseUrl = "http://127.0.0.1:$Port/api/v1"
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $sessionResponse = Invoke-RestMethod -Uri "$baseUrl/session" -WebSession $session -Method Get -TimeoutSec 10
    $csrf = $sessionResponse.data.csrfToken
    if ($csrf -notmatch '^[a-f0-9]{64}$') { throw '本机服务没有返回有效 CSRF 令牌。' }
    $headers = @{ Origin = "http://127.0.0.1:$Port"; 'X-CSRF-Token' = $csrf }
    $create = Invoke-RestMethod -Uri "$baseUrl/maintenance/backup" -WebSession $session -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10
    $createResult = Wait-AutoWorkOperation -BaseUrl $baseUrl -OperationId $create.data.operationId -Session $session -TimeoutSeconds $TimeoutSeconds
    $artifactId = $createResult.result.artifactId
    if ($artifactId -notmatch '^[0-9a-f-]{36}$') { throw '备份作业未返回有效制品 ID。' }
    $verify = Invoke-RestMethod -Uri "$baseUrl/backups/$artifactId/verify" -WebSession $session -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10
    [void](Wait-AutoWorkOperation -BaseUrl $baseUrl -OperationId $verify.data.operationId -Session $session -TimeoutSeconds $TimeoutSeconds)
    $backups = Invoke-RestMethod -Uri "$baseUrl/backups" -WebSession $session -Method Get -TimeoutSec 10
    $artifact = $backups.data | Where-Object { $_.id -eq $artifactId } | Select-Object -First 1
    if (-not $artifact -or $artifact.status -ne 'verified' -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$' -or $artifact.schemaChecksum -notmatch '^20[0-9]{12}_[a-z0-9_]+$') {
        throw '升级前备份没有完成隔离完整性校验。'
    }
    return $artifact
}

function Wait-AutoWorkOperation {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $operation = Invoke-RestMethod -Uri "$BaseUrl/operations/$OperationId" -WebSession $Session -Method Get -TimeoutSec 10
        if ($operation.data.status -eq 'succeeded') { return $operation.data }
        if ($operation.data.status -in @('failed', 'cancelled', 'unknown', 'dead_letter')) {
            throw "作业 $OperationId 失败：$($operation.data.error.code) $($operation.data.error.message)"
        }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "等待作业 $OperationId 超时。"
}
