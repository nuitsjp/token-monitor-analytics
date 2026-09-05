#requires -Version 7.0
param([ValidateSet('amd64','arm64')][string]$Architecture='amd64')
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
 & mise run "package:ubuntu:$Architecture"
 if($LASTEXITCODE -ne 0){throw 'Ubuntu packaging failed.'}
} finally { Pop-Location }
