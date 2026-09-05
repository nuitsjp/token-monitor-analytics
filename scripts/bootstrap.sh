#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--dev-tools' ) ]]; then
  echo 'Usage: bootstrap.sh [--dev-tools] (development tools are always installed)' >&2
  exit 2
fi
if ! command -v mise >/dev/null 2>&1; then
  echo 'Install mise and add it to PATH; see README.md.' >&2
  exit 1
fi
cd "$root"
mise install
mise run setup
