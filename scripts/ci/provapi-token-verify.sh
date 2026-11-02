#!/usr/bin/env bash
# Read-only check of an env's CI deploy token (design v7 13.1 "Spikes"), run
# by provapi-staging-spikes.yml: the prod-verify job (prod) and, through
# the staging spikes script's verify, the staging job.
#   verify   token status, end date (300-400 days out) and id (pinned in
#            <env>.json), both zones, the account, one read per permission
#            group, the oa-<s|p>-provision-token secret's metadata (name,
#            scopes, modified; never its value)
#   summary  spike-results.json and the job summary for verify
# GETs only: this file has one curl, in cf_get, with no method flag and no
# body. It never writes, deploys or deletes, and holds no write helper, so
# the prod token never shares a job with write code. Never leo.
# The Cloudflare token is read from $TOKEN_FILE (0600) into curl's config on
# a pipe (never argv); it is never printed.
# Env: TOKEN_FILE, RESULTS_DIR, HOSTED_DIR (holds <env>.json), RESULTS_OUT
# and GITHUB_STEP_SUMMARY (summary only).
# Usage: scripts/ci/provapi-token-verify.sh <staging|prod> [verify|summary]
set -euo pipefail

CF=https://api.cloudflare.com/client/v4
LEO=i2ab26lvciok

refuse() {
  echo "refused: $*" >&2
  exit 3
}

# record <spike> <check> <pass true|false> <observed> [detail JSON]
record() {
  jq -nc --arg s "$1" --arg c "$2" --argjson p "$3" --arg o "$4" --argjson d "${5:-null}" \
    '{spike: $s, check: $c, pass: $p, observed: $o} + (if $d == null then {} else {detail: $d} end)' \
    >> "$RESULTS_DIR/$1.jsonl"
  echo "$1 $2: $([ "$3" = true ] && echo pass || echo FAIL): $4"
}

# ---- constants: <env>.json, each zone checked to be that env's ----

# The account is shared by both envs: a value naming the other env, or leo,
# is refused.
not_other_env() {
  case "$1" in *"$LEO"*) refuse "$2 names leo ($LEO)" ;; esac
  if [ "$ENV" = staging ]; then
    case "$1" in
      *oa-p-* | *oa-prod* | open-artifacts.app | open-artifacts.page | *.open-artifacts.app | *.open-artifacts.page)
        refuse "$2 resolves to prod ($1)" ;;
    esac
  else
    case "$1" in *oa-s-* | *oa-staging* | *-staging.*) refuse "$2 resolves to staging ($1)" ;; esac
  fi
}

