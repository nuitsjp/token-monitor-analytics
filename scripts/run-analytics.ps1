#requires -Version 7.0
param([switch]$Demo,[string]$Config,[string]$EnvFile)
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
if($Demo -and $Config){throw 'Use either -Demo or -Config.'}
if(-not $Config){$Config=if($Demo){"$Root/analytics/configs/demo.json"}else{"$Root/analytics/config.local.json"}}
$Config=(Resolve-Path $Config).Path
$NodeArgs=@('--experimental-strip-types')
if($EnvFile){$NodeArgs+="--env-file=$((Resolve-Path $EnvFile).Path)"}
$NodeArgs+=@("$Root/analytics/runtime/server.mjs",'--config',$Config)
& node @NodeArgs
if($LASTEXITCODE -ne 0){throw 'Analytics failed. Check its configuration, environment variables and port.'}
