#!/usr/bin/env bash
# Staging's smoke is green (#1406): prod takes a tag only while the
# post-deploy staging smoke (deploy-staging.yml, job smoke) is green at or
# after the tag's commit. It runs beside staging-first-gate.sh, in
# prod-release-chain.yml's gate and deploy-hosted-platform.yml's prod run.
# Read-only (`gh api`, GH_TOKEN with contents: read and actions: read).
# Fails closed: an API error, an unparsable answer, no run, or a run that is
# not at or after the tag is exit 1.
#
# The run it reads is the newest completed deploy-staging.yml run on main:
# event push, head_branch main, of this repository, newest by when its latest
# attempt started (run_started_at, so a re-run of an older run, which put
# older code on staging, counts as the newest). In-progress runs are skipped;
# a cancelled run counts only if it is that newest one, so a run cancelled
# while waiting and superseded by a newer completed run never blocks.
#   1. Its head is the tag's commit or a descendant of it
#      (compare/<tag sha>...<head> is "identical" or "ahead"), and on main
#      (compare/main...<head> is "identical" or "behind").
#   2. Its latest attempt's `smoke` job concluded success.
# Only the newest run counts: an older green run never vouches for staging
# once a newer run went red.
# Usage: scripts/ci/staging-smoke-gate.sh vX.Y.Z
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
R="repos/$GITHUB_REPOSITORY"

fail() { echo "staging smoke: $1; prod waits until a deploy-staging.yml run on main at or after $tag passes its smoke job" >&2; exit 1; }
# api <what> <path>: the JSON body, or fail naming what was read.
api() {
  local body
  body="$(gh api -X GET "$2" 2> /dev/null)" || fail "GitHub API error reading $1"
  jq -e . > /dev/null 2>&1 <<< "$body" || fail "unparsable $1"
  printf '%s' "$body"
}

sha="$(api "the commit of $tag" "$R/commits/$tag" | jq -r '.sha // ""')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "no commit for $tag"

runs="$(api "deploy-staging.yml runs" "$R/actions/workflows/deploy-staging.yml/runs?branch=main&event=push&status=completed&per_page=100")"
run="$(jq -r --arg repo "$GITHUB_REPOSITORY" '
  if (.workflow_runs | type) != "array" then error("no runs") else . end
  | [.workflow_runs[]
    | select(.status == "completed" and .head_branch == "main" and .event == "push")
    | select((.head_repository.full_name // "") == $repo)]
  | sort_by(.run_started_at // .created_at // "", .id) | last
  | if . == null then "" else "\(.id) \(.head_sha // "")" end' <<< "$runs" 2> /dev/null)" ||
  fail "unparsable deploy-staging.yml runs"
[ -n "$run" ] || fail "no completed deploy-staging.yml run on main"
head="${run#* }"
run="${run%% *}"
[[ "$run" =~ ^[1-9][0-9]{0,19}$ ]] || fail "unparsable deploy-staging.yml runs"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail "run $run has no head_sha"

# The newest run's head is the tag's commit or after it ...
st="$(api "the compare of $tag with run $run" "$R/compare/$sha...$head" | jq -r '.status // ""')"
case "$st" in
  identical | ahead) ;;
  *) fail "the newest completed run $run (head $head) is not at or after $tag's commit $sha (${st:-no status})" ;;
esac
# ... and on main (head_branch is only a name).
st="$(api "the compare of run $run with main" "$R/compare/main...$head" | jq -r '.status // ""')"
case "$st" in
  identical | behind) ;;
  *) fail "run $run's head $head is not on main (${st:-no status})" ;;
esac

jobs="$(api "run $run's jobs" "$R/actions/runs/$run/jobs?filter=latest&per_page=100")"
got="$(jq -r '[.jobs[] | select(.name == "smoke") | (.conclusion // "none")]
  | if length == 1 then .[0] else "missing" end' <<< "$jobs" 2> /dev/null)" ||
  fail "unparsable jobs of run $run"
[ "$got" = success ] || fail "run $run's smoke job: $got"
echo "staging smoke: green in run $run (head $head), at or after $tag ($sha)"
