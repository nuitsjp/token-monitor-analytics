#requires -Version 7.0
param([int]$DisconnectAfter=0)
$ErrorActionPreference='Stop'
Push-Location "$(Split-Path $PSScriptRoot -Parent)/collector"
try { & go run ./cmd/mockhub -disconnect-after $DisconnectAfter; if($LASTEXITCODE -ne 0){throw 'Mock Hub failed.'} } finally { Pop-Location }
