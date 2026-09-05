#requires -Version 7.0
param([switch]$Demo)
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
$Config="$Root/collector/config.local.json"
if($Demo){
 $env:TMA_HUB_A_SECRET='demo-hub-secret'
 $env:TMA_INGEST_TOKEN='demo-ingest-token-not-for-production'
 $Config="$Root/collector/configs/collector.demo.json"
}
Push-Location "$Root/collector"
try { & go run ./cmd/collector -config $Config; if($LASTEXITCODE -ne 0){throw 'Collector failed; check logs and outbox.'} } finally { Pop-Location }
