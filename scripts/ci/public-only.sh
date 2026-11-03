#!/usr/bin/env bash
# Proves the public code installs, builds, typechecks and tests with NO private
# package present (#1056). It copies the repo to a temp dir, removes every path
# in scripts/ci/private-paths.txt, then runs:
#
#   install     pnpm install --no-frozen-lockfile (the lockfile shrinks)
#   build       pnpm -r --no-bail --if-present build (the root `build`, no bail)
#   typecheck   pnpm run typecheck
#   test-prep   pnpm run --if-present test:prep
#   test-root   pnpm exec vitest run
#   test-pkgs   pnpm -r --no-bail --if-present test
#
# Every step runs even after an earlier one fails, so one run lists every break
# (a failed install skips the rest: nothing after it can run). Exit 0 only when
# every step passed; a log with a vitest or pnpm failure summary fails its step
# even when the command said 0 (#1225).
#
# Env:
#   PUBLIC_ONLY_SRC    repo to copy (default: this script's repo)
#   PUBLIC_ONLY_LIST   private path list (default: <src>/scripts/ci/private-paths.txt)
#   PUBLIC_ONLY_DIR    work dir, must not exist yet (default: a new mktemp dir)
#   PUBLIC_ONLY_KEEP   1 keeps the work dir (default: removed on exit)
#   PUBLIC_ONLY_STEPS  steps to run, space separated (default: all, in order)
#   PUBLIC_ONLY_CONCURRENCY  pnpm -r workspace concurrency (default 2)
# Explicit checks, not set -e: a failed step is recorded, not fatal.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
src="${PUBLIC_ONLY_SRC:-$(cd "$here/../.." && pwd)}"
src="$(cd "$src" && pwd)" || { echo "public-only: no source repo at $src" >&2; exit 2; }
list="${PUBLIC_ONLY_LIST:-$src/scripts/ci/private-paths.txt}"
steps="${PUBLIC_ONLY_STEPS:-install build typecheck test-prep test-root test-pkgs}"
conc="${PUBLIC_ONLY_CONCURRENCY:-2}"

[ -f "$src/pnpm-workspace.yaml" ] || { echo "public-only: $src is not the workspace root" >&2; exit 2; }
[ -f "$list" ] || { echo "public-only: no private path list at $list" >&2; exit 2; }
[[ "$conc" =~ ^[1-9][0-9]*$ ]] || { echo "public-only: bad PUBLIC_ONLY_CONCURRENCY" >&2; exit 2; }
for s in $steps; do
  case "$s" in
    install | build | typecheck | test-prep | test-root | test-pkgs) ;;
    *) echo "public-only: unknown step $s" >&2; exit 2 ;;
  esac
done

# Reads the list: one safe relative path per line, never outside the copy.
paths=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  p="${line%%#*}"
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  [ -n "$p" ] || continue
  if ! [[ "$p" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] || [[ "/$p/" == */../* ]] || [[ "/$p/" == */./* ]]; then
    echo "public-only: $list:$n: unsafe path '$p'" >&2
    exit 2
  fi
  paths+=("${p%/}")
done < "$list"
[ "${#paths[@]}" -gt 0 ] || { echo "public-only: $list names no paths" >&2; exit 2; }

if [ -n "${PUBLIC_ONLY_DIR:-}" ]; then
  work="$PUBLIC_ONLY_DIR"
  [ ! -e "$work" ] || { echo "public-only: $work already exists" >&2; exit 2; }
  mkdir -p "$work" || exit 2
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/oa-public-only.XXXXXX")" || exit 2
fi
work="$(cd "$work" && pwd)" || exit 2
case "$work" in
  / | "$src" | "$src"/*) echo "public-only: work dir $work overlaps the source" >&2; exit 2 ;;
esac
logs="$work/.public-only-logs"
tree="$work/repo"
mkdir -p "$logs" "$tree" || exit 2
if [ "${PUBLIC_ONLY_KEEP:-}" != 1 ]; then
  trap 'rm -rf -- "$work"' EXIT
fi
echo "public-only: copying $src to $tree"

# Tracked and untracked-but-not-ignored files: the working tree as CI would see
# it, without node_modules or build output.
if ! git -C "$src" ls-files -z -co --exclude-standard |
  (cd "$src" && tar --null -T - -cf -) | (cd "$tree" && tar -xf -); then
  echo "public-only: copy failed" >&2
  exit 2
fi

removed=0
for p in "${paths[@]}"; do
  if [ -e "$tree/$p" ] || [ -L "$tree/$p" ]; then
    rm -rf -- "${tree:?}/$p" || { echo "public-only: could not remove $p" >&2; exit 2; }
    removed=$((removed + 1))
  else
    echo "public-only: not present, skipped: $p"
  fi
done
echo "public-only: removed $removed of ${#paths[@]} private paths"

# A fresh repo, so git-based tooling (version stamps, affected scoping) runs.
if ! (cd "$tree" && git init -q && git add -A &&
  git -c user.name=public-only -c user.email=public-only@invalid \
    -c commit.gpgsign=false commit -qm "public-only copy" --no-verify); then
  echo "public-only: git init of the copy failed" >&2
  exit 2
fi

# True if a log has a vitest or pnpm failure summary (#1225).
failed_in() {
  sed 's/\x1b\[[0-9;]*m//g' "$1" 2>/dev/null |
    grep -qE '^[[:space:]]*(Test Files|Tests)[[:space:]].*[0-9]+ failed|^[[:space:]]*[0-9]+ failed$|^[[:space:]]*[0-9]+ failed[[:space:]]|ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL'
}

run_step() { # name, then the command
  local name="$1" log="$logs/$1.log" code
  shift
  echo "public-only: [$name] $*"
  (cd "$tree" && "$@") > "$log" 2>&1
  code=$?
  if [ "$code" -eq 0 ] && failed_in "$log"; then code=90; fi
  results+=("$name=$code")
  if [ "$code" -ne 0 ]; then
    failed=1
    echo "public-only: [$name] FAILED exit=$code; last lines of $log:"
    tail -n 40 "$log" | sed 's/^/  | /'
  fi
  return "$code"
}

results=()
failed=0
for s in $steps; do
  case "$s" in
    install)
      if ! run_step install pnpm install --no-frozen-lockfile; then
        echo "public-only: install failed, skipping the remaining steps"
        break
      fi
      ;;
    build) run_step build pnpm -r --no-bail --if-present build ;;
    typecheck) run_step typecheck pnpm run typecheck ;;
    test-prep) run_step test-prep pnpm run --if-present test:prep ;;
    test-root) run_step test-root pnpm exec vitest run ;;
    test-pkgs) run_step test-pkgs pnpm -r --no-bail "--workspace-concurrency=$conc" --if-present test ;;
  esac
done

[ "${PUBLIC_ONLY_KEEP:-}" = 1 ] && echo "public-only: kept $work (logs in $logs)"
echo "public-only: ${results[*]:-no steps} (90: exit 0 but the log says failed)"
if [ "$failed" -ne 0 ]; then
  echo "public-only: exit=1"
  exit 1
fi
echo "public-only: exit=0"
exit 0
