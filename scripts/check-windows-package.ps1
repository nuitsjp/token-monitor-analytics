param(
    [ValidateSet('amd64', 'arm64')]
    [string]$Arch = 'amd64'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'Windows native package verification requires Windows'
}

foreach ($commandName in @('wails3.exe', 'makensis.exe')) {
    if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "$commandName is required for the local Windows package check"
    }
}

$binaryPath = Join-Path $repositoryRoot 'bin/token-monitor-analytics.exe'
$installerPath = Join-Path $repositoryRoot ("bin/token-monitor-analytics-{0}-installer.exe" -f $Arch)

function Assert-PortableExecutable([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "$label was not produced: $path"
    }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -le 0) {
        throw "$label is empty: $path"
    }
    $stream = [IO.File]::OpenRead($path)
    try {
        $header = New-Object byte[] 2
        if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or
            $header[0] -ne 0x4d -or $header[1] -ne 0x5a) {
            throw "$label is not a Windows PE file: $path"
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-SHA256([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

Assert-PortableExecutable $binaryPath 'Wails application binary'
Assert-PortableExecutable $installerPath 'NSIS installer'

$binary = Get-Item -LiteralPath $binaryPath
$installer = Get-Item -LiteralPath $installerPath
if ($installer.LastWriteTimeUtc -lt $binary.LastWriteTimeUtc) {
    throw "NSIS installer is older than the application binary: $installerPath"
}

Write-Output ('Wails binary: {0} ({1:N0} bytes, SHA-256 {2})' -f
    $binary.FullName, $binary.Length, (Get-SHA256 $binary.FullName))
Write-Output ('NSIS installer: {0} ({1:N0} bytes, SHA-256 {2})' -f
    $installer.FullName, $installer.Length, (Get-SHA256 $installer.FullName))
Write-Output ('local Windows package check passed: ' + $Arch)
