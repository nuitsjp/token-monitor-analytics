#requires -Version 7.0
param([ValidateSet('amd64','arm64')][string]$Architecture='amd64')
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
& "$PSScriptRoot/build-collector.ps1"
# Explicit allowlist: never copy local config, data, env files or node_modules.
$Stage=Join-Path ([System.IO.Path]::GetTempPath()) ('tma-package-'+[guid]::NewGuid())
New-Item -ItemType Directory -Force "$Stage/analytics","$Root/dist" | Out-Null
try {
 foreach($Dir in @('src','runtime','public','migrations','configs')){Copy-Item "$Root/analytics/$Dir" "$Stage/analytics/$Dir" -Recurse}
 Copy-Item "$Root/analytics/package.json" "$Stage/analytics/package.json"
 Copy-Item "$Root/deploy" "$Stage/deploy" -Recurse
 Copy-Item "$Root/docs" "$Stage/docs" -Recurse
 Copy-Item "$Root/README.md" "$Stage/README.md"
 Copy-Item "$Root/bin/tma-collector-linux-$Architecture" "$Stage/tma-collector"
 $Archive="$Root/dist/tma-ubuntu-$Architecture.tar.gz"
 & tar -czf $Archive -C $Stage .
 if($LASTEXITCODE -ne 0){throw 'tar failed.'}
 Write-Host "Created $Archive. Install Node.js 24 LTS on Ubuntu; see docs/UBUNTU.md."
} finally { Remove-Item $Stage -Recurse -Force }
