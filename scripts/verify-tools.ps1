$ErrorActionPreference = 'Stop'

function Assert-CommandVersion {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $Expected,
        [Parameter(Mandatory)] [scriptblock] $VersionCommand
    )

    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command is not installed"
    }
    $actual = (& $VersionCommand | Out-String).Trim()
    if ($actual -notmatch [regex]::Escape($Expected)) {
        throw "$Command version mismatch: expected $Expected, got $actual"
    }
}

Assert-CommandVersion -Command 'go' -Expected 'go1.26.7' -VersionCommand { go version }
Assert-CommandVersion -Command 'node' -Expected 'v24.19.0' -VersionCommand { node --version }
Assert-CommandVersion -Command 'wails3' -Expected 'v3.0.0-beta.12' -VersionCommand { wails3 version }
Assert-CommandVersion -Command 'sqlc' -Expected 'v1.31.1' -VersionCommand { sqlc version }
Assert-CommandVersion -Command 'staticcheck' -Expected '0.8.1' -VersionCommand { staticcheck -version }
Assert-CommandVersion -Command 'makensis' -Expected 'v3.12' -VersionCommand { makensis /VERSION }

$sqliteVersion = go list -m -f '{{.Version}}' modernc.org/sqlite
if ($sqliteVersion -ne 'v1.57.0') {
    throw "modernc.org/sqlite version mismatch: $sqliteVersion"
}
$libcVersion = go list -m -f '{{.Version}}' modernc.org/libc
if ($libcVersion -ne 'v1.74.4') {
    throw "modernc.org/libc version mismatch: $libcVersion"
}

Write-Output 'Fixed tool versions verified.'
