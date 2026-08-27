$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$versions = Get-Content -LiteralPath (Join-Path $repositoryRoot 'config/tool-versions.json') -Raw | ConvertFrom-Json

function Assert-CommandVersion {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $Expected,
        [Parameter(Mandatory)] [scriptblock] $VersionCommand
    )

    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command is not installed"
    }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $actual = (& $VersionCommand 2>&1 | Out-String).Trim()
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($actual -notmatch [regex]::Escape($Expected)) {
        throw "$Command version mismatch: expected $Expected, got $actual"
    }
}

function Assert-GoInstalledModuleVersion {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $Module,
        [Parameter(Mandatory)] [string] $Expected
    )
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if ($null -eq $resolved) { throw "$Command is not installed" }
    $metadata = (& go version -m $resolved.Source | Out-String)
    if ($metadata -notmatch ([regex]::Escape($Module) + '\s+v?' + [regex]::Escape($Expected))) {
        throw "$Command module version mismatch: expected $Module@$Expected"
    }
}

Assert-CommandVersion -Command 'go' -Expected "go$($versions.go)" -VersionCommand { go version }
Assert-CommandVersion -Command 'node' -Expected "v$($versions.node)" -VersionCommand { node --version }
Assert-CommandVersion -Command 'npm' -Expected $versions.npm -VersionCommand { npm --version }
Assert-CommandVersion -Command 'wails3' -Expected "v$($versions.wails)" -VersionCommand { wails3 version }
Assert-CommandVersion -Command 'sqlc' -Expected "v$($versions.sqlc)" -VersionCommand { sqlc version }
Assert-CommandVersion -Command 'staticcheck' -Expected $versions.staticcheck -VersionCommand { staticcheck -version }
Assert-CommandVersion -Command 'golangci-lint' -Expected $versions.'golangci-lint' -VersionCommand { golangci-lint version }
Assert-CommandVersion -Command 'govulncheck' -Expected $versions.govulncheck -VersionCommand { govulncheck -version }
Assert-GoInstalledModuleVersion -Command 'gosec' -Module 'github.com/securego/gosec/v2' -Expected $versions.gosec
Assert-GoInstalledModuleVersion -Command 'gitleaks' -Module 'github.com/zricethezav/gitleaks/v8' -Expected $versions.gitleaks
Assert-CommandVersion -Command 'actionlint' -Expected $versions.actionlint -VersionCommand { actionlint -version }
$zizmor = Get-Command 'zizmor' -ErrorAction SilentlyContinue
if ($null -eq $zizmor) {
    $userSite = (& python -m site --user-site | Out-String).Trim()
    $zizmorPath = Join-Path (Split-Path -Parent $userSite) 'Scripts/zizmor.exe'
    if (-not (Test-Path -LiteralPath $zizmorPath)) { throw 'zizmor is not installed' }
} else {
    $zizmorPath = $zizmor.Source
}
$zizmorVersion = (& $zizmorPath --version | Out-String).Trim()
if ($zizmorVersion -notmatch [regex]::Escape($versions.zizmor)) {
    throw "zizmor version mismatch: expected $($versions.zizmor), got $zizmorVersion"
}
Assert-CommandVersion -Command 'makensis' -Expected "v$($versions.makensis)" -VersionCommand { makensis /VERSION }

$analyzer = Get-Module -ListAvailable PSScriptAnalyzer |
    Where-Object { $_.Version.ToString() -eq $versions.PSScriptAnalyzer } |
    Select-Object -First 1
if ($null -eq $analyzer) {
    throw "PSScriptAnalyzer version mismatch or missing: expected $($versions.PSScriptAnalyzer)"
}

$sqliteVersion = go list -m -f '{{.Version}}' modernc.org/sqlite
if ($sqliteVersion -ne 'v1.57.0') {
    throw "modernc.org/sqlite version mismatch: $sqliteVersion"
}
$libcVersion = go list -m -f '{{.Version}}' modernc.org/libc
if ($libcVersion -ne 'v1.74.4') {
    throw "modernc.org/libc version mismatch: $libcVersion"
}

Write-Output 'Fixed tool versions verified.'
