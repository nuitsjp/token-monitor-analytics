# Shared traceability identifier rules. This file intentionally contains only
# function and pattern definitions so callers can dot-source it safely.

$script:RequirementIdPattern = '(?:API|DM|P[12]|QL)(?:-[A-Z0-9]+)*-[0-9]{2}|AC-P[12]-[0-9]{2}'
$script:TraceabilityIdPattern = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2}|SCREEN-[A-Z0-9]+|DESIGN-SYSTEM-[0-9]{2}'
$script:RequirementDeclarationPattern = '^\s*-\s+(?:\*\*)?`?\[(?<id>[^\]]+)\]`?(?:\*\*)?(?:\s|$)'

function Test-RequirementId([string]$id) {
    return [regex]::IsMatch($id, '^(?:' + $script:RequirementIdPattern + ')$')
}

function Get-RequirementIdPattern {
    return $script:RequirementIdPattern
}

function Get-TraceabilityIdPattern {
    return $script:TraceabilityIdPattern
}

function Get-RequirementDeclarationIds([string]$document) {
    $ids = @()
    $lineNumber = 0
    foreach ($line in ($document -split "`r?`n")) {
        $lineNumber++
        if ($line -notmatch $script:RequirementDeclarationPattern) {
            continue
        }
        $id = [string]$Matches['id']
        if (-not (Test-RequirementId $id)) {
            if ([regex]::IsMatch($id, '^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2}$')) {
                throw "Unknown requirement ID namespace at line ${lineNumber}: $id"
            }
            throw "Invalid requirement ID format at line ${lineNumber}: $id"
        }
        $ids += $id
    }
    return @($ids)
}

function Assert-RequirementDocument([string]$document) {
    $ids = @(Get-RequirementDeclarationIds $document)
    $declared = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($id in $ids) {
        if (-not $declared.Add($id)) {
            throw "Duplicate requirement declaration ID: $id"
        }
    }

    # Bracketed requirement references in declaration text must resolve to a
    # declaration. Plain words such as SHA-256 are deliberately not scanned.
    $referencePattern = '\[(?<id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{2})\]'
    foreach ($match in [regex]::Matches($document, $referencePattern)) {
        $id = $match.Groups['id'].Value
        if (-not $declared.Contains($id)) {
            throw "Requirement ID reference has no declaration: $id"
        }
    }
    return @($declared | Sort-Object)
}

function Get-RequirementIds([string]$document) {
    return @(Assert-RequirementDocument $document)
}

function Get-TraceabilityIds([string]$text) {
    $ids = @()
    foreach ($match in [regex]::Matches($text, '(?<![A-Z0-9])(?<id>(?:' + $script:TraceabilityIdPattern + '))(?![A-Z0-9])')) {
        $id = $match.Groups['id'].Value
        if ($id -notmatch '^SHA-[0-9]{2,3}$') {
            $ids += $id
        }
    }
    return @($ids | Sort-Object -Unique)
}
