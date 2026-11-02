#!/usr/bin/env bash
# Delete Worker secrets that are also staging vars (they break `wrangler deploy`). Run from apps/server.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
names=$(pnpm exec wrangler secret list -c wrangler.staging.jsonc --env staging --format json | node "$root/scripts/ops/conflicting-secrets.ts")
for name in $names; do
  echo "deleting conflicting secret: $name"
  # A here-string, not a pipe from echo: under pipefail a wrangler that exits
  # without reading stdin would fail the loop with echo's SIGPIPE (141).
  pnpm exec wrangler secret delete "$name" -c wrangler.staging.jsonc --env staging <<< y > /dev/null
done
