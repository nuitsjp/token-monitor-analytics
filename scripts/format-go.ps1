$ErrorActionPreference = 'Stop'
$files = @('main.go', 'startup.go', 'assets_development.go', 'assets_production.go')
$files += Get-ChildItem -Path 'internal' -Filter '*.go' -Recurse | ForEach-Object FullName
gofmt -w $files
