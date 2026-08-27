$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$requirementsPath = Join-Path $repositoryRoot 'docs/requirements.md'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

. (Join-Path $PSScriptRoot 'traceability-ids.ps1')

$requirements = [IO.File]::ReadAllText($requirementsPath, $utf8)
$requiredIds = @(Get-RequirementIds $requirements)

Write-Output "requirements:check passed ($($requiredIds.Count) IDs)"
