#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$root/collector" && go test -race ./... && go vet ./...)
(cd "$root/analytics" && npm test)
if [[ "${1:-}" == '--typecheck' ]]; then (cd "$root/analytics" && npm run typecheck); fi
