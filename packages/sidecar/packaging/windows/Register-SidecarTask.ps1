<#
.SYNOPSIS
  Registers a Task Scheduler task that keeps the TS6 Manager media sidecar
  running in the background.

.DESCRIPTION
  The sidecar is a console program, not a Windows service, so Task Scheduler
  starts Start-Sidecar.ps1 for it. Run this from an elevated PowerShell in the
  folder that holds ts6-media-sidecar.exe, Start-Sidecar.ps1 and sidecar.env.

  -Trigger Logon (default) starts the sidecar when the named user signs in and
  runs it in that user's session, where GPU encoders are available.
  -Trigger Startup starts it at boot without anyone signed in; GPU encoders
  may be unavailable in that session, so run Check encoders afterwards.

  The script also restricts sidecar.env to the task's user, SYSTEM and
  Administrators. Remove the task with:
    Unregister-ScheduledTask -TaskName 'TS6 Media Sidecar' -Confirm:$false
#>
[CmdletBinding()]
param(
    [ValidateSet('Logon', 'Startup')]
    [string]$Trigger = 'Logon',
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [string]$TaskName = 'TS6 Media Sidecar',
    [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$startScript = Join-Path $InstallDir 'Start-Sidecar.ps1'
$envFile = Join-Path $InstallDir 'sidecar.env'
foreach ($path in @($startScript, $envFile, (Join-Path $InstallDir 'ts6-media-sidecar.exe'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing file: $path" }
}

# Only the task's account, SYSTEM and Administrators may read the secret.
& icacls.exe $envFile /inheritance:r /grant:r "${User}:(R)" 'SYSTEM:(F)' 'Administrators:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $envFile" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`"" `
    -WorkingDirectory $InstallDir

if ($Trigger -eq 'Startup') {
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
} else {
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $taskTrigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered and started '$TaskName' ($Trigger trigger, user $User)."