load_constants() {
  : "${HOSTED_DIR:?HOSTED_DIR is required}"
  local f="$HOSTED_DIR/$ENV.json" zone_re
  [ -f "$f" ] || refuse "$f is missing"
  ACCOUNT="$(jq -r '.account_id // ""' "$f")"
  APP_ZONE="$(jq -r '.app_zone // ""' "$f")"
  CONTENT_ZONE="$(jq -r '.content_zone // ""' "$f")"
  EMAIL_ZONE="$(jq -r '.email_zone // ""' "$f")"
  DEPLOY_TOKEN_ID="$(jq -r '.deploy_token_id // ""' "$f")"
  [[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || refuse "account_id is not 32 hex"
  if [ "$ENV" = staging ]; then zone_re='^[a-z0-9-]+-staging\.(app|page)$'; else zone_re='^[a-z0-9-]+\.(app|page)$'; fi
  for v in APP_ZONE CONTENT_ZONE EMAIL_ZONE; do
    [[ "${!v}" =~ $zone_re ]] || refuse "$v is not a $ENV zone (${!v})"
    not_other_env "${!v}" "$v"
  done
  # provision's platformNames(env).provisionToken (pinned by the tests).
  PROVISION_TOKEN_SECRET="oa-${ENV:0:1}-provision-token"
  ACCT="/accounts/$ACCOUNT"
}

# ---- Cloudflare GETs ----

check_token() {
  : "${TOKEN_FILE:?TOKEN_FILE is required}"
  [ -s "$TOKEN_FILE" ] || refuse "the token file is missing or empty"
  # Also keeps the curl config line well-formed (no quote, no newline).
  [[ "$(cat "$TOKEN_FILE")" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || refuse "the token has unexpected characters"
}

# curl's config on a pipe: the token never reaches argv.
_auth() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")"; }

# cf_get <path>: GET only. Sets HTTP and BODY; never prints the body.
cf_get() {
  case "$1" in *"$LEO"*) refuse "leo ($LEO) is never touched" ;; esac
  not_other_env "$1" path
  local out
  if out="$(curl -sS -K <(_auth) -w $'\n%{http_code}' "$CF$1")"; then
    HTTP="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
  else
    HTTP=000
    BODY='{}'
  fi
  jq -e . > /dev/null 2>&1 <<< "$BODY" || BODY='{}'
}

ok() { [ "$HTTP" = 200 ] && [ "$(jq -r '.success' <<< "$BODY")" = true ]; }
tf() { if "$@"; then echo true; else echo false; fi; }
id_ok() { [[ "$1" =~ ^[0-9a-f-]{32,36}$ ]]; }

# The one store holding $PROVISION_TOKEN_SECRET (the account's store is
# shared by both envs, so never just the first). Sets STORE and PROV_META
# (name, scopes, modified), or STORE_WHY when there is not exactly one.
provision_secret() {
  STORE=""
  PROV_META=null
  cf_get "$ACCT/secrets_store/stores"
  ok || { STORE_WHY="stores list HTTP $HTTP"; return 1; }
  local ids sid m hits=0 found="" meta=null
  ids="$(jq -r '.result[]?.id // ""' <<< "$BODY")"
  [ -n "$ids" ] || { STORE_WHY="no store"; return 1; }
  while IFS= read -r sid; do
    id_ok "$sid" || { STORE_WHY="refused a store id that is not an id"; return 1; }
    # Metadata only: the list endpoint (no endpoint returns a value).
    cf_get "$ACCT/secrets_store/stores/$sid/secrets?search=$PROVISION_TOKEN_SECRET&per_page=100"
    m="$(jq -c --arg n "$PROVISION_TOKEN_SECRET" '[.result[]? | select(.name == $n) | {name, scopes, modified}] | if length == 1 then .[0] else null end' <<< "$BODY")"
    if [ "$m" != null ]; then
      hits=$((hits + 1))
      found="$sid"
      meta="$m"
    fi
  done <<< "$ids"
  [ "$hits" = 1 ] || { STORE_WHY="$PROVISION_TOKEN_SECRET is in $hits stores, want exactly 1"; return 1; }
  STORE="$found"
  PROV_META="$meta"
}

has_workers_scope() { jq -e '. != null and ((.scopes // []) | index("workers") != null)' <<< "$1" > /dev/null; }

# ---- verify ----

spike_verify() {
  local s=verify
  cf_get /user/tokens/verify
  local st exp days
  st="$(jq -r '.result.status // ""' <<< "$BODY")"
  exp="$(jq -r '.result.expires_on // ""' <<< "$BODY")"
  days="$(jq -r --argjson now "$(date +%s)" '.result.expires_on // "" | sub("\\.[0-9]+"; "") | try ((fromdateiso8601 - $now) / 86400 | floor) catch ""' <<< "$BODY")"
  record $s token "$(tf test "$st" = active -a -n "$days" -a "${days:-0}" -ge 300 -a "${days:-0}" -le 400)" \
    "HTTP $HTTP; status=${st:-none}; expires_on=${exp:-none}; days out=${days:-none} (want 300-400)"
  # The environment's token, not a repo-level fallback: its id (not a
  # secret) must be the one pinned in <env>.json.
  local tid
  tid="$(jq -r '.result.id // ""' <<< "$BODY")"
  if [[ ! "$DEPLOY_TOKEN_ID" =~ ^[0-9a-f]{32}$ ]]; then
    record $s "token id" false "deploy_token_id is not pinned yet ($DEPLOY_TOKEN_ID); this token's id is ${tid:-none}"
  else
    record $s "token id" "$(tf test "$tid" = "$DEPLOY_TOKEN_ID")" "id=${tid:-none}; pinned=$DEPLOY_TOKEN_ID"
  fi

  local z n id
  ZONE_APP=""
  ZONE_CONTENT=""
  for n in APP_ZONE CONTENT_ZONE; do
    z="${!n}"
    cf_get "/zones?name=$z&account.id=$ACCOUNT"
    id="$(jq -r --arg z "$z" --arg a "$ACCOUNT" '[.result[]? | select(.name == $z and .account.id == $a) | .id] | if length == 1 then .[0] else "" end' <<< "$BODY")"
    [ -z "$id" ] || [[ "$id" =~ ^[0-9a-f]{32}$ ]] || refuse "zone $z: not an id ($id)"
    record $s "zone $z" "$(tf test -n "$id")" "HTTP $HTTP; $([ -n "$id" ] && echo "found $id" || echo "not found")"
    [ "$n" = APP_ZONE ] && ZONE_APP="$id" || ZONE_CONTENT="$id"
  done

  cf_get "$ACCT"
  record $s "account" "$(tf ok)" "HTTP $HTTP"

  # One read per permission group: reach, not edit rights.
  local g p
  while IFS='|' read -r g p; do
    cf_get "$p"
    record $s "$g" "$(tf ok)" "HTTP $HTTP"
  done << EOF
Workers Scripts|$ACCT/workers/scripts
Workers KV Storage|$ACCT/storage/kv/namespaces?per_page=1
D1|$ACCT/d1/database?per_page=1
Workers R2 Storage|$ACCT/r2/buckets?per_page=1
Queues|$ACCT/queues
Turnstile|$ACCT/challenges/widgets?per_page=5
Secrets Store|$ACCT/secrets_store/stores
EOF
  local ez=""
  [ "$EMAIL_ZONE" = "$APP_ZONE" ] && ez="$ZONE_APP"
  [ "$EMAIL_ZONE" = "$CONTENT_ZONE" ] && ez="$ZONE_CONTENT"
  if [ -n "$ez" ]; then
    cf_get "/zones/$ez/email/sending/subdomains"
    record $s "Email Sending ($EMAIL_ZONE)" "$(tf ok)" "HTTP $HTTP; $(jq -r '[.result[]?] | length' <<< "$BODY") sending subdomains"
  else
    record $s "Email Sending ($EMAIL_ZONE)" false "email zone not resolved"
  fi
  for n in APP_ZONE CONTENT_ZONE; do
    z="${!n}"
    [ "$n" = APP_ZONE ] && id="$ZONE_APP" || id="$ZONE_CONTENT"
    if [ -z "$id" ]; then
      record $s "zone groups $z" false "zone not resolved"
      continue
    fi
    while IFS='|' read -r g p; do
      cf_get "$p"
      record $s "$g ($z)" "$(tf ok)" "HTTP $HTTP"
    done << EOF
Zone Read|/zones/$id
Zone Settings Read|/zones/$id/settings
DNS Read|/zones/$id/dns_records?per_page=1
Workers Routes Read|/zones/$id/workers/routes
EOF
  done

  # The provisioning token secret: metadata only, from the list endpoint.
  if provision_secret; then
    record $s "secret $PROVISION_TOKEN_SECRET" \
      "$(tf has_workers_scope "$PROV_META")" \
      "store $STORE; $(jq -r '"scopes=\((.scopes // []) | join(",")) modified=\(.modified)"' <<< "$PROV_META")" "$PROV_META"
  else
    record $s "secret $PROVISION_TOKEN_SECRET" false "$STORE_WHY"
  fi
}

# ---- summary (verify only) ----

verify_summary() {
  local out="${RESULTS_OUT:-$RESULTS_DIR/../spike-results.json}" all='[]' f="$RESULTS_DIR/verify.jsonl"
  [ -f "$f" ] && all="$(jq -s -c . "$f")"
  jq -n --argjson c "$all" --arg env "$ENV" --arg sha "${GITHUB_SHA:-}" --arg run "${RUN_ID:-}" '
    {env: $env, run_id: $run, sha: $sha,
     note: "verify proves reach (one read per permission group), not edit rights",
     spikes: [{spike: "verify", pass: (($c | length) > 0 and all($c[]; .pass)), checks: $c}]}' > "$out"
  # Never a secret value in the results: refuse the file if the token is in it.
  if [ -s "${TOKEN_FILE:-}" ] && grep -qF -f "$TOKEN_FILE" "$out"; then
    echo '{"error":"results withheld: they held a secret"}' > "$out"
    refuse "the results held the token"
  fi
  {
    echo "## Provisioning API token verify: $ENV (run ${RUN_ID:-})"
    echo
    echo "verify proves reach (one read per permission group with its HTTP status), not edit rights."
    echo
    echo "| verify check | result | observed |"
    echo "|---|---|---|"
    jq -r '.spikes[0].checks[] | "| \(.check) | \(if .pass then "pass" else "FAIL" end) | \(.observed) |"' "$out"
    jq -r 'if (.spikes[0].checks | length) == 0 then "| (none) | FAIL | no result |" else empty end' "$out"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  jq -e '.spikes[0].pass' "$out" > /dev/null || { echo "verify failed" >&2; return 1; }
}

main() {
  [ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: $0 <staging|prod> [verify|summary]" >&2; exit 2; }
  case "$1" in staging | prod) ENV="$1" ;; *) echo "unknown env: $1" >&2; exit 2 ;; esac
  : "${RESULTS_DIR:?RESULTS_DIR is required}"
  mkdir -p "$RESULTS_DIR"
  case "${2:-verify}" in
  verify)
    check_token
    load_constants
    spike_verify
    if grep -q '"pass":false' "$RESULTS_DIR/verify.jsonl" 2> /dev/null; then exit 1; fi
    ;;
  summary) verify_summary ;;
  *) echo "unknown command: $2" >&2; exit 2 ;;
  esac
}

# Sourced by its tests for the guards; run otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
