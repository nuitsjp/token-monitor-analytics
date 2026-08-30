param(
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frontendRoot = Join-Path $repositoryRoot 'frontend'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $frontendRoot 'src'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$configuredOutputDirectory = $OutputDirectory
if ([string]::IsNullOrWhiteSpace($configuredOutputDirectory)) {
    $configuredOutputDirectory = [string]$env:FRONTEND_COVERAGE_OUTPUT_DIRECTORY
}

$cleanupCoverageDirectory = [string]::IsNullOrWhiteSpace($configuredOutputDirectory)
if ($cleanupCoverageDirectory) {
    $coverageDirectory = Join-Path $temporaryRoot ('token-monitor-frontend-coverage-' + [Guid]::NewGuid().ToString('N'))
} elseif ([IO.Path]::IsPathRooted($configuredOutputDirectory)) {
    $coverageDirectory = [IO.Path]::GetFullPath($configuredOutputDirectory)
} else {
    $coverageDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $configuredOutputDirectory))
}
$summaryPath = Join-Path $coverageDirectory 'coverage-summary.json'
$lcovPath = Join-Path $coverageDirectory 'lcov.info'
$diagnosticsPath = Join-Path $coverageDirectory 'coverage-diagnostics.txt'
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$thresholds = [ordered]@{
    lines = 68.0
    branches = 58.0
    functions = 57.0
    statements = 66.0
}

function Get-CoverageMetric([object]$record, [string]$name) {
    $property = $record.PSObject.Properties[$name]
    if ($null -eq $property -or $null -eq $property.Value) {
        throw "frontend coverage summary is missing the $name metric"
    }
    return [PSCustomObject]@{
        Total = [int]$property.Value.total
        Covered = [int]$property.Value.covered
        Percent = [double]$property.Value.pct
    }
}

function Resolve-SummaryPath([string]$path) {
    $normalizedPath = $path.Replace('/', [IO.Path]::DirectorySeparatorChar)
    if ([IO.Path]::IsPathRooted($normalizedPath)) {
        return [IO.Path]::GetFullPath($normalizedPath)
    }
    return [IO.Path]::GetFullPath((Join-Path $frontendRoot $normalizedPath))
}

function Get-SourceRelativePath([string]$path) {
    $resolvedPath = Resolve-SummaryPath $path
    $sourcePrefix = $sourceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "frontend coverage boundary includes a file outside frontend/src: $path"
    }
    return $resolvedPath.Substring($sourcePrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
}

function Assert-CoverageBoundaryContract {
    $configPath = Join-Path $frontendRoot 'vitest.config.ts'
    $config = [IO.File]::ReadAllText($configPath)
    $requiredConfigEntries = @(
        'include: ["src/**/*.{ts,tsx}"]',
        'exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/vite-env.d.ts"]'
    )
    foreach ($entry in $requiredConfigEntries) {
        if ($config.IndexOf($entry, [StringComparison]::Ordinal) -lt 0) {
            throw "frontend coverage boundary contract is missing: $entry"
        }
    }
}

