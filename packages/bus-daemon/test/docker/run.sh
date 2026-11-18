#!/usr/bin/env bash
# Runs bus vitest files inside a fresh, throwaway Linux container.
# Usage: run.sh [test-file ...]   (paths relative to packages/bus-daemon)
# Default: test/docker/two-hubs.smoke.test.ts
# The exit code is vitest's, so CI can call this script as is.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
image="oa-bus-docker-test:local"

if [ "$#" -eq 0 ]; then
  set -- test/docker/two-hubs.smoke.test.ts
fi

docker build -q -f "$here/Dockerfile" -t "$image" "$repo" >/dev/null

# No volume mounts and no host env: the container sees only its own image.
# --rm removes it afterwards.
exec docker run --rm \
  --name "oa-bus-test-$$" \
  -e OA_BUS_DOCKER=1 \
  "$image" \
  pnpm exec vitest run "$@"
