$ErrorActionPreference = 'Stop'
$files = @('main.go', 'startup.go', 'assets_development.go', 'assets_production.go')
$files += Get-ChildItem -Path 'internal' -Filter '*.go' -Recurse | ForEach-Object FullName
$existingFiles = @($files | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
& gofmt -w $existingFiles
if ($LASTEXITCODE -ne 0) {
    throw 'gofmt failed'
}
