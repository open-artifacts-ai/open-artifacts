#!/usr/bin/env bash
# The Provisioning API's staging spikes (design v7 13.1 "Spikes", 14.4) and a
# read-only check of the CI token, run by provapi-staging-spikes.yml:
#   verify  provapi-token-verify.sh staging (token status, end date and id,
#           both zones, the account, one read per permission group, the
#           provisioning token secret's metadata)
#   s8      rl-a and rl-b secret and binding names and types (never values)
#   s6      rl-b's script versions
#   s4      Secrets Store: write a throwaway secret on stdin, read its
#           metadata back, delete it
#   deploy  the throwaway Workers and D1 database for s1 s2 s3 s5 s7
#   collect those spikes' results, read back from the throwaway D1 database
#   cleanup this run's resources and any oa-s-spike-* leftover over 1 h old
#   summary spike-results.json and the job summary
# Staging only. Never leo (i2ab26lvciok). Only GETs against rl-a and rl-b
# (cf_get); every write goes through cf_write, which refuses any name not
# starting with oa-s-spike- and any path in the dispatch namespace. Any
# constant that resolves to prod is refused before a call is made.
# The Cloudflare token is read from $TOKEN_FILE (0600) into curl's config on
# a pipe (never argv), and into wrangler's environment; it is never printed.
# Results hold names, types, statuses and times only.
# Env: TOKEN_FILE, RESULTS_DIR, STATE_DIR, RUN_ID, HOSTED_DIR (holds
# staging.json), SPIKES (summary only), GITHUB_STEP_SUMMARY (summary only).
# Usage: scripts/ci/provapi-spikes.sh <verify|s8|s6|s4|deploy|collect|cleanup|summary>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CF=https://api.cloudflare.com/client/v4
LEO=i2ab26lvciok
RLA=ijzbmraouh5r
RLB=i42fdk7ahvs2
PREFIX=oa-s-spike-
SPIKE_NAME_RE='^oa-s-spike-[a-z0-9-]+$'
WORKER_SPIKES="s1 s2 s3 s5 s7"

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

# ---- constants: staging.json and @oa/provision names, refused if prod ----

# Any value that names prod is refused (the account is shared by both envs).
not_prod() {
  case "$1" in
    *oa-p-* | *oa-prod* | open-artifacts.app | open-artifacts.page | *.open-artifacts.app | *.open-artifacts.page)
      refuse "$2 resolves to prod ($1)" ;;
  esac
  case "$1" in *"$LEO"*) refuse "$2 names leo ($LEO)" ;; esac
}

