#!/usr/bin/env bash
# Rewrite imports of the old provisioning contract (@oa/shared/provisioning,
# moved by #1056) to @oa/provisioning-contract, for a branch cut before the move.
#
#   @oa/shared/provisioning          -> @oa/provisioning-contract
#   @oa/shared/provisioning/<sub>    -> @oa/provisioning-contract/<sub>
#   @oa/shared/provisioning/mocks    -> @oa/provisioning-contract/mocks
#   packages/shared/src/provisioning -> packages/provisioning-contract/src
#   packages/shared/src/mocks/provisioning.ts
#                                    -> packages/provisioning-contract/src/mocks.ts
#
# Touches .ts, .tsx, .json and .mjs files under apps, packages, scripts and
# tests, skipping node_modules and dist. Idempotent: no rewritten text matches
# an old pattern, so a second run changes nothing. Adding @oa/provisioning-contract
# to a package's dependencies is still a manual step.
#
# Usage: scripts/codemod-provisioning-contract.sh [repo-root]   (default: this repo)
# Prints each file it changed.

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ ! -d "$root" ]]; then
  echo "codemod: no such directory: $root" >&2
  exit 64
fi
if ! command -v perl >/dev/null; then
  echo "codemod: perl is required" >&2
  exit 69
fi

# One pattern for grep (find candidates) and the same alternation in perl.
match='@oa/shared/provisioning|packages/shared/src/provisioning|packages/shared/src/mocks/provisioning\.ts'

dirs=()
for d in apps packages scripts tests; do
  [[ -d "$root/$d" ]] && dirs+=("$root/$d")
done
if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "codemod: none of apps, packages, scripts, tests under $root" >&2
  exit 66
fi

status=0
while IFS= read -r -d '' f; do
  grep -Eq "$match" "$f" || continue
  before=$(cksum <"$f")
  if ! perl -pi -e '
    s{packages/shared/src/mocks/provisioning\.ts}{packages/provisioning-contract/src/mocks.ts}g;
    s{packages/shared/src/provisioning(?![\w-])}{packages/provisioning-contract/src}g;
    s{\@oa/shared/provisioning(?![\w-])}{\@oa/provisioning-contract}g;
  ' "$f"; then
    echo "codemod: failed to rewrite $f" >&2
    status=1
    continue
  fi
  [[ "$(cksum <"$f")" != "$before" ]] && echo "${f#"$root"/}"
done < <(find "${dirs[@]}" \
  \( -name node_modules -o -name dist \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.mjs' \) \
  -print0)

exit "$status"
