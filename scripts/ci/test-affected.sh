#!/usr/bin/env bash
# One shard of the CI test job (TEST_SHARD), or the whole suite when unset.
#   server     @oa/server's suite
#   dashboard  @oa/dashboard's suite
#   rest       the root scripts suite and every other package
#   cpu        the server's wall-clock CPU budgets (alone on its runner, so
#              never under another suite's load)
# Pull requests run only the shard's share of the packages their diff can
# affect: pnpm's own `--filter ...[base]` (changed packages and their
# dependents; complete because every cross-package import is declared, which
# scripts/ci/workspace-imports.ts checks in the root suite). Every other event
# (the merge queue, main), a change pnpm can't place (root config, lockfile,
# workflows, ROOT_PATHS), and any error run the shard's share of everything.
#   GITHUB_EVENT_NAME, BASE_SHA (the pull request's base), TEST_SHARD.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
shard="${TEST_SHARD:-}"
case "$shard" in "" | server | dashboard | rest | cpu) ;; *)
  echo "unknown TEST_SHARD ${shard}" >&2
  exit 2
  ;;
esac

# The shard's share of everything.
everything() {
  echo "test scope: everything ($1)"
  case "$shard" in
    "") exec pnpm test ;;
    server | dashboard)
      pnpm run test:prep
      exec pnpm --filter "@oa/$shard" test
      ;;
    rest)
      pnpm run test:prep
      pnpm exec vitest run
      exec pnpm -r --if-present --filter '!@oa/server' --filter '!@oa/dashboard' test
      ;;
    cpu)
      pnpm run test:prep
      exec pnpm --filter @oa/server test:cpu
      ;;
  esac
}

# Is package $1 in this shard?
mine() {
  case "$shard" in
    "") return 0 ;;
    server | cpu) [ "$1" = @oa/server ] ;;
    dashboard) [ "$1" = @oa/dashboard ] ;;
    rest) [ "$1" != @oa/server ] && [ "$1" != @oa/dashboard ] ;;
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

filters=()
picked=()
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if mine "$p"; then
    picked+=("$p")
    filters+=(--filter "$p")
  fi
done <<< "$names"
echo "test scope${shard:+ ($shard)}: ${#picked[@]} affected package(s) of the diff from $BASE_SHA"
[ ${#picked[@]} -eq 0 ] || printf '  %s\n' "${picked[@]}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### test${shard:+ ($shard)}: affected packages only (pull request)"
    if [ ${#picked[@]} -eq 0 ]; then
      echo "None in this shard."
    else
      printf -- '- %s\n' "${picked[@]}"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

case "$shard" in "" | rest) run_root=true ;; *) run_root=false ;; esac
if [ "$run_root" = false ] && [ ${#picked[@]} -eq 0 ]; then exit 0; fi
pnpm run test:prep
if [ "$run_root" = true ]; then pnpm exec vitest run; fi
[ ${#picked[@]} -gt 0 ] || exit 0
if [ "$shard" = cpu ]; then
  exec pnpm --filter @oa/server test:cpu
fi
exec pnpm -r --if-present "${filters[@]}" test
