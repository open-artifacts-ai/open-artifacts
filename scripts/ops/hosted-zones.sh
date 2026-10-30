#!/usr/bin/env bash
# Wires one env's two tenant zones (docs/ops/hosted.md, Dispatch steps 4-8, plus
# the broker routes), from CI (deploy-hosted-platform.yml, target `zones`).
# Exactly these, nothing else:
#   both zones: ssl=strict, always_use_https=on, min_tls_version=1.2 (no HSTS)
#   DNS: AAAA * -> 100:: proxied, on the app zone and the page zone
#   routes: *.<app>/* and *.<page>/* -> oa-<p>-dispatch; auth.<app>/* ->
#           oa-<p>-auth-broker; directory.<app>/* -> oa-<p>-directory-broker
# `plan` reads only and prints each change (and "ok" for what already matches),
# also to $GITHUB_STEP_SUMMARY. `apply` plans first, refuses unless every change
# is an addition or setting change from that fixed set, makes them, then reads
# everything back and fails unless it equals the set exactly. Both refuse when
# a `*` record or one of these routes exists but differs (nothing is replaced),
# or when a route that isn't ours matches one of our patterns.
# Token: CLOUDFLARE_API_TOKEN, the env's one Cloudflare token (Zone Read, Zone
# Settings Edit, DNS Edit and Workers Routes Edit on these two zones, and
# Workers Scripts to check the target Workers exist). It reaches curl on stdin.
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
status="$(cf "$CLOUDFLARE_API_TOKEN" GET "$CF/user/tokens/verify" | must "verify CLOUDFLARE_API_TOKEN" | jq -r '.result.status')"
[ "$status" = active ] || { echo "CLOUDFLARE_API_TOKEN is $status, not active" >&2; exit 1; }

zone_id() {
  cf "$CLOUDFLARE_API_TOKEN" GET "$CF/zones?name=$1" | must "look up zone $1" |
    jq -r --arg n "$1" '[.result[] | select(.name == $n)] | if length == 1 then .[0].id else "" end'
}
APP_ZONE="$(zone_id "$APP")"
PAGE_ZONE="$(zone_id "$PAGE")"
[[ "$APP_ZONE" =~ ^[0-9a-f]{32}$ && "$PAGE_ZONE" =~ ^[0-9a-f]{32}$ ]] || { echo "zones $APP / $PAGE not found (or not unique)" >&2; exit 1; }

# The fixed expected set. Nothing outside it is ever written.
WILD='[{"type":"AAAA","content":"100::","proxied":true}]'
SETTINGS=('ssl:"strict"' 'always_use_https:"on"' 'min_tls_version:"1.2"')
ROUTES=("$APP_ZONE auth.$APP/* oa-$P-auth-broker" "$APP_ZONE directory.$APP/* oa-$P-directory-broker"
  "$APP_ZONE *.$APP/* oa-$P-dispatch" "$PAGE_ZONE *.$PAGE/* oa-$P-dispatch")
EXPECTED=()
for pair in "$APP:$APP_ZONE" "$PAGE:$PAGE_ZONE"; do
  EXPECTED+=("dns ${pair#*:} ${pair%%:*}")
  for s in "${SETTINGS[@]}"; do EXPECTED+=("setting ${pair#*:} ${s%%:*} ${s#*:}"); done
done
for r in "${ROUTES[@]}"; do EXPECTED+=("route $r"); done

