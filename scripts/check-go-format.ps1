$ErrorActionPreference = 'Stop'
$files = @('main.go', 'startup.go', 'assets_development.go', 'assets_production.go')
$files += Get-ChildItem -Path 'internal' -Filter '*.go' -Recurse | ForEach-Object FullName
$unformatted = $files | ForEach-Object { gofmt -l $_ } | Where-Object { $_ }
if ($unformatted) {
    throw "Go files require formatting:`n$($unformatted -join "`n")"
}
