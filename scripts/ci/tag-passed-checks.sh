#!/usr/bin/env bash
# The release gate of deploy-hosted-platform.yml: a tag deploys to an env only
# after every earlier check on it passed. Read-only (`gh api`, GH_TOKEN with
# contents: read and actions: read). Fails closed: exit 1, naming the failed
# check, unless all of these hold:
#   - the tag is a published, non-draft, non-prerelease GitHub release;
#   - the tag's commit is on main;
#   - the release-please.yml push run for that commit exists, and in it every
#     job the deploy depends on (REQUIRED below) completed with success;
#   - the release has at least one oa-release-<env>-* asset.
# An API or network error is a failure, never a pass.
# Usage: scripts/ci/tag-passed-checks.sh staging|prod vX.Y.Z
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod vX.Y.Z" >&2
  exit 2
fi
env="$1"
tag="$2"
case "$env" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
R="repos/$GITHUB_REPOSITORY"

fail() { echo "release gate failed: $1" >&2; exit 1; }
# api <check> <path>: the JSON body, or fail naming the check.
api() {
  local body
  body="$(gh api -X GET "$2" 2> /dev/null)" || fail "$1: GitHub API error"
  jq -e . > /dev/null 2>&1 <<< "$body" || fail "$1: unparsable response"
  printf '%s' "$body"
}

rel="$(api "release $tag" "$R/releases/tags/$tag")"
[ "$(jq -r '.tag_name' <<< "$rel")" = "$tag" ] || fail "release $tag: not found"
[ "$(jq -r '.draft' <<< "$rel")" = false ] || fail "release $tag: is a draft"
[ "$(jq -r '.prerelease' <<< "$rel")" = false ] || fail "release $tag: is a prerelease"
[ -n "$(jq -r '.published_at // empty' <<< "$rel")" ] || fail "release $tag: not published"

sha="$(api "commit of $tag" "$R/commits/$tag" | jq -r '.sha // empty')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "commit of $tag: not found"

# The tag's commit is main or behind it: an ancestor of main.
cmp="$(api "$tag on main" "$R/compare/main...$sha" | jq -r '.status // empty')"
case "$cmp" in identical | behind) ;; *) fail "$tag on main: $sha is not on main ($cmp)" ;; esac

run="$(api "release-please run" "$R/actions/workflows/release-please.yml/runs?event=push&branch=main&head_sha=$sha&per_page=100" |
  jq -c --arg s "$sha" '[.workflow_runs[] | select(.head_sha == $s and .event == "push")] | sort_by(.created_at) | last // empty')"
[ -n "$run" ] || fail "release-please run: no push run for $sha"
run_id="$(jq -r '.id' <<< "$run")"
[[ "$run_id" =~ ^[0-9]+$ ]] || fail "release-please run: bad id"

# The jobs the deploy depends on. The run's own conclusion is deliberately not
# required: pack-npm and publish-npm (npm packaging, #1455) are not a
# dependency of the hosted deploy, so an npm auth hiccup there must not block
# staging and prod releases (v0.122.0 was blocked that way). Each listed job
# must be present exactly once, completed, and concluded success; missing,
# skipped, cancelled, running or unknown statuses all block. Every other job in
# the run (deploy-prod, deploy-landing, a job added later) must be completed
# with success or skipped (deploy-demo is skipped when DEMO_ENABLED is off), so
# the only jobs allowed to fail are NPM_JOBS.
NPM_JOBS=(pack-npm publish-npm)
REQUIRED=(
  release-please
  verify-release
  hosted-guard
  hosted-build
  hosted-check
  "hosted-sign-$env"
  "hosted-attach-$env"
)
jobs="$(api "release-please jobs" "$R/actions/runs/$run_id/jobs?filter=latest&per_page=100")"
# One page of 100 must hold every job; otherwise a required job could hide on a later page.
jq -e '(.total_count // -1) <= (.jobs | length)' > /dev/null <<< "$jobs" || fail "release-please jobs: more than one page of jobs"
for j in "${REQUIRED[@]}"; do
  got="$(jq -r --arg n "$j" '[.jobs[] | select(.name == $n)] | if length == 1 then (if .[0].status == "completed" then (.[0].conclusion // "unknown") else "not completed (" + (.[0].status // "unknown") + ")" end) else "missing" end' <<< "$jobs")"
  [ "$got" = success ] || fail "job $j: $got"
done
bad="$(jq -r --argjson npm "$(printf '%s\n' "${NPM_JOBS[@]}" | jq -R . | jq -sc .)" '[.jobs[] | select(.name as $n | $npm | index($n) | not) | select(.status != "completed" or (.conclusion != "success" and .conclusion != "skipped")) | .name + ": " + (if .status != "completed" then "not completed (" + (.status // "unknown") + ")" else (.conclusion // "unknown") end)] | first // empty' <<< "$jobs")" || fail "release-please jobs: unreadable"
[ -z "$bad" ] || fail "job $bad"

n="$(jq --arg p "oa-release-$env-" '[.assets[] | select((.name | startswith($p)) and .state == "uploaded")] | length' <<< "$rel")"
[ "$n" -gt 0 ] || fail "assets: no oa-release-$env-* asset on $tag"

echo "release gate: $tag passed every check for $env (commit $sha, run $run_id)"
