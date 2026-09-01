$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executablePath = Join-Path $repositoryRoot 'bin\token-monitor-analytics.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Application executable is missing: $executablePath"
}

$applicationProcess = Start-Process -FilePath $executablePath -WorkingDirectory $repositoryRoot -PassThru
try {
    Wait-Process -Id $applicationProcess.Id
    $applicationProcess.Refresh()
    if ($applicationProcess.ExitCode -ne 0) {
        exit $applicationProcess.ExitCode
    }
} finally {
    $applicationProcess.Refresh()
    if (-not $applicationProcess.HasExited) {
        Stop-Process -Id $applicationProcess.Id -Force
        Wait-Process -Id $applicationProcess.Id -ErrorAction SilentlyContinue
    }
}
