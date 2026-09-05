#requires -Version 7.0
param([switch]$InstallDevTools)
$ErrorActionPreference='Stop'
# Compatibility switch: setup now always installs the locked development tools.
$Root=Split-Path $PSScriptRoot -Parent
if(-not (Get-Command mise -ErrorAction SilentlyContinue)){throw 'Install mise and add it to PATH; see README.md.'}
Push-Location $Root
try {
 & mise install
 if($LASTEXITCODE -ne 0){throw 'mise install failed. Review and trust .mise.toml as described in README.md.'}
 & mise run setup
 if($LASTEXITCODE -ne 0){throw 'mise setup failed.'}
} finally { Pop-Location }
