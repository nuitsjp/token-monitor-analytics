param(
    [string]$ReportPath = '',
    [switch]$ReuseVerifiedTests
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'traceability-ids.ps1')
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

function Invoke-Captured([string]$filePath, [string[]]$arguments, [string]$workingDirectory = '') {
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    $exitCode = 1
    $stdout = ''
    $stderr = ''
    $locationPushed = $false
    $command = $filePath + ' ' + ($arguments -join ' ')
    try {
        if (-not [string]::IsNullOrWhiteSpace($workingDirectory)) {
            Push-Location -LiteralPath $workingDirectory
            $locationPushed = $true
        }
        # Keep stdout and stderr separate. The output is parsed when it is a
        # machine-readable test report and is printed on failure for diagnosis.
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $filePath @arguments 1> $stdoutPath 2> $stderrPath
            $exitCode = [int]$LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        $stdout = [IO.File]::ReadAllText($stdoutPath)
        $stderr = [IO.File]::ReadAllText($stderrPath)
    } catch {
        $stderr = ($_ | Out-String).Trim()
    } finally {
        if ($locationPushed) {
            Pop-Location
        }
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    return [PSCustomObject]@{
        Command = $command
        ExitCode = $exitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

function New-NotRunResult([string]$reason) {
    return [PSCustomObject]@{
        Command = $reason
        ExitCode = 1
        Stdout = ''
        Stderr = $reason
    }
}

function New-VerifiedResult([string]$reason) {
    return [PSCustomObject]@{
        Command = $reason
        ExitCode = 0
        Stdout = ''
        Stderr = ''
    }
}

function Write-InvocationDiagnostics([string]$name, $invocation) {
    if ($null -eq $invocation) {
        return
    }
    if ($invocation.ExitCode -eq 0 -and [string]::IsNullOrWhiteSpace([string]$invocation.Stderr)) {
        return
    }
    Write-Output ($name + ' command: ' + [string]$invocation.Command)
    Write-Output ($name + ' exit code: ' + [string]$invocation.ExitCode)
    if (-not [string]::IsNullOrWhiteSpace([string]$invocation.Stdout)) {
        Write-Output ($name + ' stdout:')
        Write-Output ([string]$invocation.Stdout)
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$invocation.Stderr)) {
        Write-Output ($name + ' stderr:')
        Write-Output ([string]$invocation.Stderr)
    }
}

function Get-CommandPath([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return ''
    }
    return [string]$command.Source
}

function Test-ReusedAutomaticEvidence([string]$source) {
    # verify runs all Go and Vitest tests, but its browser task intentionally
    # runs only the normal routing suite. Screenshot evidence remains a
    # separate manual/explicit acceptance item.
    return $source -match '(_test\.go$|\.test\.tsx$|frontend/e2e/window-routing\.spec\.ts$)'
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

function Convert-TestResultStatus([string]$value) {
    switch (([string]$value).ToLowerInvariant()) {
        { $_ -in @('pass', 'passed', 'expected', 'ok') } { return 'pass' }
        { $_ -in @('fail', 'failed', 'unexpected', 'flaky') } { return 'fail' }
        { $_ -in @('skip', 'skipped', 'pending', 'todo', 'disabled') } { return 'skip' }
        default { return '' }
    }
}

function Merge-TestResultStatus([hashtable]$statuses, [string]$id, [string]$status) {
    if ([string]::IsNullOrWhiteSpace($status)) {
        return
    }
    # A failed occurrence dominates a skipped or passed occurrence. This is
    # conservative when an identifier is used by more than one test/project.
    $priority = @{ pass = 1; skip = 2; fail = 3 }
    if (-not $statuses.ContainsKey($id) -or $priority[$status] -gt $priority[[string]$statuses[$id]]) {
        $null = $statuses[$id] = $status
    }
}

function Add-MachineTestResult([string]$testName, [string]$status, [string]$source, [string[]]$knownIds, [hashtable]$statuses, [ref]$errors) {
    $ids = @(Get-TraceabilityIds $testName)
    foreach ($id in $ids) {
        if ($id -notin $knownIds) {
            $location = if ([string]::IsNullOrWhiteSpace($source)) { 'test result' } else { $source }
            $errors.Value += $location + ': unknown traceability id in test result ' + $id
            continue
        }
        Merge-TestResultStatus $statuses $id $status
    }
}

function Read-GoTestResults([string]$output, [string[]]$knownIds, [hashtable]$statuses, [ref]$errors) {
    foreach ($line in ($output -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $event = $line | ConvertFrom-Json
        } catch {
            # go test -json can include a tool diagnostic line on failure.
            continue
        }
        $action = ([string](Get-ObjectProperty $event 'Action')).ToLowerInvariant()
        if ($action -notin @('pass', 'fail', 'skip')) {
            continue
        }
        $testName = [string](Get-ObjectProperty $event 'Test')
        if ([string]::IsNullOrWhiteSpace($testName)) {
            continue
        }
        Add-MachineTestResult $testName (Convert-TestResultStatus $action) ([string](Get-ObjectProperty $event 'Package')) $knownIds $statuses $errors
    }
}

function Convert-JsonDocument([string]$text, [string]$label, [ref]$errors) {
    if ([string]::IsNullOrWhiteSpace($text)) {
        $errors.Value += $label + ': result JSON was not produced'
        return $null
    }
    try {
        return $text | ConvertFrom-Json
    } catch {
        # npm may write a short informational line before a JSON reporter.
        $firstObject = $text.IndexOf('{')
        $lastObject = $text.LastIndexOf('}')
        if ($firstObject -ge 0 -and $lastObject -gt $firstObject) {
            try {
                return $text.Substring($firstObject, $lastObject - $firstObject + 1) | ConvertFrom-Json
            } catch {
                $null = $_
            }
        }
        $errors.Value += $label + ': invalid result JSON'
        return $null
    }
}

function Read-VitestResults([string]$jsonPath, [string[]]$knownIds, [hashtable]$statuses, [ref]$errors) {
    if (-not (Test-Path -LiteralPath $jsonPath -PathType Leaf)) {
        $errors.Value += 'vitest: result JSON was not produced'
        return
    }
    $document = Convert-JsonDocument (Read-Utf8 $jsonPath) 'vitest' $errors
    if ($null -eq $document) {
        return
    }
    foreach ($fileResult in @((Get-ObjectProperty $document 'testResults'))) {
        if ($null -eq $fileResult) {
            continue
        }
        $source = [string](Get-ObjectProperty $fileResult 'name')
        foreach ($assertion in @((Get-ObjectProperty $fileResult 'assertionResults'))) {
            if ($null -eq $assertion) {
                continue
            }
            $fullName = [string](Get-ObjectProperty $assertion 'fullName')
            if ([string]::IsNullOrWhiteSpace($fullName)) {
                $fullName = ((@((Get-ObjectProperty $assertion 'ancestorTitles')) + [string](Get-ObjectProperty $assertion 'title')) -join ' ')
            }
            Add-MachineTestResult $fullName (Convert-TestResultStatus ([string](Get-ObjectProperty $assertion 'status'))) $source $knownIds $statuses $errors
        }
    }
}

function Read-PlaywrightSuite($suite, [string[]]$ancestors, [string[]]$knownIds, [hashtable]$statuses, [ref]$errors) {
    $suiteTitle = [string](Get-ObjectProperty $suite 'title')
    $suiteNames = @($ancestors)
    if (-not [string]::IsNullOrWhiteSpace($suiteTitle)) {
        $suiteNames += $suiteTitle
    }
    $source = [string](Get-ObjectProperty $suite 'file')
    foreach ($spec in @((Get-ObjectProperty $suite 'specs'))) {
        if ($null -eq $spec) {
            continue
        }
        $specName = (@($suiteNames) + [string](Get-ObjectProperty $spec 'title')) -join ' '
        $tests = @((Get-ObjectProperty $spec 'tests'))
        if ($tests.Count -eq 0 -or ($tests.Count -eq 1 -and $null -eq $tests[0])) {
            $specStatus = Convert-TestResultStatus ([string](Get-ObjectProperty $spec 'status'))
            if ([string]::IsNullOrWhiteSpace($specStatus)) {
                $specOk = Get-ObjectProperty $spec 'ok'
                if ($specOk -is [bool]) {
                    $specStatus = if ($specOk) { 'pass' } else { 'fail' }
                }
            }
            Add-MachineTestResult $specName $specStatus $source $knownIds $statuses $errors
            continue
        }
        foreach ($test in $tests) {
            if ($null -eq $test) {
                continue
            }
            $status = Convert-TestResultStatus ([string](Get-ObjectProperty $test 'status'))
            if ([string]::IsNullOrWhiteSpace($status)) {
                $status = Convert-TestResultStatus ([string](Get-ObjectProperty $test 'outcome'))
            }
            Add-MachineTestResult $specName $status $source $knownIds $statuses $errors
        }
    }
    foreach ($child in @((Get-ObjectProperty $suite 'suites'))) {
        if ($null -eq $child) {
            continue
        }
        Read-PlaywrightSuite $child $suiteNames $knownIds $statuses $errors
    }
}

function Read-PlaywrightResults([string]$output, [string[]]$knownIds, [hashtable]$statuses, [ref]$errors) {
    $document = Convert-JsonDocument $output 'playwright' $errors
    if ($null -eq $document) {
        return
    }
    foreach ($suite in @((Get-ObjectProperty $document 'suites'))) {
        if ($null -eq $suite) {
            continue
        }
        Read-PlaywrightSuite $suite @() $knownIds $statuses $errors
    }
}

function Get-AutomaticEvidence([string[]]$ids, [ref]$errors) {
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
        $testNamePattern = '(?:t\.Run|(?:it|test|describe))\s*\(\s*["''](?<name>[^"'']*)["'']'
        foreach ($testMatch in [regex]::Matches($text, $testNamePattern)) {
            foreach ($testId in (Get-TraceabilityIds $testMatch.Groups['name'].Value)) {
                if ($testId -notin $ids) {
                    $errors.Value += (Get-RelativePath $file.FullName) + ': unknown traceability id in test name ' + $testId
                }
            }
        }
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
            $knownTraceabilityIds = @($knownIds + $knownKeys + $knownDesignKeys)
            foreach ($testId in (Get-TraceabilityIds $testName)) {
                if ($testId -notin $knownTraceabilityIds) {
                    $errors.Value += (Get-RelativePath $file.FullName) + ': unknown traceability id in evidence testName ' + $testId
                }
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
$requiredIds = @(Get-RequirementIds (Read-Utf8 $requirementsPath))
$screenKeys = @(
    'SCREEN-COMMON', 'SCREEN-T01', 'SCREEN-M00', 'SCREEN-M01', 'SCREEN-M02', 'SCREEN-M03',
    'SCREEN-M04', 'SCREEN-M05', 'SCREEN-M06', 'SCREEN-M07', 'SCREEN-M08',
    'SCREEN-M09', 'SCREEN-M10', 'SCREEN-M11'
)
$designKeys = @()
for ($section = 2; $section -le 9; $section++) {
    $designKeys += ('DESIGN-SYSTEM-{0:D2}' -f $section)
}

$powershellPath = Get-CommandPath 'powershell.exe'
$goPath = Get-CommandPath 'go.exe'
$npmPath = Get-CommandPath 'npm.cmd'
if (-not $npmPath) {
    $npmPath = Get-CommandPath 'npm.exe'
}
$requirementsScript = Join-Path $repositoryRoot 'scripts/check-requirements.ps1'
$screensScript = Join-Path $repositoryRoot 'scripts/check-screens.ps1'
$requirementsResult = New-NotRunResult 'requirements check was not run'
$screensResult = New-NotRunResult 'screens check was not run'
$goResult = New-NotRunResult 'go tests were not run'
$vitestResult = New-NotRunResult 'vitest was not run'
$playwrightResult = New-NotRunResult 'playwright was not run'
$fixtureResult = New-NotRunResult 'traceability fixture test was not run'
if ($powershellPath -and (Test-Path -LiteralPath $requirementsScript)) {
    $requirementsResult = Invoke-Captured $powershellPath @('-NoLogo', '-NoProfile', '-File', $requirementsScript) $repositoryRoot
    $screensResult = Invoke-Captured $powershellPath @('-NoLogo', '-NoProfile', '-File', $screensScript) $repositoryRoot
}

# Each runner writes a machine-readable report while its invocation output is
# retained separately. This lets an item pass when its own test passed even if
# an unrelated test failed, and leaves skipped tests as skip. Release
# verification reuses the already successful `verify` run instead of executing
# the same automated suites a second time.
$resultDirectory = ''
$vitestReportPath = ''
if ($ReuseVerifiedTests) {
    $goResult = New-VerifiedResult 'go tests passed during task verify'
    $vitestResult = New-VerifiedResult 'vitest passed during task verify'
    $playwrightResult = New-VerifiedResult 'playwright passed during task verify'
    $fixtureResult = New-VerifiedResult 'traceability tests passed during task verify'
} else {
    $resultDirectory = Join-Path ([IO.Path]::GetTempPath()) ('token-monitor-acceptance-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    $vitestReportPath = Join-Path $resultDirectory 'vitest.json'
    if ($goPath) {
        $goResult = Invoke-Captured $goPath @(
            'test', '-json', '-count=1', '.', './internal/desktop', './internal/domain', './internal/usecase',
            './internal/adapter/...', './tests/acceptance'
        ) $repositoryRoot
    }
    if ($npmPath) {
        $vitestResult = Invoke-Captured $npmPath @(
            '--silent', '--prefix', 'frontend', 'run', 'test', '--',
            '--reporter=json', ('--outputFile=' + $vitestReportPath)
        ) $repositoryRoot
        $playwrightResult = Invoke-Captured $npmPath @(
            '--silent', '--prefix', 'frontend', 'run', 'test:e2e', '--', '--reporter=json'
        ) $repositoryRoot
    }
    if ($goPath) {
        $fixtureResult = Invoke-Captured $goPath @('test', '-json', './tests/traceability', '-count=1') $repositoryRoot
    }
}

$requirementsExitCode = [int]$requirementsResult.ExitCode
$screensExitCode = [int]$screensResult.ExitCode
$goExitCode = [int]$goResult.ExitCode
$vitestExitCode = [int]$vitestResult.ExitCode
$playwrightExitCode = [int]$playwrightResult.ExitCode
$automatedExitCode = if ($goExitCode -eq 0 -and $vitestExitCode -eq 0 -and $playwrightExitCode -eq 0) { 0 } else { 1 }
$fixtureExitCode = [int]$fixtureResult.ExitCode

$traceabilityErrors = @()
$allEvidenceIds = @($requiredIds + $screenKeys + $designKeys | Sort-Object -Unique)
$automaticEvidence = Get-AutomaticEvidence $allEvidenceIds ([ref]$traceabilityErrors)
$automaticStatuses = @{}
if (-not $ReuseVerifiedTests) {
    Read-GoTestResults ([string]$goResult.Stdout) $allEvidenceIds $automaticStatuses ([ref]$traceabilityErrors)
    if ($vitestExitCode -eq 0 -or (Test-Path -LiteralPath $vitestReportPath -PathType Leaf)) {
        Read-VitestResults $vitestReportPath $allEvidenceIds $automaticStatuses ([ref]$traceabilityErrors)
    }
    Read-PlaywrightResults ([string]$playwrightResult.Stdout) $allEvidenceIds $automaticStatuses ([ref]$traceabilityErrors)
    Remove-Item -LiteralPath $resultDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
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
        if ($automaticStatuses.ContainsKey($id)) {
            # Use only the result for this identifier. A failed unrelated test
            # must not rewrite a passed item, and skip must never become pass.
            $result = [string]$automaticStatuses[$id]
        } elseif ($ReuseVerifiedTests -and (Test-ReusedAutomaticEvidence $evidencePath)) {
            # The release gate has already run verify successfully. Keep
            # screenshot-only specs pending because verify does not execute
            # the dedicated showcase-screenshot task.
            $result = 'pass'
        } else {
            # The source name exists, but no machine-readable runner result
            # matched it. This is an unexecuted/pending item, not evidence.
            $result = 'pending'
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
if ($goExitCode -ne 0) { $blockingReasons += 'go test failed or was not run' }
if ($vitestExitCode -ne 0) { $blockingReasons += 'vitest failed or was not run' }
if ($playwrightExitCode -ne 0) { $blockingReasons += 'playwright failed or was not run' }
if ($fixtureExitCode -ne 0) { $blockingReasons += 'traceability fixture test failed or was not run' }
if ($sp01Unavailable) { $blockingReasons += 'SP-01 evidence is incomplete' }
if ($items | Where-Object { $_.result -ne 'pass' }) { $blockingReasons += 'one or more traceability items are not passed' }
if ($traceabilityErrors.Count -gt 0) { $blockingReasons += 'manual evidence contains invalid entries' }

Write-InvocationDiagnostics 'requirements' $requirementsResult
Write-InvocationDiagnostics 'screens' $screensResult
Write-InvocationDiagnostics 'go' $goResult
Write-InvocationDiagnostics 'vitest' $vitestResult
Write-InvocationDiagnostics 'playwright' $playwrightResult
Write-InvocationDiagnostics 'traceability fixture' $fixtureResult
if ($traceabilityErrors.Count -gt 0) {
    Write-Output 'traceability errors:'
    foreach ($traceabilityError in $traceabilityErrors) {
        Write-Output ('- ' + $traceabilityError)
    }
}

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
    automatedTestsReused = [bool]$ReuseVerifiedTests
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
