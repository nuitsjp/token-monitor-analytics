#requires -Version 7.0
$ErrorActionPreference='Stop'; $Root=Split-Path $PSScriptRoot -Parent
Push-Location "$Root/collector"
try { & go test ./...; if($LASTEXITCODE -ne 0){throw 'Go tests failed.'}; & go vet ./...; if($LASTEXITCODE -ne 0){throw 'go vet failed.'} } finally { Pop-Location }
Push-Location "$Root/analytics"
try { & npm run typecheck; if($LASTEXITCODE -ne 0){throw 'Type checking failed.'}; & npm test; if($LASTEXITCODE -ne 0){throw 'Web tests failed.'} } finally { Pop-Location }
