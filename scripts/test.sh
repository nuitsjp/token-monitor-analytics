#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$root/collector" && go test -race ./... && go vet ./...)
(cd "$root/analytics" && npm run typecheck && npm test)
