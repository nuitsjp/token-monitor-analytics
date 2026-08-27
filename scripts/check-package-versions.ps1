$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'frontend/package.json') -Raw | ConvertFrom-Json
$errors = @()
foreach ($section in @('dependencies', 'devDependencies')) {
    foreach ($dependency in $package.$section.PSObject.Properties) {
        if ($dependency.Value -match '^[\^~]') {
            $errors += "$section.$($dependency.Name) must use an exact version: $($dependency.Value)"
        }
    }
}
if ($errors.Count -gt 0) { throw ($errors -join [Environment]::NewLine) }
Write-Output 'package-versions:check passed'
