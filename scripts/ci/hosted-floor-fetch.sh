#!/usr/bin/env bash
# The floor for hosted-publish.yml's publish-floor (design v7 6.4): the signed
# floor-<env>-<seq>.sig.json from a hosted-floor.yml run, refused unless that
# run is hosted-floor.yml, dispatched on main, completed with success. Writes
# it under <out dir> and prints its path. publish-floor verifies its signature
# against RELEASE_PUBKEY[env] itself; this only picks the right file.
# Needs GH_TOKEN (actions: read), GITHUB_REPOSITORY.
# Usage: scripts/ci/hosted-floor-fetch.sh staging|prod <run id> <out dir>
set -euo pipefail

[ "$#" -eq 3 ] || { echo "usage: $0 staging|prod <run id> <out dir>" >&2; exit 2; }
env="$1"
run="$2"
dir="$3"
case "$env" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
[[ "$run" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "the run id must be digits" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

r="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/runs/$run" 2> /dev/null)" || { echo "reading run $run failed" >&2; exit 1; }
what="$(jq -r '"\(.path) \(.event) \(.head_branch) \(.status) \(.conclusion)"' <<< "$r" 2> /dev/null)" ||
  { echo "reading run $run failed: unparsable" >&2; exit 1; }
[ "$what" = ".github/workflows/hosted-floor.yml workflow_dispatch main completed success" ] ||
  { echo "run $run is not a successful hosted-floor.yml dispatch on main ($what)" >&2; exit 1; }
mkdir -p "$dir"
gh run download "$run" --repo "$GITHUB_REPOSITORY" --pattern "floor-$env-*" --dir "$dir" > /dev/null ||
  { echo "downloading floor-$env-* from run $run failed" >&2; exit 1; }
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "$dir" -type f -name "floor-$env-*.sig.json" | sort)
[ "${#files[@]}" -eq 1 ] || { echo "run $run: want exactly one floor-$env-<seq>.sig.json, found ${#files[@]}" >&2; exit 1; }
[[ "$(basename "${files[0]}")" =~ ^floor-$env-[0-9]+\.sig\.json$ ]] || { echo "run $run: unexpected file $(basename "${files[0]}")" >&2; exit 1; }
echo "${files[0]}"
