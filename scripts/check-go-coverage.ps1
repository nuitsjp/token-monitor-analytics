param(
    [double]$MinimumStatements = 71.0,
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$configuredOutputDirectory = $OutputDirectory
if ([string]::IsNullOrWhiteSpace($configuredOutputDirectory)) {
    $configuredOutputDirectory = [string]$env:GO_COVERAGE_OUTPUT_DIRECTORY
}

$cleanupCoverageDirectory = [string]::IsNullOrWhiteSpace($configuredOutputDirectory)
if ($cleanupCoverageDirectory) {
    $coverageDirectory = Join-Path $temporaryRoot ('token-monitor-go-coverage-' + [Guid]::NewGuid().ToString('N'))
} elseif ([IO.Path]::IsPathRooted($configuredOutputDirectory)) {
    $coverageDirectory = [IO.Path]::GetFullPath($configuredOutputDirectory)
} else {
    $coverageDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $configuredOutputDirectory))
}
$coverageProfile = Join-Path $coverageDirectory 'coverage.out'
$funcSummaryPath = Join-Path $coverageDirectory 'coverage.func.txt'
$diagnosticsPath = Join-Path $coverageDirectory 'coverage-diagnostics.txt'

function Resolve-CoveragePackage([string]$path, [string[]]$packages) {
    $normalizedPath = $path.Replace('\', '/')
    foreach ($package in @($packages | Sort-Object Length -Descending)) {
        if ($normalizedPath.StartsWith($package + '/', [StringComparison]::OrdinalIgnoreCase)) {
            return $package
        }
    }
    return ''
}

try {
    New-Item -ItemType Directory -Path $coverageDirectory -Force | Out-Null
    Push-Location -LiteralPath $repositoryRoot
    try {
        $coverPackages = @(& go list . ./internal/... | ForEach-Object { $_.Trim() } | Where-Object {
                $_ -and $_ -notmatch '/sqlcgen$'
            })
        if ($LASTEXITCODE -ne 0 -or $coverPackages.Count -eq 0) {
            throw 'failed to resolve Go coverage packages'
        }

        & go test -count=1 -covermode=atomic "-coverpkg=$($coverPackages -join ',')" "-coverprofile=$coverageProfile" . ./internal/... ./tests/acceptance
        if ($LASTEXITCODE -ne 0) {
            throw "Go coverage test failed with exit code $LASTEXITCODE"
        }
        if (-not (Test-Path -LiteralPath $coverageProfile -PathType Leaf)) {
            throw 'Go coverage test did not produce coverage.out'
        }

        $funcSummary = @(& go tool cover "-func=$coverageProfile")
        $funcExitCode = $LASTEXITCODE
        if ($funcExitCode -ne 0 -or $funcSummary.Count -eq 0) {
            throw 'failed to read Go coverage function summary'
        }
        $funcSummary | Set-Content -LiteralPath $funcSummaryPath -Encoding UTF8
        $coverageSummary = [string]($funcSummary | Select-Object -Last 1)
        if ($coverageSummary -notmatch '(?<percent>[0-9]+(?:\.[0-9]+)?)%\s*$') {
            throw 'failed to read Go coverage total'
        }
        $actual = [double]::Parse($Matches.percent, [Globalization.CultureInfo]::InvariantCulture)

        $profileLines = @(Get-Content -LiteralPath $coverageProfile)
        if ($profileLines.Count -lt 2 -or $profileLines[0] -ne 'mode: atomic') {
            throw 'Go coverage profile has an unexpected format'
        }
        $profileFiles = @{}
        foreach ($profileLine in @($profileLines | Select-Object -Skip 1 | Where-Object { $_.Trim() })) {
            if ($profileLine -notmatch '^(?<file>.+):\d+\.\d+,\d+\.\d+ \d+ \d+$') {
                throw "Go coverage profile has an invalid entry: $profileLine"
            }
            $profileFile = $Matches.file.Replace('\', '/')
            if ($profileFile -match '/sqlcgen(?:/|$)') {
                throw "Go coverage boundary includes generated sqlcgen code: $profileFile"
            }
            $package = Resolve-CoveragePackage $profileFile $coverPackages
            if ([string]::IsNullOrWhiteSpace($package)) {
                throw "Go coverage boundary includes an unexpected package: $profileFile"
            }
            $profileFiles[$profileFile] = $package
        }
        if ($profileFiles.Count -eq 0) {
            throw 'Go coverage profile contains no measured files'
        }
        $rootPackage = @($coverPackages | Where-Object { $_ -notmatch '/' } | Select-Object -First 1)
        if ($rootPackage.Count -ne 1) {
            throw 'Go coverage boundary did not resolve the root package'
        }
        $rootPackage = [string]$rootPackage[0]

        $functionRows = @()
        foreach ($summaryLine in @($funcSummary | Select-Object -Skip 1 | Where-Object { $_ -match '%\s*$' })) {
            if ($summaryLine -notmatch '^\s*(?<file>.+):\d+:\s+(?<function>.+?)\s+(?<percent>\d+(?:\.\d+)?)%\s*$') {
                continue
            }
            $functionFile = $Matches.file.Replace('\', '/')
            if (-not $profileFiles.ContainsKey($functionFile)) {
                continue
            }
            $package = [string]$profileFiles[$functionFile]
            if ($package -eq $rootPackage) {
                $area = 'root'
            } else {
                $area = $package.Substring(($rootPackage + '/').Length)
            }
            $functionRows += [PSCustomObject]@{
                Area = $area
                File = $functionFile
                Function = $Matches.function.Trim()
                Percent = [double]::Parse($Matches.percent, [Globalization.CultureInfo]::InvariantCulture)
            }
        }

        $diagnostics = New-Object System.Collections.Generic.List[string]
        $diagnostics.Add('Go coverage boundary contract: PASS')
        $diagnostics.Add(('  included packages: {0}' -f ($coverPackages -join ', ')))
        $diagnostics.Add('  excluded generated package suffix: /sqlcgen')
        $diagnostics.Add(('  measured files: {0}' -f $profileFiles.Count))
        $diagnostics.Add(('Go statement coverage: {0:N1}% (minimum {1:N1}%)' -f $actual, $MinimumStatements))
        $diagnostics.Add('File/area diagnostics (functions below 100%):')
        $uncoveredFunctions = @($functionRows | Where-Object { $_.Percent -lt 100.0 } | Sort-Object Area, File, Function)
        if ($uncoveredFunctions.Count -eq 0) {
            $diagnostics.Add('  none')
        } else {
            foreach ($row in $uncoveredFunctions) {
                $diagnostics.Add(('  [{0}] {1} :: {2} ({3:N1}%)' -f $row.Area, $row.File, $row.Function, $row.Percent))
            }
        }
        $diagnostics | Set-Content -LiteralPath $diagnosticsPath -Encoding UTF8

        Write-Output ('Go statement coverage: {0:N1}% (minimum {1:N1}%)' -f $actual, $MinimumStatements)
        Write-Output "Go coverage reports: $coverageProfile, $funcSummaryPath, $diagnosticsPath"
        if ($actual -lt $MinimumStatements) {
            throw ('Go statement coverage {0:N1}% is below {1:N1}%' -f $actual, $MinimumStatements)
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($cleanupCoverageDirectory -and (Test-Path -LiteralPath $coverageDirectory)) {
        $resolvedCoverageDirectory = [IO.Path]::GetFullPath($coverageDirectory)
        if ($resolvedCoverageDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedCoverageDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
