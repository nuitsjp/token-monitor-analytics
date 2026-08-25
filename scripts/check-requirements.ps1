$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$requirementsPath = Join-Path $repositoryRoot 'docs/requirements.md'
$planPath = Join-Path $repositoryRoot 'PLAN.md'
$idPattern = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[0-9]{2}'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-Ids([string]$text) {
    $ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($match in [regex]::Matches($text, $idPattern)) {
        [void]$ids.Add($match.Value)
    }
    Write-Output -NoEnumerate $ids
}

function Add-ExpandedIds([System.Collections.Generic.HashSet[string]]$target, [string]$text) {
    foreach ($id in (Get-Ids $text)) {
        [void]$target.Add($id)
    }
    $rangePattern = "(?<start>$idPattern)\s+から\s+(?<end>$idPattern)"
    foreach ($range in [regex]::Matches($text, $rangePattern)) {
        $start = $range.Groups['start'].Value
        $end = $range.Groups['end'].Value
        $startMatch = [regex]::Match($start, '^(?<prefix>.+-)(?<number>[0-9]{2})$')
        $endMatch = [regex]::Match($end, '^(?<prefix>.+-)(?<number>[0-9]{2})$')
        if ($startMatch.Groups['prefix'].Value -ne $endMatch.Groups['prefix'].Value) {
            throw "要件ID範囲の接頭辞が一致しません: $start から $end"
        }
        $first = [int]$startMatch.Groups['number'].Value
        $last = [int]$endMatch.Groups['number'].Value
        if ($first -gt $last) {
            throw "要件ID範囲が逆順です: $start から $end"
        }
        for ($number = $first; $number -le $last; $number++) {
            [void]$target.Add(('{0}{1:D2}' -f $startMatch.Groups['prefix'].Value, $number))
        }
    }
}

$requirements = [IO.File]::ReadAllText($requirementsPath, $utf8)
$requiredIds = Get-Ids $requirements
foreach ($id in @($requiredIds)) {
    if ($id.StartsWith('P2-', [System.StringComparison]::Ordinal) -or $id.Contains('-P2-')) {
        [void]$requiredIds.Remove($id)
    }
}

$plan = [IO.File]::ReadAllText($planPath, $utf8)
$mappingStart = $plan.IndexOf('### 4.10 ')
$mappingEnd = $plan.IndexOf('## 5.', $mappingStart)
if ($mappingStart -lt 0 -or $mappingEnd -lt 0) {
    throw 'PLAN.md の 4.10 対応表を特定できません。'
}
$mapping = $plan.Substring($mappingStart, $mappingEnd - $mappingStart)
$assignedIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

foreach ($line in ($mapping -split "`r?`n")) {
    if ($line -match '^\|\s*T-[0-9]{3}\s*\|(?<requirements>.+)\|\s*$') {
        Add-ExpandedIds $assignedIds $Matches['requirements']
        continue
    }
    if ($line -match '^\|\s*(?<acceptance>AC-P1-[0-9]{2}(?:\s+から\s+AC-P1-[0-9]{2})?)\s*\|\s*(?<tasks>.+?)\s*\|\s*$') {
        $acceptance = $Matches['acceptance']
        $ownerText = [string]$Matches['tasks']
        if (-not [regex]::IsMatch($ownerText, 'T-[0-9]{3}')) {
            throw "$acceptance に担当タスクがありません。"
        }
        Add-ExpandedIds $assignedIds $acceptance
    }
}

$missing = @($requiredIds | Where-Object { -not $assignedIds.Contains($_) } | Sort-Object)
$unknown = @($assignedIds | Where-Object { -not $requiredIds.Contains($_) } | Sort-Object)
if ($missing.Count -gt 0 -or $unknown.Count -gt 0) {
    $messages = @()
    if ($missing.Count -gt 0) { $messages += "未割当: $($missing -join ', ')" }
    if ($unknown.Count -gt 0) { $messages += "要件定義に存在しない割当: $($unknown -join ', ')" }
    throw ($messages -join [Environment]::NewLine)
}

Write-Output "requirements:check passed ($($requiredIds.Count) IDs)"
