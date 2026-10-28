#!/usr/bin/env bash
# Wires one env's two tenant zones (docs/ops/hosted.md, Dispatch steps 4-8, plus
# the broker routes), from CI (deploy-hosted-platform.yml, target `zones`).
# Exactly these, nothing else:
#   both zones: ssl=strict, always_use_https=on, min_tls_version=1.2 (no HSTS)
#   DNS: AAAA * -> 100:: proxied, on the app zone and the page zone
#   routes: *.<app>/* and *.<page>/* -> oa-<p>-dispatch; auth.<app>/* ->
#           oa-<p>-auth-broker; directory.<app>/* -> oa-<p>-directory-broker
# `plan` reads only and prints each change (and "ok" for what already matches),
# also to $GITHUB_STEP_SUMMARY. `apply` makes the same changes. Both refuse when
# a `*` record or one of these routes exists but differs: nothing is replaced.
# Tokens: ZONE_TOKEN (Zone Read, Zone Settings Edit, DNS Edit, Workers Routes
# Edit, these two zones only) for the zones; CLOUDFLARE_API_TOKEN (Workers
# Scripts) only to check the target Workers exist. Both reach curl on stdin.
# Usage: scripts/ops/hosted-zones.sh staging|prod plan|apply
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod plan|apply" >&2
  exit 2
fi
env="$1"
mode="$2"
case "$env" in
  staging) P=s; APP=open-artifacts-staging.app; PAGE=open-artifacts-staging.page ;;
  prod) P=p; APP=open-artifacts.app; PAGE=open-artifacts.page ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
case "$mode" in plan | apply) ;; *) echo "mode must be plan or apply" >&2; exit 2 ;; esac
: "${ZONE_TOKEN:?ZONE_TOKEN is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
CF=https://api.cloudflare.com/client/v4
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

# cf <token> <method> <url> [curl args]: the token reaches curl on stdin.
cf() {
  local t="$1" m="$2" u="$3"
  shift 3
  printf 'header = "Authorization: Bearer %s"\n' "$t" |
    curl -sS -K - -X "$m" -H 'content-type: application/json' "$@" "$u"
}
# The body only if .success is true; else the errors (never a token) and exit 1.
must() {
  local body
  body="$(cat)"
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$1 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  printf '%s' "$body"
}
say() { echo "$1"; echo "- $1" >> "$SUMMARY"; }

echo "### Zones for $env ($mode)" >> "$SUMMARY"
for w in "oa-$P-dispatch" "oa-$P-auth-broker" "oa-$P-directory-broker"; do
  ok="$(cf "$CLOUDFLARE_API_TOKEN" GET "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$w/settings" | jq -r '.success' 2> /dev/null)"
  [ "$ok" = true ] || { echo "$w does not exist: deploy it first" >&2; exit 1; }
done
status="$(cf "$ZONE_TOKEN" GET "$CF/user/tokens/verify" | must "verify ZONE_TOKEN" | jq -r '.result.status')"
[ "$status" = active ] || { echo "ZONE_TOKEN is $status, not active" >&2; exit 1; }

zone_id() {
  cf "$ZONE_TOKEN" GET "$CF/zones?name=$1" | must "look up zone $1" |
    jq -r --arg n "$1" '[.result[] | select(.name == $n)] | if length == 1 then .[0].id else "" end'
}
APP_ZONE="$(zone_id "$APP")"
PAGE_ZONE="$(zone_id "$PAGE")"
[[ "$APP_ZONE" =~ ^[0-9a-f]{32}$ && "$PAGE_ZONE" =~ ^[0-9a-f]{32}$ ]] || { echo "zones $APP / $PAGE not found (or not unique)" >&2; exit 1; }

for pair in "$APP:$APP_ZONE" "$PAGE:$PAGE_ZONE"; do
  name="${pair%%:*}"
  zid="${pair#*:}"
  base="$CF/zones/$zid"
  wild="$(cf "$ZONE_TOKEN" GET "$base/dns_records?name=*.$name" | must "read the * record on $name" |
    jq -c '[.result[] | {type, content, proxied}]')"
  case "$wild" in
    '[]')
      say "$name: create AAAA * -> 100:: (proxied)"
      if [ "$mode" = apply ]; then
        cf "$ZONE_TOKEN" POST "$base/dns_records" -d '{"type":"AAAA","name":"*","content":"100::","proxied":true}' |
          must "create AAAA * on $name" > /dev/null
      fi ;;
    '[{"type":"AAAA","content":"100::","proxied":true}]') say "$name: AAAA * -> 100:: ok" ;;
    *) echo "$name has a different * record: $wild; refusing" >&2; exit 1 ;;
  esac
  for s in 'ssl:"strict"' 'always_use_https:"on"' 'min_tls_version:"1.2"'; do
    k="${s%%:*}"
    v="${s#*:}"
    cur="$(cf "$ZONE_TOKEN" GET "$base/settings/$k" | must "read $k on $name" | jq -c '.result.value')"
    if [ "$cur" = "$v" ]; then
      say "$name: $k = $v ok"
    else
      say "$name: set $k $cur -> $v"
      if [ "$mode" = apply ]; then
        got="$(cf "$ZONE_TOKEN" PATCH "$base/settings/$k" -d "{\"value\":$v}" | must "set $k on $name" | jq -c '.result.value')"
        [ "$got" = "$v" ] || { echo "$k on $name is $got after the change, not $v" >&2; exit 1; }
      fi
    fi
  done
done

route() { # zone id, pattern, script
  local have
  have="$(cf "$ZONE_TOKEN" GET "$CF/zones/$1/workers/routes" | must "list routes" |
    jq -r --arg p "$2" '[.result[] | select(.pattern == $p) | .script] | join(",")')"
  if [ -z "$have" ]; then
    say "route $2 -> $3: add"
    if [ "$mode" = apply ]; then
      cf "$ZONE_TOKEN" POST "$CF/zones/$1/workers/routes" -d "{\"pattern\":\"$2\",\"script\":\"$3\"}" |
        must "add route $2" > /dev/null
    fi
  elif [ "$have" = "$3" ]; then
    say "route $2 -> $3 ok"
  else
    echo "route $2 points at $have, not $3; refusing" >&2
    exit 1
  fi
}
route "$APP_ZONE" "auth.$APP/*" "oa-$P-auth-broker"
route "$APP_ZONE" "directory.$APP/*" "oa-$P-directory-broker"
route "$APP_ZONE" "*.$APP/*" "oa-$P-dispatch"
route "$PAGE_ZONE" "*.$PAGE/*" "oa-$P-dispatch"
if [ "$mode" = plan ]; then say "plan only: nothing changed"; else say "applied"; fi
