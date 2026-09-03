$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

function Get-FileSha256Hex([string]$Path) {
    $stream = $null
    $hash = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $hash = [System.Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($hash.ComputeHash($stream)) -replace '-', '')
    } finally {
        if ($null -ne $hash) {
            $hash.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('token-monitor-generation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    & sqlc compile
    if ($LASTEXITCODE -ne 0) { throw 'sqlc compile failed' }
    & sqlc vet
    if ($LASTEXITCODE -ne 0) { throw 'sqlc vet failed' }
    & sqlc diff
    if ($LASTEXITCODE -ne 0) { throw 'sqlc generated files differ' }

    $bindings = Join-Path $temporaryRoot 'bindings'
    & wails3 generate bindings -clean=true -ts -i -d $bindings
    if ($LASTEXITCODE -ne 0) { throw 'Wails binding generation failed' }
    $committed = Join-Path $repositoryRoot 'frontend/bindings'
    $committedHashes = @(Get-ChildItem -LiteralPath $committed -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($committed.Length).TrimStart('\', '/')
        "$relative`t$(Get-FileSha256Hex -Path $_.FullName)"
    })
    $generatedHashes = @(Get-ChildItem -LiteralPath $bindings -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($bindings.Length).TrimStart('\', '/')
        "$relative`t$(Get-FileSha256Hex -Path $_.FullName)"
    })
    $differences = @(Compare-Object $committedHashes $generatedHashes)
    if ($differences.Count -gt 0) {
        throw "Wails generated bindings differ:`n$($differences | Out-String)"
    }
    & go test ./internal/adapter/timezone -run TestGeneratedTimezoneDataMatchesFixedSources -count=1
    if ($LASTEXITCODE -ne 0) { throw 'timezone generated data differs' }
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
Write-Output 'generation:check passed without modifying tracked files'
