#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux || "$EUID" == 0 ]]; then
  echo 'Run this entry point as an ordinary Ubuntu user.' >&2
  exit 1
fi
# Only the minimum needed to obtain mise belongs in this entry point.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v mise >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y curl ca-certificates
  fi
  tma_installer="$(mktemp)"
  trap 'rm -f "$tma_installer"' EXIT
  curl --fail --silent --show-error https://mise.run -o "$tma_installer"
  MISE_VERSION=v2026.9.1 MISE_INSTALL_HELP=0 sh "$tma_installer"
fi
cd "$root"
mise trust .mise.toml
mise install
exec mise run provision:ubuntu
