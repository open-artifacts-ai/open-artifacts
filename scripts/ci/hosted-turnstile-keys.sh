#!/usr/bin/env bash
# Writes one env's Turnstile keys, <sitekey>:<secret>, to a 0600 file for the
# oa:hosted CLI (hosted-ops.yml, OA_HOSTED_TURNSTILE_FILE). The widget is the
# one named oa-<p>-turnstile (packages/provision/src/names.ts), found by exact
# name in the account's widget list; the secret comes from that widget's own
# GET (the list omits it). The secret is masked before anything else and never
# printed. No such widget writes no file and exits 0 (as an unset secret did
# before: provision then refuses a codes-on install by itself). Any failed
# call, a network error, 2+ widgets or an empty secret exits 1 and writes
# nothing.
# Needs CLOUDFLARE_API_TOKEN (to curl on stdin), CLOUDFLARE_ACCOUNT_ID.
# Usage: scripts/ci/hosted-turnstile-keys.sh staging|prod <out file>
set +x
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod <out file>" >&2; exit 2; }
case "$1" in
  staging) P=s ;;
  prod) P=p ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
out="$2"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
ACCT="/accounts/$CLOUDFLARE_ACCOUNT_ID"
name="oa-$P-turnstile"
# The CLI's own rule for both halves (scripts/hosted/src/cli.ts, KEY_CHARS).
key='^[A-Za-z0-9._-]+$'

list="$(list_all "$ACCT/challenges/widgets?" 50 "list Turnstile widgets (for $name)")" || exit 1
n="$(jq --arg w "$name" '[.[] | select(.name == $w)] | length' <<< "$list")" || exit 1
if [ "$n" = 0 ]; then
  echo "no Turnstile widget $name: no keys file (provision refuses a codes-on install)"
  exit 0
fi
sitekey="$(one "$list" name "$name" sitekey "Turnstile widget")" || exit 1
[[ "$sitekey" =~ $key ]] || { echo "Turnstile widget $name: unexpected sitekey" >&2; exit 1; }
body="$(cf_ok "$ACCT/challenges/widgets/$sitekey" "read Turnstile widget $name")" || exit 1
secret="$(jq -r '.result.secret // "" | strings' <<< "$body")" || exit 1
[ -n "$secret" ] || { echo "Turnstile widget $name: empty secret" >&2; exit 1; }
echo "::add-mask::$secret"
[[ "$secret" =~ $key ]] || { echo "Turnstile widget $name: unexpected secret characters" >&2; exit 1; }
umask 077
printf '%s:%s\n' "$sitekey" "$secret" > "$out"
