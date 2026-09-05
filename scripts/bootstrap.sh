#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
go version
node --experimental-strip-types "$root/tools/check-runtime.mjs"
if [[ "${1:-}" == '--dev-tools' ]]; then (cd "$root/analytics" && npm ci); fi
printf 'Ready. See README.md for the three demo terminals.\n'
