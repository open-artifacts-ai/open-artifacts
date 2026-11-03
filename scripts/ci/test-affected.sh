#!/usr/bin/env bash
# One shard of the CI test suite (#965), chosen by TEST_SHARD:
#   server  the @oa/server suite
#   rest    the root scripts suite plus every other package
#   cpu     the server's wall-clock CPU budgets, alone on their runner
# Together they are `pnpm test` plus `test:cpu`. Pull requests run only the
# packages their diff can affect: pnpm's own `--filter ...[base]` (each changed
# package and its dependents). That graph is complete because every
# cross-package import is declared (scripts/ci/workspace-imports.ts check, in
# the root suite). Every other event (the merge queue, a dispatch), a change
# pnpm can't place (root config, lockfile, workflows, ROOT_PATHS), and any
# error run the whole shard. A missing or unknown shard is an error, never a
# pass.
#   GITHUB_EVENT_NAME, BASE_SHA (the pull request's base), TEST_SHARD.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
shard="${TEST_SHARD:-}"
case "$shard" in
  server | rest | cpu) ;;
  *)
    echo "TEST_SHARD must be server, rest or cpu (got '$shard')" >&2
    exit 2
    ;;
esac

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

# The whole shard.
everything() {
  echo "test scope: everything, shard $shard ($1)"
  summary "### test ($shard): everything ($1)"
  case "$shard" in
    server)
      pnpm run test:prep
      exec pnpm --filter @oa/server test
      ;;
    rest)
      pnpm run test:prep
      pnpm exec vitest run
      exec pnpm -r --if-present --filter '!@oa/server' test
      ;;
    cpu)
      pnpm run test:prep
      exec pnpm --filter @oa/server test:cpu
      ;;
  esac
}

[ "${GITHUB_EVENT_NAME:-}" = pull_request ] || everything "${GITHUB_EVENT_NAME:-no event}"
[ -n "${BASE_SHA:-}" ] || everything "no base sha"
# Any error is "everything", never "nothing".
if ! scope="$(node --experimental-strip-types --no-warnings "$root/scripts/ci/workspace-imports.ts" scope "$BASE_SHA")"; then
  everything "the scope check failed"
fi
if [ "$scope" != affected ]; then everything "a root config, lockfile, workflow or shared root path changed"; fi
if ! listed="$(pnpm --filter "...[$BASE_SHA]" ls --depth -1 --json)"; then
  everything "pnpm could not list the affected packages"
fi
if ! names="$(node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")||"[]");for(const p of a)console.log(p.name)' <<< "$listed")"; then
  everything "the affected list did not parse"
fi

server=false
others=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ "$p" = @oa/server ]; then server=true; else others=$((others + 1)); fi
done <<< "$names"
echo "test scope: shard $shard, affected package(s) of the diff from $BASE_SHA"
while IFS= read -r p; do [ -z "$p" ] || echo "  $p"; done <<< "$names"

case "$shard" in
  server | cpu)
    if [ "$server" != true ]; then
      echo "@oa/server is not affected: nothing to run in this shard"
      summary "### test ($shard): @oa/server not affected, nothing to run"
      exit 0
    fi
    summary "### test ($shard): @oa/server affected"
    pnpm run test:prep
    if [ "$shard" = server ]; then
      pnpm --filter @oa/server test
    else
      pnpm --filter @oa/server test:cpu
    fi
    ;;
  rest)
    summary "### test (rest): the root suite and $others other affected package(s)"
    pnpm run test:prep
    pnpm exec vitest run
    if [ "$others" -gt 0 ]; then
      pnpm -r --if-present --filter "...[$BASE_SHA]" --filter '!@oa/server' test
    fi
    ;;
esac
