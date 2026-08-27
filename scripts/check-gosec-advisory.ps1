$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$report = Join-Path $repositoryRoot 'artifacts/gosec-report.json'
& gosec -fmt=json "-out=$report" -exclude-generated -exclude-dir=poc -exclude-dir=frontend ./...
$exitCode = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $report)) { throw 'gosec did not produce an advisory report' }
Write-Output "gosec advisory completed with exit code $exitCode; report=$report"
