$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

& git diff --check -- . ':!PLAN.md'
if ($LASTEXITCODE -ne 0) { throw 'git diff whitespace check failed' }
Write-Output 'diff:check passed (PLAN.md excluded)'
