#requires -Version 7.0
param([switch]$InstallDevTools)
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
& go version
if($LASTEXITCODE -ne 0){throw 'Install Go for Collector development.'}
& node --experimental-strip-types "$Root/tools/check-runtime.mjs"
if($LASTEXITCODE -ne 0){throw 'Install Node.js 24 LTS (latest patch) and retry.'}
if($InstallDevTools){
 Push-Location "$Root/analytics"
 try { & npm ci; if($LASTEXITCODE -ne 0){throw 'npm ci failed.'} } finally { Pop-Location }
}
Write-Host 'Ready. No Cloudflare login, build, npm packages or DB server are needed to run the demo.'
Write-Host 'Run: scripts/run-mock.ps1, scripts/run-analytics.ps1 -Demo, scripts/run-collector.ps1 -Demo (3 terminals).'
