#!/usr/bin/env bash
# The deploy token's own expiry (design v7 10.2, 4.6): deploy-hosted-platform.yml
# reads its CLOUDFLARE_API_TOKEN back (/user/tokens/verify) and, 30 days or
# less before its end date, opens an issue naming only the secret and its
# Environment (one open issue at a time; a later run finds it). provision's
# checkToken never runs on this token. A token that is not active, or a failed
# verify, exits 1; no end date is a warning (H2 sets one a year out).
# Needs CLOUDFLARE_API_TOKEN (to curl on stdin), GH_TOKEN (issues: write),
# GITHUB_REPOSITORY. TOKEN_NOW (epoch seconds) pins the clock in tests.
# Usage: scripts/ci/deploy-token-expiry.sh staging|prod
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 staging|prod" >&2; exit 2; }
case "$1" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
environment="hosted-$1-deploy"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
now="${TOKEN_NOW:-$(date +%s)}"
[[ "$now" =~ ^[0-9]+$ ]] || { echo "TOKEN_NOW must be epoch seconds" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"

body="$(cf_ok /user/tokens/verify "verify CLOUDFLARE_API_TOKEN")" || exit 1
status="$(jq -r '.result.status // ""' <<< "$body")"
[ "$status" = active ] || { echo "CLOUDFLARE_API_TOKEN ($environment) is ${status:-of unknown status}, not active" >&2; exit 1; }
expires="$(jq -r '.result.expires_on // ""' <<< "$body")"
if [ -z "$expires" ]; then
  echo "::warning::CLOUDFLARE_API_TOKEN ($environment) has no end date"
  exit 0
fi
at="$(jq -nr --arg e "$expires" '$e | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601')" ||
  { echo "CLOUDFLARE_API_TOKEN ($environment): unparsable end date" >&2; exit 1; }
day="$(jq -nr --argjson t "$at" '$t | strftime("%Y-%m-%d")')"
left=$(((at - now) / 86400))
if [ "$((at - now))" -gt $((30 * 86400)) ]; then
  echo "CLOUDFLARE_API_TOKEN ($environment) ends $day, in $left days"
  exit 0
fi

prefix="Roll CLOUDFLARE_API_TOKEN in $environment"
echo "::warning::CLOUDFLARE_API_TOKEN ($environment) ends $day, in $left days: roll it"
open="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "\"$prefix\" in:title" --json number,title --limit 100)" ||
  { echo "listing issues failed" >&2; exit 1; }
n="$(jq -r --arg p "$prefix" '[.[] | select(.title | startswith($p)) | .number] | first // ""' <<< "$open")" ||
  { echo "listing issues failed: unparsable" >&2; exit 1; }
if [ -n "$n" ]; then
  echo "issue #$n is already open"
  exit 0
fi
gh issue create --repo "$GITHUB_REPOSITORY" --title "$prefix: it ends $day" --body "The Cloudflare token in the secret \`CLOUDFLARE_API_TOKEN\` of the GitHub Environment \`$environment\` ends on $day.

Roll it (Cloudflare dashboard > My Profile > API Tokens > Roll: https://dash.cloudflare.com/profile/api-tokens), keep a one-year end date, and paste the new value into that secret (https://github.com/$GITHUB_REPOSITORY/settings/environments). Deploys fail once it ends.

Opened by deploy-hosted-platform.yml." > /dev/null
echo "opened an issue: $prefix"
