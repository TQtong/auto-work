[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Invoke-DingTalkDesktopAutomation.psm1') -Force
Invoke-DingTalkDesktopAutomation -InputPath $InputPath -OutputPath $OutputPath
