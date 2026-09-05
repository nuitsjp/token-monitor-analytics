#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--typecheck' ) ]]; then
  echo 'Usage: test.sh [--typecheck] (type checking is always included)' >&2
  exit 2
fi
cd "$root"
exec mise run check
