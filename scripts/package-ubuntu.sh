#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arch="${1:-amd64}"
case "$arch" in amd64|arm64) ;; *) echo 'Use amd64 or arm64' >&2; exit 1;; esac
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
mkdir -p "$root/dist" "$stage/analytics"
(cd "$root/collector" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$stage/tma-collector" ./cmd/collector)
for dir in src runtime public migrations configs; do cp -R "$root/analytics/$dir" "$stage/analytics/$dir"; done
cp "$root/analytics/package.json" "$stage/analytics/"
cp -R "$root/deploy" "$root/docs" "$stage/"
cp "$root/README.md" "$stage/"
tar -czf "$root/dist/tma-ubuntu-$arch.tar.gz" -C "$stage" .
echo "Created dist/tma-ubuntu-$arch.tar.gz (no local settings/secrets/data)."
