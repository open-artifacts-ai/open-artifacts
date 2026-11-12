#!/usr/bin/env bash
# PR check (#2258): a server migration that shipped in a release never changes.
# Installs record applied migrations by name, so an edit (even a comment) never
# reaches a deployed database and only breaks the deploy-time guard. Fails when
# a file under apps/server/migrations that exists in the newest release tag is
# modified, renamed or deleted in HEAD. New files are fine. Fails closed: no
# release tag or any git error fails the check.
# Newest release tag: the highest vX.Y.Z (no prerelease) merged into HEAD.
# Env: ROOT (repo to check, default this repo).
set -euo pipefail
root="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
dir='apps/server/migrations'
fail() { echo "::error title=Released migrations frozen::$1"; echo "$1" >&2; exit 1; }
g() { git -C "$root" "$@"; }

tags="$(g tag --merged HEAD --list 'v*')" || fail "could not list release tags"
tag="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 || true)"
[ -n "$tag" ] || fail "no release tag vX.Y.Z is merged into HEAD (is the checkout shallow? fetch tags); cannot tell which migrations shipped"

# --no-renames: a rename shows as a delete of the shipped name.
changed="$(g diff --name-only --no-renames --diff-filter=MD "$tag" HEAD -- "$dir/*.sql")" ||
  fail "could not compare $dir with $tag"
if [ -n "$changed" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "::error file=$f,title=Released migration changed::$f shipped in $tag; add a new migration instead"
    echo "$f shipped in $tag; add a new migration instead" >&2
  done <<< "$changed"
  exit 1
fi
echo "ok: no migration shipped in $tag was modified, renamed or deleted"
