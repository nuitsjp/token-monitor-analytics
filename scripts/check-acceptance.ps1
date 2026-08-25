param(
    [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $repositoryRoot 'docs/acceptance/report.json'
}
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$path) {
    return [IO.File]::ReadAllText($path, $utf8Strict)
}

function Get-RelativePath([string]$path) {
    $fullPath = [IO.Path]::GetFullPath($path)
    $root = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath.Substring($root.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
    }
    return $fullPath
}

function Resolve-RepositoryPath([string]$path) {
    if ([IO.Path]::IsPathRooted($path)) {
        return [IO.Path]::GetFullPath($path)
    }
    return [IO.Path]::GetFullPath((Join-Path $repositoryRoot $path))
}

function Test-RepositoryPath([string]$path) {
    $fullPath = [IO.Path]::GetFullPath($path)
    $root = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Quiet([string]$filePath, [string[]]$arguments) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Native tools commonly write warnings to stderr. Suppress them without
        # turning a warning stream record into a PowerShell terminating error.
        $ErrorActionPreference = 'Continue'
        & $filePath @arguments 1> $null 2> $null
        return [int]$LASTEXITCODE
    } catch {
        return 1
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Get-CommandPath([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return ''
    }
    return [string]$command.Source
}

function Get-ObjectProperty($object, [string]$name) {
    if ($null -eq $object) {
        return $null
    }
    $property = $object.PSObject.Properties[$name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-RequiredIds([string]$document) {
    # Keep this extraction contract aligned with check-requirements.ps1. The
    # phase gate excludes only P2 identifiers; API/DM/CALC and other Phase 1
    # namespaces remain in scope.
    $pattern = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[0-9]{2}'
    $ids = @()
    foreach ($match in [regex]::Matches($document, $pattern)) {
        $id = $match.Value
        if ($id.StartsWith('P2-', [System.StringComparison]::Ordinal) -or $id.Contains('-P2-')) {
            continue
        }
        $ids += $id
    }
    return @($ids | Sort-Object -Unique)
}

function Get-AutomaticEvidence([string[]]$ids) {
    $result = @{}
    $testFiles = @()
    $testFiles = @(Get-ChildItem -LiteralPath $repositoryRoot -Recurse -File | Where-Object {
        $isTestFile = $_.Name -like '*_test.go' -or $_.Name -like '*.test.tsx' -or $_.Name -like '*.spec.ts'
        $isExcluded = $_.FullName -like '*\.git\*' -or
            $_.FullName -like '*\frontend\node_modules\*' -or
            $_.FullName -like '*\frontend\bindings\*' -or
            $_.FullName -like '*\tests\traceability\*'
        $isTestFile -and -not $isExcluded
    })
    if ($testFiles.Count -eq 0) {
        return $result
    }
    foreach ($file in $testFiles) {
        $text = Read-Utf8 $file.FullName
        foreach ($id in $ids) {
            $pattern = '(?:t\.Run|(?:it|test|describe))\s*\(\s*["''](?<name>' + [regex]::Escape($id) + '(?![A-Z0-9])[^"'']*)["'']'
            $match = [regex]::Match($text, $pattern)
            if ($match.Success -and -not $result.ContainsKey($id)) {
                $result[$id] = [PSCustomObject]@{
                    Name = $match.Groups['name'].Value
                    Source = Get-RelativePath $file.FullName
                }
            }
        }
    }
    return $result
}

function Get-ManualEvidence([string[]]$knownIds, [string[]]$knownKeys, [string[]]$knownDesignKeys, [ref]$errors) {
    $result = @{}
    $evidenceRoot = Join-Path $repositoryRoot 'docs/acceptance/evidence'
    if (-not (Test-Path -LiteralPath $evidenceRoot)) {
        return $result
    }
    $files = @(Get-ChildItem -LiteralPath $evidenceRoot -Recurse -Filter '*.json' -File)
    foreach ($file in $files) {
        try {
            $parsed = Read-Utf8 $file.FullName | ConvertFrom-Json
        } catch {
            $errors.Value += (Get-RelativePath $file.FullName) + ': invalid evidence JSON'
            continue
        }
        $records = @($parsed)
        if ($parsed -is [Array]) {
            $records = @($parsed)
        }
        foreach ($record in $records) {
            $id = [string](Get-ObjectProperty $record 'id')
            $testName = [string](Get-ObjectProperty $record 'testName')
            $declaredResult = ([string](Get-ObjectProperty $record 'result')).ToLowerInvariant()
            $evidencePathValue = [string](Get-ObjectProperty $record 'evidencePath')
            $artifactPathValue = [string](Get-ObjectProperty $record 'artifactPath')
            if ([string]::IsNullOrWhiteSpace($id) -or ($id -notin $knownIds -and $id -notin $knownKeys -and $id -notin $knownDesignKeys)) {
                $errors.Value += (Get-RelativePath $file.FullName) + ': unknown or missing id'
                continue
            }
            $hasCompleteIDInTestName = -not [string]::IsNullOrWhiteSpace($testName) -and [regex]::IsMatch($testName, '(?<![A-Z0-9])' + [regex]::Escape($id) + '(?![A-Z0-9])')
            if (-not $hasCompleteIDInTestName -or $declaredResult -notin @('pass', 'pending', 'blocked', 'fail')) {
                $errors.Value += (Get-RelativePath $file.FullName) + ': testName/result is invalid'
                continue
            }
            if ($result.ContainsKey($id)) {
                $errors.Value += (Get-RelativePath $file.FullName) + ': duplicate id ' + $id
                continue
            }
            $evidenceExists = $false
            $relativeEvidencePath = ''
            if (-not [string]::IsNullOrWhiteSpace($evidencePathValue)) {
                $resolvedEvidencePath = Resolve-RepositoryPath $evidencePathValue
                if (Test-RepositoryPath $resolvedEvidencePath -and (Test-Path -LiteralPath $resolvedEvidencePath -PathType Leaf)) {
                    $evidenceExists = $true
                    $relativeEvidencePath = Get-RelativePath $resolvedEvidencePath
                }
            }
            $artifactSha256 = ''
            if (-not [string]::IsNullOrWhiteSpace($artifactPathValue)) {
                $resolvedArtifactPath = Resolve-RepositoryPath $artifactPathValue
                if (Test-RepositoryPath $resolvedArtifactPath -and (Test-Path -LiteralPath $resolvedArtifactPath -PathType Leaf)) {
                    try {
                        $artifactSha256 = (Get-FileHash -LiteralPath $resolvedArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
                    } catch {
                        $errors.Value += (Get-RelativePath $file.FullName) + ': artifact hash failed'
                    }
                }
            }
            $cleanWindows = [bool](Get-ObjectProperty $record 'cleanWindows')
            $result[$id] = [PSCustomObject]@{
                Name = $testName
                Result = $declaredResult
                EvidencePath = $relativeEvidencePath
                EvidenceExists = $evidenceExists
                ArtifactSha256 = $artifactSha256
                CleanWindows = $cleanWindows
            }
        }
    }
    return $result
}

$requirementsPath = Join-Path $repositoryRoot 'docs/requirements.md'
$designSystemPath = Join-Path $repositoryRoot 'docs/design-system.md'
$requiredIds = @(Get-RequiredIds (Read-Utf8 $requirementsPath))
$screenKeys = @(
    'SCREEN-COMMON', 'SCREEN-T01', 'SCREEN-M00', 'SCREEN-M01', 'SCREEN-M03',
    'SCREEN-M04', 'SCREEN-M05', 'SCREEN-M06', 'SCREEN-M07', 'SCREEN-M08',
    'SCREEN-M09', 'SCREEN-M10', 'SCREEN-M11'
)
$designKeys = @()
for ($section = 2; $section -le 9; $section++) {
    $designKeys += ('DESIGN-SYSTEM-{0:D2}' -f $section)
}

$powershellPath = Get-CommandPath 'powershell.exe'
$wailsPath = Get-CommandPath 'wails3.exe'
$goPath = Get-CommandPath 'go.exe'
$requirementsScript = Join-Path $repositoryRoot 'scripts/check-requirements.ps1'
$screensScript = Join-Path $repositoryRoot 'scripts/check-screens.ps1'
$requirementsExitCode = 1
$screensExitCode = 1
$automatedExitCode = 1
$fixtureExitCode = 1
if ($powershellPath -and (Test-Path -LiteralPath $requirementsScript)) {
    $requirementsExitCode = Invoke-Quiet $powershellPath @('-NoLogo', '-NoProfile', '-File', $requirementsScript)
    $screensExitCode = Invoke-Quiet $powershellPath @('-NoLogo', '-NoProfile', '-File', $screensScript)
}
if ($wailsPath) {
    $automatedExitCode = Invoke-Quiet $wailsPath @('task', 'test')
}
if ($goPath) {
    $fixtureExitCode = Invoke-Quiet $goPath @('test', './tests/traceability', '-count=1')
}

$allEvidenceIds = @($requiredIds + $screenKeys + $designKeys | Sort-Object -Unique)
$automaticEvidence = Get-AutomaticEvidence $allEvidenceIds
$traceabilityErrors = @()
$manualEvidence = Get-ManualEvidence $requiredIds $screenKeys $designKeys ([ref]$traceabilityErrors)
$designSystemDocument = Read-Utf8 $designSystemPath
for ($section = 2; $section -le 9; $section++) {
    if (-not [regex]::IsMatch($designSystemDocument, '(?m)^##\s+' + $section + '\.')) {
        $traceabilityErrors += 'design-system.md is missing section ' + $section
    }
}
$spikeResultsPath = Join-Path $repositoryRoot 'docs/spike-results.md'
$sp01Unavailable = $false
if (Test-Path -LiteralPath $spikeResultsPath) {
    $spikeResults = Read-Utf8 $spikeResultsPath
    $sp01Unavailable = $spikeResults -match '(?s)SP-01.*未完了'
}
$sp01BlockedIds = @('P1-HUB-06', 'P1-COL-03', 'P1-COL-07', 'P1-COL-08', 'AC-P1-05')
$cleanWindowsIds = @('AC-P1-02', 'AC-P1-25', 'AC-P1-26')
$cleanWindowsKeys = $screenKeys

$items = @()
function Add-TraceabilityItem([string]$id, [string]$kind) {
    $testName = ''
    $evidencePath = ''
    $artifactSha256 = ''
    $result = 'pending'
    if ($automaticEvidence.ContainsKey($id)) {
        $testName = [string]$automaticEvidence[$id].Name
        $evidencePath = [string]$automaticEvidence[$id].Source
        if ($automatedExitCode -eq 0 -and $fixtureExitCode -eq 0) {
            $result = 'pass'
        } else {
            $result = 'fail'
        }
    } elseif ($manualEvidence.ContainsKey($id)) {
        $manual = $manualEvidence[$id]
        $testName = [string]$manual.Name
        $evidencePath = [string]$manual.EvidencePath
        $artifactSha256 = [string]$manual.ArtifactSha256
        $result = [string]$manual.Result
        if ($result -eq 'pass' -and -not $manual.EvidenceExists) {
            $result = 'pending'
        }
        if ($result -eq 'pass' -and (($id -in $cleanWindowsIds -or $id -in $cleanWindowsKeys) -and -not $manual.CleanWindows)) {
            $result = 'blocked'
        }
    } elseif ($id -in $cleanWindowsIds -or $id -in $cleanWindowsKeys) {
        $result = 'blocked'
    } elseif ($sp01Unavailable -and $id -in $sp01BlockedIds) {
        $result = 'blocked'
    }
    $record = [ordered]@{
        id = $id
        testName = $testName
        result = $result
        evidencePath = $evidencePath
    }
    if (-not [string]::IsNullOrWhiteSpace($artifactSha256)) {
        $record['artifactSha256'] = $artifactSha256
    }
    $script:items += [PSCustomObject]$record
}

foreach ($id in $requiredIds) {
    Add-TraceabilityItem $id 'requirement'
}
foreach ($key in $screenKeys) {
    Add-TraceabilityItem $key 'screen'
}
foreach ($key in $designKeys) {
    Add-TraceabilityItem $key 'design-system'
}

$blockingReasons = @()
if ($requirementsExitCode -ne 0) { $blockingReasons += 'requirements:check failed' }
if ($screensExitCode -ne 0) { $blockingReasons += 'screens:check failed' }
if ($automatedExitCode -ne 0) { $blockingReasons += 'automated test suite failed or was not run' }
if ($fixtureExitCode -ne 0) { $blockingReasons += 'traceability fixture test failed or was not run' }
if ($sp01Unavailable) { $blockingReasons += 'SP-01 evidence is incomplete' }
if ($items | Where-Object { $_.result -ne 'pass' }) { $blockingReasons += 'one or more traceability items are not passed' }
if ($traceabilityErrors.Count -gt 0) { $blockingReasons += 'manual evidence contains invalid entries' }

$overallStatus = 'pass'
if ($blockingReasons.Count -gt 0) {
    $overallStatus = 'blocked'
}
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    status = $overallStatus
    checks = [ordered]@{
        requirements = if ($requirementsExitCode -eq 0) { 'pass' } else { 'fail' }
        screens = if ($screensExitCode -eq 0) { 'pass' } else { 'fail' }
        automatedTests = if ($automatedExitCode -eq 0) { 'pass' } else { 'fail' }
        traceabilityFixture = if ($fixtureExitCode -eq 0) { 'pass' } else { 'fail' }
        traceabilityInspection = if ($traceabilityErrors.Count -eq 0) { 'pass' } else { 'fail' }
    }
    blockingReasons = @($blockingReasons | Sort-Object -Unique)
    items = @($items)
}
$reportDirectory = Split-Path -Parent $ReportPath
if (-not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}
$json = $report | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($ReportPath, $json, $utf8NoBom)

Write-Output ('acceptance report: ' + (Get-RelativePath $ReportPath))
Write-Output ('acceptance status: ' + $overallStatus)
Write-Output ('acceptance items: ' + $items.Count)
if ($overallStatus -ne 'pass') {
    exit 1
}
exit 0
