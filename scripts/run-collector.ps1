#requires -Version 7.0
param([switch]$Demo,[string]$Config)
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
if($Demo -and $Config){throw 'Use either -Demo or -Config.'}
if(-not $Config){$Config=if($Demo){"$Root/collector/configs/collector.demo.json"}else{"$Root/collector/config.local.json"}}
$Config=(Resolve-Path $Config).Path
$OldHub=$env:TMA_HUB_A_SECRET; $OldIngest=$env:TMA_INGEST_TOKEN
if($Demo){$env:TMA_HUB_A_SECRET='demo-hub-secret';$env:TMA_INGEST_TOKEN='demo-ingest-token-not-for-production'}
Push-Location "$Root/collector"
try { & go run ./cmd/collector -config $Config; if($LASTEXITCODE -ne 0){throw 'Collector failed; check logs and outbox.'} }
finally { Pop-Location; if($Demo){$env:TMA_HUB_A_SECRET=$OldHub;$env:TMA_INGEST_TOKEN=$OldIngest} }
