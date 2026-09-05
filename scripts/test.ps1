#requires -Version 7.0
param([switch]$Typecheck)
$ErrorActionPreference='Stop'
# Compatibility switch: check now always includes type checking.
$Root=Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
 & mise run check
 if($LASTEXITCODE -ne 0){throw 'Checks failed. Run mise run setup first to install development tools.'}
} finally { Pop-Location }
