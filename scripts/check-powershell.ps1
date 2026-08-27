$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$versions = Get-Content -LiteralPath (Join-Path $repositoryRoot 'config/tool-versions.json') -Raw | ConvertFrom-Json
$module = Get-Module -ListAvailable PSScriptAnalyzer |
    Where-Object { $_.Version.ToString() -eq $versions.PSScriptAnalyzer } |
    Select-Object -First 1
if ($null -eq $module) {
    throw "PSScriptAnalyzer $($versions.PSScriptAnalyzer) is not installed"
}
Import-Module $module.Path -Force

$files = @(Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'scripts') -Filter '*.ps1' -File)
$rules = @(
    'PSAvoidUsingEmptyCatchBlock',
    'PSAvoidUsingInvokeExpression',
    'PSAvoidUsingPlainTextForPassword',
    'PSPossibleIncorrectComparisonWithNull',
    'PSUseDeclaredVarsMoreThanAssignments'
)
$errors = @()
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in @($parseErrors)) {
        $errors += "$($file.Name):$($parseError.Extent.StartLineNumber): PowerShell 5.1 parse error: $($parseError.Message)"
    }
    foreach ($result in @(Invoke-ScriptAnalyzer -Path $file.FullName -IncludeRule $rules -Severity Warning, Error)) {
        $errors += "$($file.Name):$($result.Line): $($result.RuleName): $($result.Message)"
    }
}
if ($errors.Count -gt 0) {
    throw ($errors -join [Environment]::NewLine)
}
Write-Output "powershell:check passed ($($files.Count) files)"
