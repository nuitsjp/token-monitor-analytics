#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="${1:-$root/analytics/config.local.json}"
if [[ "$config" == '--demo' ]]; then config="$root/analytics/configs/demo.json"; fi
exec node --experimental-strip-types "$root/analytics/runtime/server.mjs" --config "$config"
