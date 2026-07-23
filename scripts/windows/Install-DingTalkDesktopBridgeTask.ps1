[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$BridgeRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path 'data\desktop-bridge'),
    [string]$TaskName = 'AutoWork-DingTalkDesktopBridge',
    [switch]$Uninstall,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($TaskName -notmatch '^[A-Za-z0-9._-]{1,120}$') {
    throw 'TaskName may contain only letters, numbers, dots, underscores, and hyphens.'
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Uninstall) {
    if (-not $existing) {
        Write-Host "Scheduled task '$TaskName' is not installed."
        return
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    }
    return
}

$bridgeScript = Join-Path $PSScriptRoot 'Start-DingTalkDesktopBridge.ps1'
if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    throw "Bridge script does not exist: $bridgeScript"
}

$BridgeRoot = [System.IO.Path]::GetFullPath($BridgeRoot)
New-Item -ItemType Directory -Force -Path $BridgeRoot | Out-Null
$powershellPath = Join-Path $PSHOME 'powershell.exe'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridgeScript`" -BridgeRoot `"$BridgeRoot`""
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory (Split-Path $bridgeScript -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if ($PSCmdlet.ShouldProcess($TaskName, "Install logon task for $bridgeScript")) {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Description 'Runs the local Auto Work DingTalk desktop bridge in the signed-in Windows session.' `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $TaskName
    }
    $task = Get-ScheduledTask -TaskName $TaskName
    [pscustomobject]@{
        TaskName = $TaskName
        State = $task.State
        User = $principal.UserId
        BridgeRoot = $BridgeRoot
        StartsAtLogon = $true
    }
}
