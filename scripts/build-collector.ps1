#requires -Version 7.0
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force "$Root/bin" | Out-Null
$OldOS=$env:GOOS; $OldArch=$env:GOARCH; $OldCGO=$env:CGO_ENABLED
Push-Location "$Root/collector"
try {
 $env:CGO_ENABLED='0'
 foreach($Target in @(@('windows','amd64','tma-collector-windows-amd64.exe'),@('linux','amd64','tma-collector-linux-amd64'),@('linux','arm64','tma-collector-linux-arm64'))){
  $env:GOOS=$Target[0]; $env:GOARCH=$Target[1]
  & go build -trimpath -ldflags='-s -w' -o "$Root/bin/$($Target[2])" ./cmd/collector
  if($LASTEXITCODE -ne 0){throw "Build failed: $Target"}
 }
} finally { $env:GOOS=$OldOS; $env:GOARCH=$OldArch; $env:CGO_ENABLED=$OldCGO; Pop-Location }
Write-Host 'Built Windows amd64, Linux amd64, Linux arm64. Choose the Ubuntu architecture with uname -m.'
