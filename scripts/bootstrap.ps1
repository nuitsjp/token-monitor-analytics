#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
& go version
if ($LASTEXITCODE -ne 0) { throw 'Install a maintained Go release.' }
& node --version
if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 22.16+ (prefer a current LTS patch).' }
Push-Location "$Root/analytics"
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  & npm run db:local
  if ($LASTEXITCODE -ne 0) { throw 'Local migration failed.' }
} finally { Pop-Location }
Write-Host 'Ready. Commit analytics/package-lock.json. Run the 3 demo terminals in README.md.'
