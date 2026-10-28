#!/usr/bin/env bash
# The CI test job's suite. Pull requests run the root scripts suite plus only
# the packages their diff can affect: pnpm's own `--filter ...[base]` (each
# changed package and its dependents). That graph is complete because every
# cross-package import is declared (scripts/ci/workspace-imports.ts check, in
# the root suite). Every other event (the merge queue, main), a change pnpm
# can't place (root config, lockfile, workflows, ROOT_PATHS), and any error run
# everything (`pnpm test`).
#   GITHUB_EVENT_NAME, BASE_SHA (the pull request's base) from the job.
# Writes server=true|false to $GITHUB_OUTPUT (the server's CPU budgets step).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${GITHUB_OUTPUT:-/dev/null}"

everything() {
  echo "server=true" >> "$out"
  echo "test scope: everything ($1)"
  exec pnpm test
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
count=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  count=$((count + 1))
  if [ "$p" = @oa/server ]; then server=true; fi
done <<< "$names"
echo "server=$server" >> "$out"
echo "test scope: $count affected package(s) of the diff from $BASE_SHA"
while IFS= read -r p; do [ -z "$p" ] || echo "  $p"; done <<< "$names"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### test: affected packages only (pull request)"
    if [ "$count" -eq 0 ]; then
      echo "None: the root scripts suite only."
    else
      while IFS= read -r p; do [ -z "$p" ] || echo "- $p"; done <<< "$names"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

pnpm run test:prep
pnpm exec vitest run
if [ "$count" -gt 0 ]; then
  pnpm -r --if-present --filter "...[$BASE_SHA]" test
fi
