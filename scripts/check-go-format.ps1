$ErrorActionPreference = 'Stop'
$files = @('main.go', 'startup.go', 'assets_development.go', 'assets_production.go')
$files += Get-ChildItem -Path 'internal' -Filter '*.go' -Recurse | ForEach-Object FullName
$unformatted = @()
foreach ($file in @($files | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })) {
    $unformatted += @(& gofmt -l $file)
    if ($LASTEXITCODE -ne 0) {
        throw "gofmt failed for $file"
    }
}
if ($unformatted) {
    throw "Go files require formatting:`n$($unformatted -join "`n")"
}
