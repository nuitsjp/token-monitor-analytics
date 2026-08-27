param(
    [string]$GitLogOptions = $env:GITLEAKS_LOG_OPTS
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

& govulncheck . ./internal/... ./tests/...
if ($LASTEXITCODE -ne 0) { throw 'govulncheck failed' }
& npm --prefix frontend audit --audit-level=high
if ($LASTEXITCODE -ne 0) { throw 'npm audit failed' }
& gosec -quiet -include=G110 -exclude-generated ./internal/adapter/backupzip
if ($LASTEXITCODE -ne 0) { throw 'gosec blocking rule G110 failed' }
if ([string]::IsNullOrWhiteSpace($GitLogOptions)) {
    & gitleaks git --redact --no-banner
} else {
    & gitleaks git --redact --no-banner --log-opts=$GitLogOptions
}
if ($LASTEXITCODE -ne 0) { throw 'gitleaks failed' }
Write-Output 'security:check passed'
