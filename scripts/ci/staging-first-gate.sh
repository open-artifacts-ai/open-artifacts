#!/usr/bin/env bash
# Staging first, automatic (design v7 10.2): the prod provisioner and
# provisioning targets of deploy-hosted-platform.yml deploy a tag only after a
# successful redline-staging.yml run on main whose run name carries that same
# tag (the workflow takes a `tag` input and sets run-name), created within the
# last 7 days. Read-only (`gh api`, GH_TOKEN with actions: read). Fails
# closed: an API error, an unparsable answer or no such run is exit 1.
# GATE_NOW (epoch seconds) pins the clock in tests.
# Usage: scripts/ci/staging-first-gate.sh vX.Y.Z
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
now="${GATE_NOW:-$(date +%s)}"
[[ "$now" =~ ^[0-9]+$ ]] || { echo "GATE_NOW must be epoch seconds" >&2; exit 2; }

fail() { echo "staging first: $1; run redline-staging.yml with tag $tag and let it pass, then rerun" >&2; exit 1; }
since="$(jq -nr --argjson t "$((now - 7 * 86400))" '$t | todate')"
# %3E%3D is ">=": runs created since then.
body="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/redline-staging.yml/runs?branch=main&status=success&per_page=100&created=%3E%3D$since" 2> /dev/null)" ||
  fail "GitHub API error reading redline-staging.yml runs"
jq -e '.workflow_runs | type == "array"' > /dev/null 2>&1 <<< "$body" || fail "unparsable redline-staging.yml runs"
# The tag as a whole word of the run name: v1.2.3 is not v1.2.30 or v1.2.3-rc.1.
run="$(jq -r --arg t "$tag" --arg since "$since" '
  [.workflow_runs[]
    | select(.conclusion == "success" and .status == "completed" and .head_branch == "main")
    | select((.created_at // "") >= $since)
    | select([(.display_title // "") | scan("(?<![0-9A-Za-z.-])v[0-9]+\\.[0-9]+\\.[0-9]+(?![0-9A-Za-z.-])")] | index($t) != null)]
  | sort_by(.created_at) | last | if . == null then "" else "\(.id) \(.html_url // "")" end' <<< "$body")" ||
  fail "unparsable redline-staging.yml runs"
[ -n "$run" ] || fail "no successful redline-staging.yml run for $tag on main since $since"
echo "staging first: redline-staging.yml passed $tag (run ${run%% *})"