load_constants() {
  : "${HOSTED_DIR:?HOSTED_DIR is required}"
  local f="$HOSTED_DIR/staging.json"
  [ -f "$f" ] || refuse "$f is missing"
  ACCOUNT="$(jq -r '.account_id // ""' "$f")"
  APP_ZONE="$(jq -r '.app_zone // ""' "$f")"
  # shellcheck disable=SC2034 # checked below through ${!v}
  CONTENT_ZONE="$(jq -r '.content_zone // ""' "$f")"
  # shellcheck disable=SC2034 # checked below through ${!v}
  EMAIL_ZONE="$(jq -r '.email_zone // ""' "$f")"
  NAMESPACE="$(jq -r '.dispatch_namespace // ""' "$f")"
  [[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || refuse "account_id is not 32 hex"
  for v in APP_ZONE CONTENT_ZONE EMAIL_ZONE; do
    [[ "${!v}" =~ ^[a-z0-9-]+-staging\.(app|page)$ ]] || refuse "$v is not a staging zone (${!v})"
    not_prod "${!v}" "$v"
  done
  [ "$NAMESPACE" = oa-staging ] || refuse "dispatch_namespace is not oa-staging ($NAMESPACE)"
  not_prod "$NAMESPACE" dispatch_namespace
  # Script and secret names from @oa/provision (built dist), never copied.
  local js="${PROVISION_NAMES_JS:-$root/packages/provision/dist/names.js}"
  local out
  out="$(node --input-type=module -e '
    const m = await import(process.argv[1]);
    const n = (id) => m.names(id, "staging").script;
    console.log([n(process.argv[2]), n(process.argv[3]), m.platformNames("staging").provisionToken].join(" "));
  ' "$js" "$RLA" "$RLB")" || refuse "could not resolve names from $js"
  read -r RLA_SCRIPT RLB_SCRIPT PROVISION_TOKEN_SECRET <<< "$out"
  for v in RLA_SCRIPT RLB_SCRIPT PROVISION_TOKEN_SECRET; do
    [[ "${!v}" == oa-s-* ]] || refuse "$v is not a staging name (${!v})"
    not_prod "${!v}" "$v"
  done
  [ "$RLA_SCRIPT" = "oa-s-$RLA" ] && [ "$RLB_SCRIPT" = "oa-s-$RLB" ] || refuse "rl script names are unexpected"
  # shellcheck disable=SC2034 # read by render() through ${!k}
  RLA_HEALTHZ="https://rl-a.$APP_ZONE/healthz"
  ACCT="/accounts/$ACCOUNT"
  NS_PATH="$ACCT/workers/dispatch/namespaces/$NAMESPACE/scripts"
}

# ---- Cloudflare calls ----

# check_token: once, in the main shell, before any call.
check_token() {
  : "${TOKEN_FILE:?TOKEN_FILE is required}"
  [ -s "$TOKEN_FILE" ] || refuse "the token file is missing or empty"
  # Also keeps the curl config line well-formed (no quote, no newline).
  [[ "$(cat "$TOKEN_FILE")" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || refuse "the token has unexpected characters"
}

# curl's config on a pipe: the token never reaches argv.
_auth() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")"; }

_guard_path() {
  case "$1" in *"$LEO"*) refuse "leo ($LEO) is never touched" ;; esac
  case "$1" in *oa-p-* | *oa-prod*) refuse "prod is never touched ($1)" ;; esac
}

# cf_get <path>: GET only. Sets HTTP and BODY; never prints the body.
cf_get() {
  _guard_path "$1"
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

spike_name_ok() { [[ "$1" =~ $SPIKE_NAME_RE ]]; }

# Ids that Cloudflare returns are checked before they reach a URL path: a
# D1 uuid, or 32 hex (zone, store, secret). Anything else ("../", "%2F") is
# refused. KNOWN_IDS holds the ids this run created or validated for one of
# its own oa-s-spike- resources; cf_write accepts only those.
ID_RE='^[0-9a-f-]{32,36}$'
KNOWN_IDS=" "
id_ok() { [[ "$1" =~ $ID_RE ]]; }
valid_id() { id_ok "$1" || refuse "$2: not an id ($1)"; }
know_id() {
  valid_id "$1" "$2"
  KNOWN_IDS="$KNOWN_IDS$1 "
}
id_known() { [ -n "$1" ] && case "$KNOWN_IDS" in *" $1 "*) true ;; *) false ;; esac; }

# cf_write <POST|PUT|PATCH|DELETE> <path> <oa-s-spike- name> [id]: body on
# stdin (none for DELETE). Refuses any other name, the dispatch namespace,
# rl-a and rl-b, and any path that is not one of: a DELETE ending in the
# name or in a known id; a POST creating a D1 database or a secret in the
# staging store; a POST querying a known D1 id.
cf_write() {
  local m="$1" p="$2" n="$3" id="${4:-}" out base
  HTTP=000
  BODY='{}'
  case "$m" in POST | DELETE) ;; *) refuse "cf_write: method $m" ;; esac
  spike_name_ok "$n" || refuse "$m $p: $n does not start with $PREFIX"
  _guard_path "$p"
  case "$p" in
    *dispatch/namespaces* | *"$RLA"* | *"$RLB"* | *..* | *%*) refuse "no writes to the dispatch namespace, rl-a or rl-b, and no encoded or dot paths ($p)" ;;
  esac
  base="${p%%\?*}"
  case "$m" in
    DELETE)
      [[ "$base" == */"$n" ]] || { id_known "$id" && [[ "$base" == */"$id" ]]; } ||
        refuse "DELETE $p: the path ends in neither $n nor a known id" ;;
    POST)
      [ "$base" = "$ACCT/d1/database" ] ||
        { [ -n "${STORE:-}" ] && id_known "$STORE" && [ "$base" = "$ACCT/secrets_store/stores/$STORE/secrets" ]; } ||
        { id_known "$id" && [ "$base" = "$ACCT/d1/database/$id/query" ]; } ||
        refuse "POST $p: not a create or query of $n" ;;
  esac
  local data=()
  [ "$m" = DELETE ] || data=(-H 'Content-Type: application/json' --data-binary @-)
  if out="$(curl -sS -K <(_auth) -X "$m" ${data[@]+"${data[@]}"} -w $'\n%{http_code}' "$CF$p")"; then
    HTTP="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
  else
    HTTP=000
    BODY='{}'
  fi
  jq -e . > /dev/null 2>&1 <<< "$BODY" || BODY='{}'
}

