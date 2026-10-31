#!/usr/bin/env bash
# The resolve job of hosted-publish.yml (design v7 6.4): what to publish to
# which env's releases bucket, as GITHUB_OUTPUT lines kind (release, floor or
# none), tag, floor_run_id, staging and prod (true or false).
#   workflow_run (release-please on main, success): the release whose tag's
#     commit is the run's head_sha, to staging then prod; none is kind=none
#     (most pushes cut no release), exit 0.
#   workflow_dispatch: exactly one of TAG (vX.Y.Z; DEPLOY_ENV empty for both;
#     prod alone needs the tag's staging publish first, see staged) or
#     FLOOR_RUN_ID (a hosted-floor.yml run id; DEPLOY_ENV required).
# Read-only (`gh api`); an API error is exit 1, never "no release".
# Env: EVENT, HEAD_SHA, HEAD_BRANCH, CONCLUSION (workflow_run); TAG,
# DEPLOY_ENV, FLOOR_RUN_ID (dispatch); GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
R="repos/$GITHUB_REPOSITORY"
out() {
  { echo "kind=$1"; echo "tag=$2"; echo "floor_run_id=$3"; echo "staging=$4"; echo "prod=$5"; } >> "$GITHUB_OUTPUT"
  echo "publish: kind=$1 tag=${2:-none} floor_run_id=${3:-none} staging=$4 prod=$5"
}
stable='^v[0-9]+\.[0-9]+\.[0-9]+$'
# on_main <sha> <what>: the commit is main's or an ancestor of it. head_branch
# is only a name (a tag called main matches it), so the run's head_sha must be
# on main: compare/main...<sha> is "behind" or "identical". Any other status,
# a missing sha or an API error is exit 1.
on_main() {
  local st
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "$2 has no head_sha; refusing" >&2; exit 1; }
  st="$(gh api -X GET "$R/compare/main...$1" 2> /dev/null | jq -r '.status // ""' 2> /dev/null)" ||
    { echo "comparing $2's head_sha with main failed; refusing" >&2; exit 1; }
  case "$st" in
    behind | identical) ;;
    *) echo "$2's head_sha $1 is not on main (${st:-no status}); refusing" >&2; exit 1 ;;
  esac
}
# staged <tag>: staging first for a release dispatched to prod alone. The
# tag's staging publish record must exist: a completed hosted-publish.yml run
# on main (its head_sha on main, see on_main), of this repository, whose
# publish-staging job (named "publish-staging release <tag>" by the workflow)
# succeeded. Exit 1 when
# there is none or on any API error.
staged() {
  local runs ids id sha jobs n
  : "${GH_TOKEN:?GH_TOKEN is required}"
  runs="$(gh api -X GET "$R/actions/workflows/hosted-publish.yml/runs?branch=main&status=completed&per_page=100" 2> /dev/null)" ||
    { echo "listing hosted-publish.yml runs failed" >&2; exit 1; }
  ids="$(jq -r --arg repo "$GITHUB_REPOSITORY" '.workflow_runs
    | if type == "array" then . else error("no runs") end
    | .[] | select(.head_branch == "main" and .status == "completed" and (.head_repository.full_name // "") == $repo) | "\(.id):\(.head_sha // "")"' <<< "$runs")" ||
    { echo "listing hosted-publish.yml runs failed: unparsable" >&2; exit 1; }
  for id in $ids; do
    sha="${id#*:}"
    id="${id%%:*}"
    [[ "$id" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "listing hosted-publish.yml runs failed: a bad run id" >&2; exit 1; }
    jobs="$(gh api -X GET "$R/actions/runs/$id/jobs?per_page=100" 2> /dev/null)" ||
      { echo "reading run $id's jobs failed" >&2; exit 1; }
    n="$(jq -r --arg n "publish-staging release $1" '[.jobs[] | select(.name == $n and .conclusion == "success")] | length' <<< "$jobs" 2> /dev/null)" ||
      { echo "reading run $id's jobs failed: unparsable" >&2; exit 1; }
    if [ "$n" -gt 0 ]; then
      # The record counts only from a run of main's own workflow file.
      on_main "$sha" "hosted-publish.yml run $id"
      echo "staging first: $1 was published to staging (run $id)"
      return 0
    fi
  done
  echo "staging first: $1 has no successful staging publish (hosted-publish.yml on main); publish it to staging first, then rerun" >&2
  exit 1
}

case "${EVENT:-}" in
  workflow_run)
    if [ "${CONCLUSION:-}" != success ] || [ "${HEAD_BRANCH:-}" != main ]; then
      echo "release-please did not succeed on main; nothing to publish"
      out none "" "" false false
      exit 0
    fi
    [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "HEAD_SHA is not a commit sha" >&2; exit 1; }
    : "${GH_TOKEN:?GH_TOKEN is required}"
    rels="$(gh api -X GET "$R/releases?per_page=20" 2> /dev/null)" || { echo "listing releases failed" >&2; exit 1; }
    tags="$(jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' <<< "$rels")" ||
      { echo "listing releases failed: unparsable" >&2; exit 1; }
    found=""
    while IFS= read -r t; do
      [[ "$t" =~ $stable ]] || continue
      sha="$(gh api -X GET "$R/commits/$t" 2> /dev/null | jq -r '.sha // ""')" || { echo "reading $t's commit failed" >&2; exit 1; }
      [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "reading $t's commit failed" >&2; exit 1; }
      if [ "$sha" = "$HEAD_SHA" ]; then found="$t"; break; fi
    done <<< "$tags"
    if [ -z "$found" ]; then
      echo "no release at $HEAD_SHA; nothing to publish"
      out none "" "" false false
      exit 0
    fi
    out release "$found" "" true true
    ;;
  workflow_dispatch)
    tag="${TAG:-}"
    run="${FLOOR_RUN_ID:-}"
    env="${DEPLOY_ENV:-}"
    case "$env" in "" | staging | prod) ;; *) echo "env must be staging, prod or empty" >&2; exit 2 ;; esac
    if [ -n "$tag" ] && [ -n "$run" ]; then echo "give a tag or a floor run id, not both" >&2; exit 2; fi
    if [ -n "$tag" ]; then
      [[ "$tag" =~ $stable ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
      case "$env" in
        "") out release "$tag" "" true true ;;
        staging) out release "$tag" "" true false ;;
        prod) staged "$tag"; out release "$tag" "" false true ;;
      esac
    elif [ -n "$run" ]; then
      [[ "$run" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "floor_run_id must be a run id" >&2; exit 2; }
      [ -n "$env" ] || { echo "a floor is one env's: give env" >&2; exit 2; }
      if [ "$env" = staging ]; then out floor "" "$run" true false; else out floor "" "$run" false true; fi
    else
      echo "give a tag or a floor run id" >&2
      exit 2
    fi
    ;;
  *)
    echo "EVENT must be workflow_run or workflow_dispatch" >&2
    exit 2
    ;;
esac
