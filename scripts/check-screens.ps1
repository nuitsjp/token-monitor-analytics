$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
. (Join-Path $PSScriptRoot 'traceability-ids.ps1')
$requirements = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'docs/requirements.md'), $utf8)
[void](Get-RequirementIds $requirements)
$screenDesign = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'docs/screen-design.md'), $utf8)
$designSystem = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'docs/design-system.md'), $utf8)
$expected = [ordered]@{
    'SCREEN-COMMON' = @('3', '5', '8', '9')
    'SCREEN-T01' = @('4.1', '6')
    'SCREEN-M00' = @('4.2')
    'SCREEN-M01' = @('7.1')
    'SCREEN-M02' = @('7.2')
    'SCREEN-M03' = @('7.3')
    'SCREEN-M04' = @('7.4')
    'SCREEN-M05' = @('7.5')
    'SCREEN-M06' = @('7.6')
    'SCREEN-M07' = @('7.7')
    'SCREEN-M08' = @('7.8')
    'SCREEN-M09' = @('7.9')
    'SCREEN-M10' = @('7.10')
    'SCREEN-M11' = @('7.11')
}

function Test-Heading([string]$document, [string]$number) {
    return [regex]::IsMatch($document, "(?m)^#{1,6}\s+$([regex]::Escape($number))(?:\s|\.)")
}

foreach ($key in $expected.Keys) {
    foreach ($section in $expected[$key]) {
        if (-not (Test-Heading $screenDesign $section)) {
            throw "$key が参照する screen-design.md の見出し $section がありません。"
        }
    }
}

for ($section = 2; $section -le 9; $section++) {
    if (-not (Test-Heading $designSystem ([string]$section))) {
        throw "SCREEN-COMMON が参照する design-system.md の見出し $section がありません。"
    }
}

Write-Output "screens:check passed ($($expected.Count) keys)"
