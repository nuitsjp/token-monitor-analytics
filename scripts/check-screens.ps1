$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$plan = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'PLAN.md'), $utf8)
$screenDesign = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'docs/screen-design.md'), $utf8)
$designSystem = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'docs/design-system.md'), $utf8)
$expected = @(
    'SCREEN-COMMON', 'SCREEN-T01', 'SCREEN-M00', 'SCREEN-M01', 'SCREEN-M02', 'SCREEN-M03',
    'SCREEN-M04', 'SCREEN-M05', 'SCREEN-M06', 'SCREEN-M07', 'SCREEN-M08',
    'SCREEN-M09', 'SCREEN-M10', 'SCREEN-M11'
)

function Test-Heading([string]$document, [string]$number) {
    return [regex]::IsMatch($document, "(?m)^#{1,6}\s+$([regex]::Escape($number))(?:\s|\.)")
}

$rows = @{}
foreach ($line in ($plan -split "`r?`n")) {
    if ($line -match '^\|\s*(?<key>SCREEN-[A-Z0-9]+)\s*\|\s*(?<scope>.+?)\s*\|\s*(?<tasks>.+?)\s*\|\s*$') {
        $key = $Matches['key']
        if ($rows.ContainsKey($key)) { throw "画面受入キーが重複しています: $key" }
        if (-not [regex]::IsMatch([string]$Matches['tasks'], 'T-[0-9]{3}')) { throw "$key に担当タスクがありません。" }
        $rows[$key] = @{ Scope = $Matches['scope']; Tasks = $Matches['tasks'] }
    }
}

$actual = @($rows.Keys | Sort-Object)
$missing = @($expected | Where-Object { -not $rows.ContainsKey($_) })
$unknown = @($actual | Where-Object { $_ -notin $expected })
if ($missing.Count -gt 0 -or $unknown.Count -gt 0) {
    throw "画面受入キーが不正です。未割当=[$($missing -join ', ')] 未定義=[$($unknown -join ', ')]"
}

foreach ($key in $expected) {
    $scope = [string]$rows[$key].Scope
    $screenScope = ($scope -split 'および')[0]
    foreach ($match in [regex]::Matches($screenScope, '[0-9]+(?:\.[0-9]+)?')) {
        if (-not (Test-Heading $screenDesign $match.Value)) {
            throw "$key が参照する screen-design.md の見出し $($match.Value) がありません。"
        }
    }
}

for ($section = 2; $section -le 9; $section++) {
    if (-not (Test-Heading $designSystem ([string]$section))) {
        throw "SCREEN-COMMON が参照する design-system.md の見出し $section がありません。"
    }
}

Write-Output "screens:check passed ($($expected.Count) keys)"
