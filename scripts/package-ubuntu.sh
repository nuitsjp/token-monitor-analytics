#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 1 ]]; then echo 'Usage: package-ubuntu.sh [amd64|arm64]' >&2; exit 2; fi
arch="${1:-amd64}"
case "$arch" in amd64|arm64) ;; *) echo 'Use amd64 or arm64' >&2; exit 2;; esac
cd "$root"
exec mise run "package:ubuntu:$arch"
