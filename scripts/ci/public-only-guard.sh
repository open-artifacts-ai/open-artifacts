#!/usr/bin/env bash
# Fails when a hosted path listed in scripts/ci/private-paths.txt is tracked in
# this repo. The hosted code moved out in #1056, so the public repo must never carry
# these paths again. Takes seconds; the `public-only` CI job runs it.
#
# A path counts as present when git tracks it or anything under it. Untracked
# or ignored leftovers on a developer machine (an old node_modules) do not.
#
# Exit 0: none present. Exit 1: names each path that is present. Exit 2: the
# list is unreadable, empty, or has an unsafe path, or the source is not a git
# work tree.
#
# Env:
#   PUBLIC_ONLY_SRC   repo to check (default: this script's repo)
#   PUBLIC_ONLY_LIST  path list (default: <src>/scripts/ci/private-paths.txt)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
src="${PUBLIC_ONLY_SRC:-$(cd "$here/../.." && pwd)}"
src="$(cd "$src" && pwd)" || { echo "public-only-guard: no source repo at $src" >&2; exit 2; }
list="${PUBLIC_ONLY_LIST:-$src/scripts/ci/private-paths.txt}"

[ -f "$list" ] && [ -r "$list" ] || { echo "public-only-guard: cannot read the path list at $list" >&2; exit 2; }

paths=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  p="${line%%#*}"
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  [ -n "$p" ] || continue
  if ! [[ "$p" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] || [[ "/$p/" == */../* ]] || [[ "/$p/" == */./* ]]; then
    echo "public-only-guard: $list:$n: unsafe path '$p'" >&2
    exit 2
  fi
  paths+=("${p%/}")
done < "$list"
[ "${#paths[@]}" -gt 0 ] || { echo "public-only-guard: $list names no paths" >&2; exit 2; }

git -C "$src" rev-parse --is-inside-work-tree > /dev/null 2>&1 \
  || { echo "public-only-guard: $src is not a git work tree" >&2; exit 2; }

bad=0
for p in "${paths[@]}"; do
  tracked="$(git -C "$src" ls-files -z -- "$p")" \
    || { echo "public-only-guard: git ls-files failed in $src" >&2; exit 2; }
  if [ -n "$tracked" ]; then
    echo "public-only-guard: hosted path present: $p" >&2
    bad=$((bad + 1))
  fi
done
if [ "$bad" -gt 0 ]; then
  echo "public-only-guard: $bad of ${#paths[@]} hosted paths present; they belong in open-artifacts-cloud" >&2
  exit 1
fi
echo "public-only-guard: ${#paths[@]} hosted paths listed, none present"
