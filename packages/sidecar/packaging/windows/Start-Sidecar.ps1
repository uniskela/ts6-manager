<#
.SYNOPSIS
  Runs the TS6 Manager media sidecar with the settings in sidecar.env.

.DESCRIPTION
  Reads KEY=value lines from sidecar.env (next to this script unless -EnvFile
  is given), sets them for this process only, and starts ts6-media-sidecar.exe.
  Values are never printed.
#>
[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot 'sidecar.env'),
    [string]$Binary = (Join-Path $PSScriptRoot 'ts6-media-sidecar.exe')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Settings file not found: $EnvFile (copy sidecar.env.example to sidecar.env and edit it)"
}
if (-not (Test-Path -LiteralPath $Binary)) {
    throw "Sidecar binary not found: $Binary"
}

foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $name, $value = $trimmed -split '=', 2
    if ($null -eq $value) { continue }
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
}

if (-not $env:SIDECAR_SECRET) {
    throw "SIDECAR_SECRET is MISSING in $EnvFile"
}

& $Binary
exit $LASTEXITCODE