try {
    Assert-CoverageBoundaryContract
    New-Item -ItemType Directory -Path $coverageDirectory -Force | Out-Null
    Push-Location -LiteralPath $frontendRoot
    try {
        & $npmPath exec -- vitest run --coverage --testTimeout=15000 --maxWorkers=1 "--coverage.reportsDirectory=$coverageDirectory"
        $vitestExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        throw "frontend coverage gate failed with exit code $vitestExitCode; coverage-summary.json was not produced"
    }
    if (-not (Test-Path -LiteralPath $lcovPath -PathType Leaf)) {
        throw "frontend coverage gate failed with exit code $vitestExitCode; lcov.info was not produced"
    }

    $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
    $total = $summary.PSObject.Properties['total']
    if ($null -eq $total) {
        throw 'frontend coverage summary is missing its total record'
    }
    $totalMetrics = @{}
    foreach ($metricName in $thresholds.Keys) {
        $totalMetrics[$metricName] = Get-CoverageMetric $total.Value $metricName
    }

    $fileRows = @()
    $areaStats = @{}
    foreach ($property in @($summary.PSObject.Properties | Where-Object { $_.Name -ne 'total' })) {
        $relativePath = Get-SourceRelativePath $property.Name
        if ($relativePath -match '(^|/)(?:[^/]+\.test\.(?:ts|tsx)|test/|vite-env\.d\.ts$)') {
            throw "frontend coverage boundary includes an excluded test or setup file: $relativePath"
        }
        $relativeParts = $relativePath -split '/'
        $area = if ($relativeParts.Count -gt 1) { $relativeParts[0] } else { 'root' }
        if (-not $areaStats.ContainsKey($area)) {
            $areaStats[$area] = [PSCustomObject]@{
                lines = [PSCustomObject]@{ Total = 0; Covered = 0 }
                branches = [PSCustomObject]@{ Total = 0; Covered = 0 }
                functions = [PSCustomObject]@{ Total = 0; Covered = 0 }
                statements = [PSCustomObject]@{ Total = 0; Covered = 0 }
            }
        }
        $fileMetrics = @{}
        foreach ($metricName in $thresholds.Keys) {
            $metric = Get-CoverageMetric $property.Value $metricName
            $fileMetrics[$metricName] = $metric
            $areaStats[$area].$metricName.Total += $metric.Total
            $areaStats[$area].$metricName.Covered += $metric.Covered
        }
        $fileRows += [PSCustomObject]@{
            Area = $area
            File = $relativePath
            Metrics = $fileMetrics
        }
    }
    if ($fileRows.Count -eq 0) {
        throw 'frontend coverage summary contains no measured source files'
    }

    $lcovFiles = @((Get-Content -LiteralPath $lcovPath | ForEach-Object {
            if ($_ -match '^SF:(.+)$') {
                $Matches[1]
            }
        }))
    if ($lcovFiles.Count -eq 0) {
        throw 'frontend lcov.info contains no source files'
    }
    foreach ($lcovFile in $lcovFiles) {
        [void](Get-SourceRelativePath $lcovFile)
    }

    $diagnostics = New-Object System.Collections.Generic.List[string]
    $diagnostics.Add('Frontend coverage boundary contract: PASS')
    $diagnostics.Add('  included: frontend/src/**/*.{ts,tsx}')
    $diagnostics.Add('  excluded: test files, frontend/src/test/**, frontend/src/vite-env.d.ts')
    $diagnostics.Add(('  measured files: {0}' -f $fileRows.Count))
    $diagnostics.Add(('  lcov source files: {0}' -f $lcovFiles.Count))
    $diagnostics.Add('Totals:')
    foreach ($metricName in $thresholds.Keys) {
        $metric = $totalMetrics[$metricName]
        $diagnostics.Add(('  {0}: {1:N1}% ({2:N1}% minimum)' -f $metricName, $metric.Percent, $thresholds[$metricName]))
    }
    $diagnostics.Add('Area diagnostics (files below any threshold):')
    foreach ($area in @($areaStats.Keys | Sort-Object)) {
        $stats = $areaStats[$area]
        $belowThreshold = $false
        $parts = @()
        foreach ($metricName in $thresholds.Keys) {
            $metricStats = $stats.$metricName
            $percent = if ($metricStats.Total -eq 0) { 100.0 } else { 100.0 * $metricStats.Covered / $metricStats.Total }
            if ($percent -lt $thresholds[$metricName]) {
                $belowThreshold = $true
            }
            $parts += ('{0}={1:N1}% ({2}/{3})' -f $metricName, $percent, $metricStats.Covered, $metricStats.Total)
        }
        if ($belowThreshold) {
            $diagnostics.Add(('  [{0}] {1}' -f $area, ($parts -join ', ')))
        }
    }
    $diagnostics.Add('File diagnostics (files below any threshold):')
    $belowFiles = @($fileRows | Where-Object {
            $row = $_
            @($thresholds.Keys | Where-Object { $row.Metrics[$_].Percent -lt $thresholds[$_] }).Count -gt 0
        } | Sort-Object Area, File)
    if ($belowFiles.Count -eq 0) {
        $diagnostics.Add('  none')
    } else {
        foreach ($row in $belowFiles) {
            $parts = @()
            foreach ($metricName in $thresholds.Keys) {
                $parts += ('{0}={1:N1}%' -f $metricName, $row.Metrics[$metricName].Percent)
            }
            $diagnostics.Add(('  [{0}] {1}: {2}' -f $row.Area, $row.File, ($parts -join ', ')))
        }
    }
    $diagnostics | Set-Content -LiteralPath $diagnosticsPath -Encoding UTF8

    Write-Output ('Frontend coverage: lines {0:N1}%, branches {1:N1}%, functions {2:N1}%, statements {3:N1}%' -f $totalMetrics.lines.Percent, $totalMetrics.branches.Percent, $totalMetrics.functions.Percent, $totalMetrics.statements.Percent)
    Write-Output "Frontend coverage reports: $summaryPath, $lcovPath, $diagnosticsPath"
    if ($vitestExitCode -ne 0) {
        throw "frontend coverage gate failed with exit code $vitestExitCode"
    }
    foreach ($metricName in $thresholds.Keys) {
        if ($totalMetrics[$metricName].Percent -lt $thresholds[$metricName]) {
            throw ('frontend {0} coverage {1:N1}% is below {2:N1}%' -f $metricName, $totalMetrics[$metricName].Percent, $thresholds[$metricName])
        }
    }
} finally {
    if ($cleanupCoverageDirectory -and (Test-Path -LiteralPath $coverageDirectory)) {
        $resolvedCoverageDirectory = [IO.Path]::GetFullPath($coverageDirectory)
        if ($resolvedCoverageDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedCoverageDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