ok() { [ "$HTTP" = 200 ] && [ "$(jq -r '.success' <<< "$BODY")" = true ]; }
# deleted: a DELETE's success. 202 is Cloudflare's async accept and 204 has no
# body; a body that says success false is still a failure.
deleted() {
  case "$HTTP" in
    200 | 202 | 204) [ "$(jq -r '.success' <<< "$BODY")" != false ] ;;
    *) false ;;
  esac
}
tf() { if "$@"; then echo true; else echo false; fi; }

# The staging Secrets Store store: the one store holding
# oa-s-provision-token (the account is shared with prod, so never just the
# first store). STORE is "" and STORE_WHY says why when there is not
# exactly one.
store_id() {
  STORE=""
  cf_get "$ACCT/secrets_store/stores"
  ok || { STORE_WHY="stores list HTTP $HTTP"; return 1; }
  local ids sid m hits=0 found=""
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
    fi
  done <<< "$ids"
  [ "$hits" = 1 ] || { STORE_WHY="$PROVISION_TOKEN_SECRET is in $hits stores, want exactly 1"; return 1; }
  know_id "$found" "store"
  STORE="$found"
}

# ---- verify (read-only) ----

# The GET-only verify script (the prod-verify job runs it alone), after this
# script's own staging checks in main.
spike_verify() { bash "$root/scripts/ci/provapi-token-verify.sh" staging verify; }

# ---- s8 (read-only): rl-a, rl-b secret and binding names and types ----

spike_s8() {
  local s=s8 label script sec bind
  for label in rl-a rl-b; do
    [ "$label" = rl-a ] && script="$RLA_SCRIPT" || script="$RLB_SCRIPT"
    cf_get "$NS_PATH/$script/secrets"
    local hs="$HTTP"
    sec="$(jq -c '[.result[]? | {name, type}] | sort_by(.name)' <<< "$BODY")"
    if [ "$hs" = 200 ]; then :; else sec=null; fi
    cf_get "$NS_PATH/$script/bindings"
    local hb="$HTTP"
    bind="$(jq -c '[.result[]? | {name, type}] | sort_by(.name)' <<< "$BODY")"
    if [ "$hb" = 200 ]; then :; else bind=null; fi
    record $s "$label ($script)" "$(tf test "$hs" = 200 -a "$hb" = 200)" \
      "secrets HTTP $hs ($(jq -r 'if . == null then "none" else length end' <<< "$sec")); bindings HTTP $hb ($(jq -r 'if . == null then "none" else map("\(.name):\(.type)") | join(" ") end' <<< "$bind"))" \
      "$(jq -nc --argjson a "$sec" --argjson b "$bind" '{secrets: $a, bindings: $b}')"
  done
}

# ---- s6 (read-only): rl-b's script versions ----

spike_s6() {
  local s=s6 n1 h1 n2 h2
  # Undocumented for namespace scripts: the account path's shape, under the namespace.
  cf_get "$NS_PATH/$RLB_SCRIPT/versions"
  h1="$HTTP"
  n1="$(jq -r '(.result.items // .result // []) | if type == "array" then length else "?" end' <<< "$BODY")"
  cf_get "$ACCT/workers/scripts/$RLB_SCRIPT/versions"
  h2="$HTTP"
  n2="$(jq -r '(.result.items // .result // []) | if type == "array" then length else "?" end' <<< "$BODY")"
  record $s "versions $RLB_SCRIPT" "$(tf test "$h1" = 200 -o "$h2" = 200)" \
    "namespace path HTTP $h1 ($n1 versions); account path HTTP $h2 ($n2 versions)"
}

# ---- s4: Secrets Store write on stdin, metadata read-back, delete ----