# inspect <report>: reads only. Fills CHANGES with what differs from the
# expected set (one EXPECTED entry each); refuses a different `*` record, one of
# our patterns on another Worker, or another route our patterns match. With
# report, each line goes to the summary.
inspect() {
  local rep="$1" pair name zid base wild s k v cur r rz pat scr have routes foreign
  CHANGES=()
  for pair in "$APP:$APP_ZONE" "$PAGE:$PAGE_ZONE"; do
    name="${pair%%:*}"
    zid="${pair#*:}"
    base="$CF/zones/$zid"
    wild="$(cf "$CLOUDFLARE_API_TOKEN" GET "$base/dns_records?name=*.$name" | must "read the * record on $name" |
      jq -c '[.result[] | {type, content, proxied}]')"
    case "$wild" in
      '[]') CHANGES+=("dns $zid $name"); [ -z "$rep" ] || say "$name: create AAAA * -> 100:: (proxied)" ;;
      "$WILD") [ -z "$rep" ] || say "$name: AAAA * -> 100:: ok" ;;
      *) echo "$name has a different * record: $wild; refusing" >&2; exit 1 ;;
    esac
    for s in "${SETTINGS[@]}"; do
      k="${s%%:*}"
      v="${s#*:}"
      cur="$(cf "$CLOUDFLARE_API_TOKEN" GET "$base/settings/$k" | must "read $k on $name" | jq -c '.result.value')"
      if [ "$cur" = "$v" ]; then
        [ -z "$rep" ] || say "$name: $k = $v ok"
      else
        CHANGES+=("setting $zid $k $v")
        [ -z "$rep" ] || say "$name: set $k $cur -> $v"
      fi
    done
  done
  for zid in "$APP_ZONE" "$PAGE_ZONE"; do
    routes="$(cf "$CLOUDFLARE_API_TOKEN" GET "$CF/zones/$zid/workers/routes" | must "list routes" | jq -c '[.result[] | {pattern, script}]')"
    for r in "${ROUTES[@]}"; do
      read -r rz pat scr <<< "$r"
      [ "$rz" = "$zid" ] || continue
      have="$(jq -r --arg p "$pat" '[.[] | select(.pattern == $p) | .script] | join(",")' <<< "$routes")"
      if [ -z "$have" ]; then
        CHANGES+=("route $r")
        [ -z "$rep" ] || say "route $pat -> $scr: add"
      elif [ "$have" = "$scr" ]; then
        [ -z "$rep" ] || say "route $pat -> $scr ok"
      else
        echo "route $pat points at $have, not $scr; refusing" >&2
        exit 1
      fi
    done
    # Routes that aren't ours stay, unless one of our patterns matches them:
    # a more specific route would take traffic from ours.
    while IFS= read -r foreign; do
      [ -n "$foreign" ] || continue
      for r in "${ROUTES[@]}"; do
        read -r rz pat scr <<< "$r"
        [ "$rz" = "$zid" ] || continue
        # shellcheck disable=SC2053 # $pat is a glob on purpose
        if [[ "$foreign" == $pat ]]; then
          echo "route $foreign is not ours but matches $pat; refusing" >&2
          exit 1
        fi
      done
    done < <(jq -r --argjson ours "$(printf '%s\n' "${ROUTES[@]}" | jq -R 'split(" ")[1]' | jq -s .)" \
      '.[] | select(.pattern as $p | $ours | index($p) | not) | .pattern' <<< "$routes")
  done
}

inspect report
# Every planned change must be one of the expected set; else nothing is written.
for c in ${CHANGES[@]+"${CHANGES[@]}"}; do
  ok=""
  for e in "${EXPECTED[@]}"; do [ "$c" = "$e" ] && ok=1; done
  [ -n "$ok" ] || { echo "planned change outside the expected set: $c; refusing" >&2; exit 1; }
done
if [ "$mode" = plan ]; then
  say "plan only: nothing changed"
  exit 0
fi

for c in ${CHANGES[@]+"${CHANGES[@]}"}; do
  read -r kind zid a b <<< "$c"
  case "$kind" in
    dns)
      cf "$CLOUDFLARE_API_TOKEN" POST "$CF/zones/$zid/dns_records" -d '{"type":"AAAA","name":"*","content":"100::","proxied":true}' |
        must "create AAAA * on $a" > /dev/null ;;
    setting)
      got="$(cf "$CLOUDFLARE_API_TOKEN" PATCH "$CF/zones/$zid/settings/$a" -d "{\"value\":$b}" | must "set $a" | jq -c '.result.value')"
      [ "$got" = "$b" ] || { echo "$a is $got after the change, not $b" >&2; exit 1; } ;;
    route)
      cf "$CLOUDFLARE_API_TOKEN" POST "$CF/zones/$zid/workers/routes" -d "{\"pattern\":\"$a\",\"script\":\"$b\"}" |
        must "add route $a" > /dev/null ;;
  esac
done

# Read back: the live records, routes and settings must now equal the expected
# set exactly.
inspect ""
if [ "${#CHANGES[@]}" -ne 0 ]; then
  echo "after apply, still not as expected: ${CHANGES[*]}" >&2
  exit 1
fi
say "applied and read back: matches the expected set"
