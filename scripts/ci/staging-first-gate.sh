#!/usr/bin/env bash
# Staging first, automatic (design v7 10.2): prod's platform-db, provisioner
# and provisioning targets of deploy-hosted-platform.yml deploy a tag only
# after staging ran it. Read-only (`gh api`, GH_TOKEN with actions: read).
# Fails closed: an API error, an unparsable answer, no such run or a version
# mismatch is exit 1. GATE_NOW (epoch seconds) pins the clock in tests.
#
# The contract (W12's redline-staging.yml builds to it):
#   1. A run of .github/workflows/redline-staging.yml, event workflow_dispatch,
#      on main (head_branch main and head_sha on main: compare/main...<sha> is
#      "behind" or "identical"), of this repository, completed with conclusion success, created
#      within the last 7 days.
#   2. Its `tag` input is this tag. The REST API does not return a run's
#      inputs, so the workflow sets `run-name: redline-staging ${{ inputs.tag }}`
#      and the run's display_title must be exactly "redline-staging vX.Y.Z".
#   3. The newest such run uploaded an artifact named `redline-staged-version`
#      (not expired) holding a file `version.txt` whose content, surrounding
#      whitespace trimmed, is this tag's version: X.Y.Z (the tag without its
#      "v"). W12 writes it after the upgrade, only once rl-a's and rl-b's
#      /healthz both report that version.
# Usage: scripts/ci/staging-first-gate.sh vX.Y.Z
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
version="${tag#v}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
now="${GATE_NOW:-$(date +%s)}"
[[ "$now" =~ ^[0-9]+$ ]] || { echo "GATE_NOW must be epoch seconds" >&2; exit 2; }
R="repos/$GITHUB_REPOSITORY"

fail() { echo "staging first: $1; run redline-staging.yml with tag $tag and let it pass, then rerun" >&2; exit 1; }
since="$(jq -nr --argjson t "$((now - 7 * 86400))" '$t | todate')"
# %3E%3D is ">=": runs created since then.
body="$(gh api -X GET "$R/actions/workflows/redline-staging.yml/runs?branch=main&status=success&per_page=100&created=%3E%3D$since" 2> /dev/null)" ||
  fail "GitHub API error reading redline-staging.yml runs"
jq -e '.workflow_runs | type == "array"' > /dev/null 2>&1 <<< "$body" || fail "unparsable redline-staging.yml runs"
run="$(jq -r --arg title "redline-staging $tag" --arg since "$since" --arg repo "$GITHUB_REPOSITORY" '
  [.workflow_runs[]
    | select(.conclusion == "success" and .status == "completed" and .head_branch == "main")
    | select(.event == "workflow_dispatch" and (.head_repository.full_name // "") == $repo)
    | select((.created_at // "") >= $since)
    | select((.display_title // "") == $title)]
  | sort_by(.created_at) | last | if . == null then "" else "\(.id) \(.head_sha // "")" end' <<< "$body")" ||
  fail "unparsable redline-staging.yml runs"
[ -n "$run" ] || fail "no successful redline-staging.yml run for $tag on main since $since"
sha="${run#* }"
run="${run%% *}"
[[ "$run" =~ ^[1-9][0-9]{0,19}$ ]] || fail "unparsable redline-staging.yml runs"
# head_branch is only a name (a tag called main matches it): the run's commit
# must be on main, so it ran main's redline-staging.yml.
# compare/main...<sha> is "behind" or "identical" exactly when it is.
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "run $run has no head_sha"
st="$(gh api -X GET "$R/compare/main...$sha" 2> /dev/null | jq -r '.status // ""' 2> /dev/null)" ||
  fail "GitHub API error comparing run $run's head_sha with main"
case "$st" in
  behind | identical) ;;
  *) fail "run $run's head_sha $sha is not on main (${st:-no status})" ;;
esac

# The run's own record of what staging runs: redline-staged-version/version.txt.
arts="$(gh api -X GET "$R/actions/runs/$run/artifacts?name=redline-staged-version&per_page=100" 2> /dev/null)" ||
  fail "GitHub API error reading run $run's artifacts"
art="$(jq -r '[.artifacts[] | select(.name == "redline-staged-version" and (.expired | not))]
  | if length == 1 then "\(.[0].id)" else "" end' <<< "$arts" 2> /dev/null)" ||
  fail "unparsable artifacts of run $run"
[ -n "$art" ] || fail "run $run has no single redline-staged-version artifact"
[[ "$art" =~ ^[1-9][0-9]{0,19}$ ]] || fail "unparsable artifacts of run $run"
dir="$(mktemp -d)"
trap 'command rm -rf "$dir"' EXIT
gh api "$R/actions/artifacts/$art/zip" > "$dir/a.zip" 2> /dev/null || fail "downloading run $run's redline-staged-version failed"
got="$(unzip -p "$dir/a.zip" version.txt 2> /dev/null)" || fail "run $run's redline-staged-version has no version.txt"
got="$(printf '%s' "$got" | tr -d '[:space:]')"
[ "$got" = "$version" ] || fail "run $run staged version '$got', want '$version'"
echo "staging first: redline-staging.yml passed $tag on version $version (run $run)"