spike_s4() {
  local s=s4 name="${PREFIX}$RUN_ID" vf sid meta
  if ! store_id; then
    record $s "store" false "no store: $STORE_WHY; nothing created"
    return 0
  fi
  record $s "store" true "found $STORE"
  vf="$STATE_DIR/s4-value"
  (umask 077 && openssl rand -hex 32 | tr -d '\n' > "$vf")
  # The body (with the value) reaches curl on stdin; cf_write runs in this
  # shell (not a pipe's subshell) so HTTP and BODY stay set.
  cf_write POST "$ACCT/secrets_store/stores/$STORE/secrets" "$name" < <(
    jq -nc --rawfile v "$vf" --arg n "$name" \
      '[{name: $n, value: $v, scopes: ["workers"], comment: "throwaway: provapi-staging-spikes"}]'
  )
  rm -f "$vf"
  record $s "create $name (value on stdin)" "$(tf ok)" "HTTP $HTTP"
  cf_get "$ACCT/secrets_store/stores/$STORE/secrets?search=$name&per_page=100"
  meta="$(jq -c --arg n "$name" '[.result[]? | select(.name == $n) | {name, id, created, modified, scopes}] | first // null' <<< "$BODY")"
  record $s "read back metadata" "$(tf test "$meta" != null)" \
    "HTTP $HTTP; $(jq -r 'if . == null then "not found" else "name=\(.name) modified=\(.modified)" end' <<< "$meta")" \
    "$(jq -c 'if . == null then null else {name, modified} end' <<< "$meta")"
  sid="$(jq -r '.id // ""' <<< "$meta")"
  if [ -n "$sid" ]; then
    know_id "$sid" "secret $name"
    cf_write DELETE "$ACCT/secrets_store/stores/$STORE/secrets/$sid" "$name" "$sid"
    record $s "delete" "$(tf deleted)" "HTTP $HTTP"
  fi
}

# ---- deploy: throwaway Workers and D1 for s1 s2 s3 s5 s7 ----

# wrangler with the token in its environment only (never argv, never printed).
# The one accepted exception to "the token is only in a 0600 file or on a
# pipe": wrangler reads CLOUDFLARE_API_TOKEN from its environment and has no
# file or stdin option, so it is set for this one command (and its children).
wrangler_run() {
  CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" \
    pnpm --dir "$root/apps/dispatch" exec wrangler "$@"
}

render() {
  local src="$1" dst="$2" k v
  cp "$src" "$dst"
  for k in RUN_ID SPIKES RLB_SCRIPT RLA_HEALTHZ NAMESPACE D1_ID; do
    v="${!k}"
    [[ "$v" =~ ^[A-Za-z0-9:/._,-]+$ ]] || refuse "render: $k has unexpected characters"
    sed -i.bak "s|{{$k}}|$v|g" "$dst" && rm -f "$dst.bak"
  done
  ! grep -q '{{' "$dst" || refuse "render: $dst has a placeholder left (line $(grep -n '{{' "$dst" | head -n1 | cut -d: -f1))"
  not_prod "$(cat "$dst")" "$dst"
}

worker_spikes() {
  local want="" t
  for t in $WORKER_SPIKES; do
    case ",${SPIKES:-}," in *",$t,"*) want="${want:+$want,}$t" ;; esac
  done
  echo "$want"
}

fail_worker_spikes() {
  local t
  for t in ${SPIKES_W//,/ }; do record "$t" "run" false "$1"; done
}

spike_deploy() {
  SPIKES_W="$(worker_spikes)"
  [ -n "$SPIKES_W" ] || { echo "no worker spikes requested"; return 0; }
  local name="${PREFIX}$RUN_ID" dir="$root/spikes/provapi-staging"
  cf_write POST "$ACCT/d1/database" "$name" < <(jq -nc --arg n "$name" '{name: $n}')
  D1_ID="$(jq -r '.result.uuid // ""' <<< "$BODY")"
  if ! ok || [ -z "$D1_ID" ]; then
    fail_worker_spikes "D1 create failed (HTTP $HTTP)"
    return 1
  fi
  know_id "$D1_ID" "D1 $name"
  printf '%s' "$D1_ID" > "$STATE_DIR/d1_id"
  SPIKES="$SPIKES_W"
  render "$dir/wrangler.workflow.jsonc" "$dir/wrangler.workflow.rendered.jsonc"
  render "$dir/wrangler.jsonc" "$dir/wrangler.rendered.jsonc"
  if ! wrangler_run deploy -c "$dir/wrangler.workflow.rendered.jsonc"; then
    fail_worker_spikes "deploy of ${name}-wf failed"
    return 1
  fi
  if ! wrangler_run deploy -c "$dir/wrangler.rendered.jsonc"; then
    fail_worker_spikes "deploy of $name failed"
    return 1
  fi
  echo "deployed $name and ${name}-wf (D1 $D1_ID); spikes $SPIKES_W run on the first cron tick"
}

# collect: polls the throwaway D1 for each spike's row (deadline 8 min).
spike_collect() {
  SPIKES_W="$(worker_spikes)"
  [ -n "$SPIKES_W" ] || return 0
  local name="${PREFIX}$RUN_ID" want n rows=null deadline t
  [ -s "$STATE_DIR/d1_id" ] || { fail_worker_spikes "no D1 database (deploy failed)"; return 1; }
  D1_ID="$(cat "$STATE_DIR/d1_id")"
  know_id "$D1_ID" "D1 $name"
  want="$(tr ',' '\n' <<< "$SPIKES_W" | grep -c .)"
  deadline=$(($(date +%s) + ${COLLECT_DEADLINE_S:-480}))
  while :; do
    cf_write POST "$ACCT/d1/database/$D1_ID/query" "$name" "$D1_ID" < <(jq -nc '{sql: "SELECT spike, json FROM results"}')
    if ok; then
      rows="$(jq -c '[.result[0].results[]?]' <<< "$BODY")"
      n="$(jq 'length' <<< "$rows")"
      [ "$n" -ge "$want" ] && break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep "${COLLECT_POLL_S:-15}"
  done
  for t in ${SPIKES_W//,/ }; do
    local r
    r="$(jq -c --arg t "$t" '[.[]? | select(.spike == $t) | .json | fromjson] | first // null' <<< "$rows")"
    if [ "$r" = null ]; then
      record "$t" run false "no result before the deadline (last HTTP $HTTP)"
    else
      record "$t" run "$(jq '.pass == true' <<< "$r")" "$(jq -r '.observed' <<< "$r")" "$(jq -c '.detail // null' <<< "$r")"
    fi
  done
}

# ---- cleanup: this run's resources, and oa-s-spike-* leftovers over 1 h ----

# Prints "<name>\t<id>" for each item to delete: name starts with
# oa-s-spike-, and it is this run's or was created over 1 h ago.
doomed() {
  jq -r --arg mine "${PREFIX}$RUN_ID" --arg pre "$PREFIX" --arg nk "$1" --arg ik "$2" --arg ck "$3" \
    --argjson cutoff "$(($(date +%s) - 3600))" '
    def ts: (. // "") | tostring | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | try fromdateiso8601 catch null;
    .result[]? | {n: .[$nk], i: .[$ik], c: (.[$ck] | ts)}
    | select((.n | type) == "string" and (.n | startswith($pre)))
    | select(.n == $mine or .n == ($mine + "-wf") or (.c != null and .c < $cutoff))
    | "\(.n)\t\(.i)"' <<< "$BODY"
}

# guarded_delete <kind> <name> <path> [id]: refuses any name without the
# prefix, and an id that is not an id.
guarded_delete() {
  spike_name_ok "$2" || refuse "cleanup: refusing to delete $1 $2 (not $PREFIX)"
  [ -z "${4:-}" ] || know_id "$4" "cleanup: $1 $2"
  cf_write DELETE "$3" "$2" "${4:-}"
  record cleanup "$1 $2" "$(tf deleted)" "deleted (HTTP $HTTP)"
}

# skip_bad_id <kind> <name> <id>: true (and recorded) when the listed id is
# not an id, so it is never used and the other leftovers are still deleted.
skip_bad_id() {
  id_ok "$3" && return 1
  record cleanup "$1 $2" false "refused: its id is not an id"
  return 0
}

spike_cleanup() {
  local n i
  # Workers: the caller first (it binds the Workflow), then the host.
  cf_get "$ACCT/workers/scripts"
  doomed id id created_on | LC_ALL=C sort | while IFS=$'\t' read -r n i; do
    [ -z "$n" ] || guarded_delete worker "$n" "$ACCT/workers/scripts/$n?force=true"
  done
  # Workflows (their instances go with them).
  cf_get "$ACCT/workflows?per_page=100"
  doomed name name created_on | while IFS=$'\t' read -r n i; do
    [ -z "$n" ] || guarded_delete workflow "$n" "$ACCT/workflows/$n"
  done
  cf_get "$ACCT/d1/database?name=$PREFIX&per_page=100"
  doomed name uuid created_at | while IFS=$'\t' read -r n i; do
    [ -z "$n" ] || [ -z "$i" ] || skip_bad_id d1 "$n" "$i" || guarded_delete d1 "$n" "$ACCT/d1/database/$i" "$i"
  done
  if store_id; then
    cf_get "$ACCT/secrets_store/stores/$STORE/secrets?search=$PREFIX&per_page=100"
    doomed name id created | while IFS=$'\t' read -r n i; do
      [ -z "$n" ] || [ -z "$i" ] || skip_bad_id secret "$n" "$i" || guarded_delete secret "$n" "$ACCT/secrets_store/stores/$STORE/secrets/$i" "$i"
    done
  else
    record cleanup "secrets" false "not listed: $STORE_WHY"
  fi
  rm -f "$root"/spikes/provapi-staging/*.rendered.jsonc
  [ -s "$RESULTS_DIR/cleanup.jsonl" ] || echo "cleanup: nothing to delete"
}

# ---- summary ----

spike_summary() {
  local out="${RESULTS_OUT:-$RESULTS_DIR/../spike-results.json}" all
  local files=() f
  for f in "$RESULTS_DIR"/*.jsonl; do [ -f "$f" ] && files+=("$f"); done
  if [ "${#files[@]}" -gt 0 ]; then all="$(cat "${files[@]}" | jq -s -c .)"; else all='[]'; fi
  jq -n --argjson all "$all" --arg run "$RUN_ID" --arg sha "${GITHUB_SHA:-}" --arg spikes "${SPIKES:-}" '
    {run_id: $run, sha: $sha,
     note: "verify proves reach (one read per permission group), not edit rights",
     spikes: [($spikes | split(",")[] | select(. != "")) as $s
       | ($all | map(select(.spike == $s))) as $c
       | {spike: $s, pass: (($c | length) > 0 and all($c[]; .pass)),
          observed: (if ($c | length) == 0 then "no result" else ($c | map("\(.check): \(.observed)") | join("; ")) end),
          checks: $c}],
     cleanup: ($all | map(select(.spike == "cleanup")))}' > "$out"
  # Never a secret value in the results: refuse the file if the token is in it.
  if [ -s "${TOKEN_FILE:-}" ] && grep -qF -f "$TOKEN_FILE" "$out"; then
    echo '{"error":"results withheld: they held a secret"}' > "$out"
    refuse "the results held the token"
  fi
  {
    echo "## Provisioning API staging spikes (run $RUN_ID)"
    echo
    jq -r '.spikes[] | "- **\(.spike)**: \(if .pass then "pass" else "FAIL" end): \(if .spike == "verify" then "\(.checks | map(select(.pass)) | length)/\(.checks | length) checks pass" else .observed end)"' "$out"
    echo
    echo "verify proves reach (one read per permission group with its HTTP status), not edit rights."
    if jq -e '.spikes[] | select(.spike == "verify")' "$out" > /dev/null; then
      echo
      echo "| verify check | result | observed |"
      echo "|---|---|---|"
      jq -r '.spikes[] | select(.spike == "verify") | .checks[] | "| \(.check) | \(if .pass then "pass" else "FAIL" end) | \(.observed) |"' "$out"
    fi
    echo
    echo "Cleanup: $(jq -r '.cleanup | if length == 0 then "nothing deleted" else map(.check) | join(", ") end' "$out")"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  jq -e '[.spikes[].pass] | all' "$out" > /dev/null || { echo "a spike failed" >&2; return 1; }
}

main() {
  [ "$#" -eq 1 ] || { echo "usage: $0 <verify|s8|s6|s4|deploy|collect|cleanup|summary>" >&2; exit 2; }
  CMD="$1"
  : "${RESULTS_DIR:?RESULTS_DIR is required}"
  : "${STATE_DIR:?STATE_DIR is required}"
  : "${RUN_ID:?RUN_ID is required}"
  [[ "$RUN_ID" =~ ^[0-9]+$ ]] || refuse "RUN_ID must be digits"
  mkdir -p "$RESULTS_DIR" "$STATE_DIR"
  case "$CMD" in
  summary) spike_summary ;;
  verify | s8 | s6 | s4 | deploy | collect | cleanup)
    check_token
    load_constants
    "spike_$CMD"
    # Exit 1 when any check of this step failed (the step is continue-on-error).
    case "$CMD" in collect) mine="$WORKER_SPIKES" ;; deploy) mine="" ;; *) mine="$CMD" ;; esac
    for t in $mine; do
      if grep -q '"pass":false' "$RESULTS_DIR/$t.jsonl" 2> /dev/null; then exit 1; fi
    done
    ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
}

# Sourced by its tests for the guards; run otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
