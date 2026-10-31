#!/usr/bin/env bash
# Deploys one hosted platform Worker of one env (staging or prod) from CI
# (deploy-hosted-platform.yml),
# with the same fill-and-verify rules as the runbook (docs/ops/hosted.md):
#   1. deploy through deploy-platform-worker.sh (allowlist, placeholders filled
#      and checked, `--env <env>`, never an entry point or --name);
#   2. secrets only after the Worker exists: Google client secrets from the
#      environment (the auth broker's only when given or absent: rotation is a
#      re-run with it); generated keys on the first run only, never stored
#      anywhere else;
#   3. read the deployed settings back and refuse on any mismatch.
# Secrets go to wrangler on stdin and the API token to curl on stdin (-K -):
# none is ever in argv or printed.
# VERIFY_ONLY=1 deploys and sets nothing: it only reads the live Worker back and
# runs every check (a read-only rehearsal against what is deployed).
# Usage (env as below): scripts/ops/deploy-hosted-platform.sh staging|prod <target>
#   platform-db      PLATFORM_DB_ID (migrations, scripts/ops/platform-db.ts)
#   auth-broker      BROKER_REGISTRY_ID GOOGLE_CLIENT_ID [GOOGLE_CLIENT_SECRET]
#                    BROKER_PIN_FILE (main's packages/provision/src/wfp.ts: the
#                    client must equal its BROKER_GOOGLE_CLIENT_ID[<env>])
#   directory-broker DIRECTORY_REGISTRY_ID GOOGLE_DIRECTORY_CLIENT_ID GOOGLE_DIRECTORY_CLIENT_SECRET
#   provision-token  SECRETS_STORE_ID (reads only: the user pastes the secret)
#   provisioner      PLATFORM_DB_ID SECRETS_STORE_ID SIGNUP_DAILY_CAP SIGNUPS_ENABLED WELCOME_FROM
#   dispatch         HOSTS_KV_ID (both brokers must exist)
#   scheduler        PLATFORM_DB_ID EMAIL_ZONE_TAGS EMAIL_DAILY_LIMIT ALERT_TO ALERT_FROM
#                    SIGNUP_DAILY_CAP SIGNUPS_ENABLED (both brokers and the
#                    provisioner must exist)
#   inventory        PLATFORM_DB_ID HOSTS_KV_ID GITHUB_REPOSITORY_ID GITHUB_REPOSITORY
#                    (owner/repo: the OIDC principal, design v7 6.3)
#   provisioning     PLATFORM_DB_ID BROKER_REGISTRY_ID DIRECTORY_REGISTRY_ID
#                    GITHUB_REPOSITORY_ID (the provisioner and auth broker must exist)
# Always: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod platform-db|auth-broker|directory-broker|provision-token|provisioner|dispatch|scheduler|inventory|provisioning" >&2
  exit 2
fi
env="$1"
target="$2"
case "$env" in
  staging) P=s; ZONE=open-artifacts-staging.app ;;
  prod) P=p; ZONE=open-artifacts.app ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
NS="oa-$env"
# In CI, prod runs only from main, in the prod deploy Environment.
if [ "${GITHUB_ACTIONS:-}" = true ] && [ "$env" = prod ]; then
  [ "${GITHUB_REF:-}" = refs/heads/main ] || { echo "prod deploys run only from main (GITHUB_REF is ${GITHUB_REF:-unset})" >&2; exit 2; }
  [ "${DEPLOY_ENVIRONMENT:-}" = hosted-prod-deploy ] || { echo "prod deploys run only in hosted-prod-deploy" >&2; exit 2; }
fi
VERIFY_ONLY="${VERIFY_ONLY:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The allowlisted deploy wrapper (tests swap in a stub).
wrapper="${DEPLOY_WRAPPER:-$root/scripts/ops/deploy-platform-worker.sh}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# A Cloudflare API GET; the token reaches curl on stdin, never argv.
cf_get() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - "$ACCT$1"
}
# cf_send <method> <path> <body>: a write; the body is never a secret.
cf_send() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -X "$1" -H 'content-type: application/json' --data-binary "$3" "$ACCT$2"
}
# The body, only when .success is true; else the errors (never a token) and exit 1.
must() {
  local body
  body="$(cat)"
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$1 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  printf '%s' "$body"
}
worker_exists() { [ "$(cf_get "/workers/scripts/$1/settings" | jq -r '.success' 2> /dev/null)" = true ]; }
need_workers() {
  for w in "$@"; do worker_exists "$w" || { echo "$w does not exist: deploy it first" >&2; exit 1; }; done
}
need() { # name: a required, non-empty env var
  [ -n "${!1:-}" ] || { echo "$1 is required for $target" >&2; exit 2; }
}
secret_names() { cf_get "/workers/scripts/$1/secrets" | must "list $1 secrets" | jq -r '.result[].name'; }
# put_secret <worker> <app dir> <name>: the value comes on stdin.
put_secret() {
  if [ -n "$VERIFY_ONLY" ]; then
    cat > /dev/null
    echo "$1: verify only, not setting $3"
    return
  fi
  # A failure returns 1 (an `if` caller turns set -e off).
  (cd "$root/apps/$2" && pnpm exec wrangler secret put "$3" --env "$env" > /dev/null) ||
    { echo "$1: putting $3 failed" >&2; return 1; }
  echo "$1: $3 set"
}
# deploy <app>: through the wrapper, unless VERIFY_ONLY.
deploy() {
  if [ -n "$VERIFY_ONLY" ]; then echo "$target: verify only, not deploying"; return; fi
  bash "$wrapper" "$1" "$env"
}
settings() { cf_get "/workers/scripts/$1/settings" | must "read $1 settings"; }
# list_all <path ending in ? or &> <what>: every page's .result as one array; a
# failed page stops the run (never reads as "absent").
list_all() {
  local page body all='[]' pages
  for ((page = 1; page <= 100; page++)); do
    body="$(cf_get "${1}per_page=100&page=$page" | must "$2")" || exit 1
    all="$(jq -c --argjson a "$all" '$a + (.result // [])' <<< "$body")"
    pages="$(jq -r '.result_info.total_pages // 1' <<< "$body")"
    [ "$page" -lt "$pages" ] || { printf '%s' "$all"; return 0; }
  done
  echo "$2: did not end after 100 pages" >&2
  exit 1
}
# cf_raw <path>: a GET whose body is not the API's JSON envelope: the body on
# stdout and "\n<HTTP status>" last.
cf_raw() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -w '\n%{http_code}' "$ACCT$1"
}
# kv_get <namespace id> <key>: the value on stdout, exit 0; 3 when the key is
# absent; 1 on any other answer.
kv_get() {
  local out code
  out="$(cf_raw "/storage/kv/namespaces/$1/values/$2")" || return 1
  code="${out##*$'\n'}"
  case "$code" in
    200) printf '%s' "${out%$'\n'*}" ;;
    404) return 3 ;;
    *) echo "read $2 from KV $1 failed (HTTP $code)" >&2; return 1 ;;
  esac
}
# bundle_get <worker>: the deployed script content on stdout; exit 1 on any
# answer but a 200 with a body that is not JSON (an error envelope is JSON;
# a bundle never is).
bundle_get() {
  local out code body
  out="$(cf_raw "/workers/scripts/$1/content/v2")" || { echo "read $1 content failed" >&2; return 1; }
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  [ "$code" = 200 ] || { echo "read $1 content failed (HTTP $code)" >&2; return 1; }
  [ -n "$body" ] || { echo "read $1 content failed: empty" >&2; return 1; }
  if jq -e . > /dev/null 2>&1 <<< "$body"; then echo "read $1 content failed: a JSON answer, not a bundle" >&2; return 1; fi
  printf '%s' "$body"
}
# committed <app> <vars|ratelimits>: the tag's committed values for this env
# (scripts/ops/wrangler-env.ts), placeholders filled from the environment.
committed() { node --experimental-strip-types --no-warnings "$root/scripts/ops/wrangler-env.ts" "$root/apps/$1/wrangler.jsonc" "$env" "$2"; }
# vars_are <settings json> <app>: the deployed plain-text vars equal the
# committed ones exactly (names and values).
vars_are() {
  local want got
  want="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed "$2" vars | jq -S -c .)" || want=""
  [ -n "$want" ] || { echo "can't read $2's committed vars" >&2; exit 1; }
  got="$(jq -S -c '[.result.bindings[] | select(.type == "plain_text") | {(.name): .text}] | add // {}' <<< "$1")"
  [ "$got" = "$want" ] || { echo "$2 vars: got $got, want $want" >&2; exit 1; }
}
# names_are <settings json> <want>: the non-var, non-secret binding names, sorted, comma-joined.
names_are() {
  local got
  got="$(jq -r '[.result.bindings[] | select(.type != "plain_text" and .type != "secret_text") | .name] | sort | join(",")' <<< "$1")"
  [ "$got" = "$2" ] || { echo "bindings: got '$got', want '$2'" >&2; exit 1; }
}
no_secret_bindings() {
  local got
  got="$(jq -r '[.result.bindings[] | select(.type == "secret_text") | .name] | join(",")' <<< "$1")"
  [ -z "$got" ] || { echo "$2 has secret bindings ($got); want none" >&2; exit 1; }
}
# expect <settings json> <jq filter> <want> <what>
expect() {
  local got
  got="$(jq -r "$2" <<< "$1")"
  [ "$got" = "$3" ] || { echo "$4: got '$got', want '$3'" >&2; exit 1; }
}

# broker_pin: provision's BROKER_GOOGLE_CLIENT_ID[$env] from $BROKER_PIN_FILE
# (main's wfp.ts), or "null". Exit 1 when the pin can't be read.
# shellcheck disable=SC2016 # the JS template literal is single-quoted on purpose
broker_pin() {
  node -e '
    const src = require("node:fs").readFileSync(process.argv[1], "utf8");
    const m = /export const BROKER_GOOGLE_CLIENT_ID\b[^=]*=\s*Object\.freeze\(\{([^}]*)\}\)/.exec(src);
    const v = m && new RegExp(`(?:^|[\\s,])${process.argv[2]}:\\s*("[^"\\n]*"|null)\\s*,?`).exec(m[1]);
    if (!v) process.exit(1);
    console.log(v[1] === "null" ? "null" : JSON.parse(v[1]));
  ' "$BROKER_PIN_FILE" "$env"
}

case "$target" in
  platform-db)
    need PLATFORM_DB_ID
    node --experimental-strip-types --no-warnings "$root/scripts/ops/platform-db.ts" "$env"
    ;;
  provision-token)
    need SECRETS_STORE_ID
    # Read only: the user pastes the token into Secrets Store (H2b, H4b).
    name="oa-$P-provision-token"
    found="$(list_all "/secrets_store/stores/$SECRETS_STORE_ID/secrets?search=$name&" "list Secrets Store secrets" |
      jq -c --arg n "$name" '[.[] | select(.name == $n)]')"
    case "$(jq length <<< "$found")" in
      1) ;;
      0)
        echo "$name is not in Secrets Store: create the token and paste it there (https://dash.cloudflare.com/?to=/:account/secrets-store), then rerun" >&2
        exit 1 ;;
      *) echo "$name: more than one secret of that name" >&2; exit 1 ;;
    esac
    modified="$(jq -r '.[0].modified // ""' <<< "$found")"
    [ -n "$modified" ] || { echo "$name has no modified time" >&2; exit 1; }
    echo "$name: present in Secrets Store, modified $modified"
    ;;
  provisioner)
    need PLATFORM_DB_ID; need SECRETS_STORE_ID; need SIGNUP_DAILY_CAP; need SIGNUPS_ENABLED; need WELCOME_FROM
    # Check first, create only when absent; a failed listing stops the run.
    queues="$(list_all "/queues?" "list queues" | jq -r '.[].queue_name')"
    for q in "oa-$P-signups" "oa-$P-signups-dlq"; do
      grep -qx "$q" <<< "$queues" && continue
      [ -z "$VERIFY_ONLY" ] || { echo "queue $q does not exist" >&2; exit 1; }
      cf_send POST /queues "$(jq -nc --arg n "$q" '{queue_name: $n}')" | must "create queue $q" > /dev/null
      echo "queue $q created"
    done
    bucket="oa-$P-releases"
    b="$(cf_get "/r2/buckets/$bucket")"
    if [ "$(jq -r '.success' <<< "$b" 2> /dev/null)" != true ]; then
      [ "$(jq -r '[.errors[]?.code] | index(10006) != null' <<< "$b" 2> /dev/null)" = true ] ||
        { echo "read R2 bucket $bucket failed: $(jq -c '.errors' <<< "$b" 2> /dev/null || echo 'unparsable response')" >&2; exit 1; }
      [ -z "$VERIFY_ONLY" ] || { echo "R2 bucket $bucket does not exist" >&2; exit 1; }
      cf_send POST /r2/buckets "$(jq -nc --arg n "$bucket" '{name: $n}')" | must "create R2 bucket $bucket" > /dev/null
      echo "R2 bucket $bucket created"
    fi
    PLATFORM_DB_ID="$PLATFORM_DB_ID" SECRETS_STORE_ID="$SECRETS_STORE_ID" SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" \
      SIGNUPS_ENABLED="$SIGNUPS_ENABLED" WELCOME_FROM="$WELCOME_FROM" deploy provisioner
    S="$(settings oa-$P-provisioner)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "RELEASES") | .bucket_name' "$bucket" "RELEASES"
    expect "$S" '.result.bindings[] | select(.name == "WELCOME_EMAIL") | .type' send_email "WELCOME_EMAIL"
    expect "$S" '.result.bindings[] | select(.name == "PROVISION_TOKEN") | "\(.type) \(.store_id) \(.secret_name)"' \
      "secrets_store_secret $SECRETS_STORE_ID oa-$P-provision-token" "PROVISION_TOKEN"
    expect "$S" '.result.bindings[] | select(.name == "PROVISION_INSTALL") | "\(.workflow_name) \(.class_name)"' \
      "oa-$P-provision-install ProvisionInstall" "PROVISION_INSTALL"
    expect "$S" '.result.bindings[] | select(.name == "MANAGE_INSTALL") | "\(.workflow_name) \(.class_name)"' \
      "oa-$P-manage-install ManageInstall" "MANAGE_INSTALL"
    names_are "$S" "DISPATCHER,MANAGE_INSTALL,PLATFORM_DB,PROVISION_INSTALL,PROVISION_TOKEN,RELEASES,WELCOME_EMAIL"
    vars_are "$S" provisioner
    expect "$S" '.result.observability.enabled // false' false "observability"
    no_secret_bindings "$S" oa-$P-provisioner
    names="$(secret_names oa-$P-provisioner | tr '\n' ' ')"
    [ -z "$names" ] || { echo "oa-$P-provisioner has secrets '$names'; want none" >&2; exit 1; }
    ;;
  provisioning)
    need PLATFORM_DB_ID; need BROKER_REGISTRY_ID; need DIRECTORY_REGISTRY_ID; need GITHUB_REPOSITORY_ID
    need_workers oa-$P-provisioner oa-$P-auth-broker
    # Prod, before anything is deployed: the tag's committed vars carry no OIDC
    # principal and no test-users gate (4.4); the read-back checks them again.
    if [ "$env" = prod ]; then
      pre="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed provisioning vars)" || pre=""
      [ -n "$pre" ] || { echo "can't read provisioning's committed vars" >&2; exit 1; }
      oidc="$(jq -r '[keys[] | select(startswith("OIDC_"))] | join(",")' <<< "$pre")"
      [ -z "$oidc" ] || { echo "prod provisioning commits $oidc; prod has no OIDC principal; refusing" >&2; exit 1; }
      [ "$(jq -r '.SIGNUPS_ENABLED // ""' <<< "$pre")" != test-users ] ||
        { echo "prod provisioning commits SIGNUPS_ENABLED=test-users (staging only); refusing" >&2; exit 1; }
    fi
    # The Worker and what it depends on, plus the admin SPA (named on its own:
    # it is not a dependency of @oa/provisioning). Its vite build writes
    # apps/provisioning/dist-assets (ASSETS) itself, nothing is copied, and the
    # wrapper refuses a deploy without its index.html.
    if [ -z "$VERIFY_ONLY" ]; then (cd "$root" && pnpm --filter "@oa/admin..." --filter "@oa/provisioning..." build); fi
    # The OAuth KV namespace: check first, create only when absent.
    ns="oa-$P-provisioning-oauth"
    kvs="$(list_all "/storage/kv/namespaces?" "list KV namespaces")"
    found="$(jq -r --arg t "$ns" '[.[] | select(.title == $t) | .id] | join(" ")' <<< "$kvs")"
    if [ -z "$found" ]; then
      [ -z "$VERIFY_ONLY" ] || { echo "KV namespace $ns does not exist" >&2; exit 1; }
      found="$(cf_send POST /storage/kv/namespaces "$(jq -nc --arg t "$ns" '{title: $t}')" | must "create KV namespace $ns" | jq -r '.result.id')"
      echo "KV namespace $ns created"
    fi
    [[ "$found" =~ ^[0-9a-f]{32}$ ]] || { echo "KV namespace $ns: want exactly one, with a 32 hex id" >&2; exit 1; }
    OAUTH_KV_ID="$found"
    PLATFORM_DB_ID="$PLATFORM_DB_ID" PROVISIONING_OAUTH_KV_ID="$OAUTH_KV_ID" GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID" \
      deploy provisioning
    W="oa-$P-provisioning"
    have="$(secret_names "$W")"
    if ! grep -qx ADMIN_SESSION_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret "$W" provisioning ADMIN_SESSION_KEY
    fi
    # The admin's registry entry (4.3) carries the public half of
    # ADMIN_BROKER_KEY: a new key when either is missing, entry first (4.6).
    # A failed secret put deletes the new entry, so the next run makes both
    # again rather than keeping an entry the secret doesn't match.
    KEY="install:i000000admin"
    entry=""
    rc=0
    entry="$(kv_get "$BROKER_REGISTRY_ID" "$KEY")" || rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || exit 1
    if [ -z "$VERIFY_ONLY" ] && { [ "$rc" -eq 3 ] || ! grep -qx ADMIN_BROKER_KEY <<< "$have"; }; then
      key="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/broker-key.ts")"
      entry="$(jq -c --arg o "https://admin.$ZONE" '{installId: "i000000admin", origin: $o, keys: [{kid, x}], domains: []}' <<< "$key")"
      cf_send PUT "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$KEY" "$entry" | must "write $KEY" > /dev/null
      echo "$W: registry entry $KEY written"
      if ! jq -r '.pkcs8' <<< "$key" | put_secret "$W" provisioning ADMIN_BROKER_KEY; then
        key=""
        if cf_send DELETE "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$KEY" "" | must "delete $KEY" > /dev/null; then
          echo "$W: ADMIN_BROKER_KEY was not set; $KEY deleted, rerun to make both" >&2
        else
          echo "$W: ADMIN_BROKER_KEY was not set and $KEY could not be deleted: delete it by hand, then rerun" >&2
        fi
        exit 1
      fi
      key=""
    fi
    S="$(settings "$W")"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "OAUTH_KV") | .namespace_id' "$OAUTH_KV_ID" "OAUTH_KV"
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | "\(.service) \(.entrypoint)"' "oa-$P-provisioner ProvisionerRpc" "PROVISIONER"
    expect "$S" '.result.bindings[] | select(.name == "AUTH_BROKER") | .service' "oa-$P-auth-broker" "AUTH_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS") | .queue_name' "oa-$P-signups" "SIGNUPS"
    expect "$S" '.result.bindings[] | select(.name == "ASSETS") | .type' assets "ASSETS"
    for wf in "PROVISION_INSTALL oa-$P-provision-install ProvisionInstall" "MANAGE_INSTALL oa-$P-manage-install ManageInstall"; do
      read -r b n c <<< "$wf"
      expect "$S" ".result.bindings[] | select(.name == \"$b\") | \"\\(.workflow_name) \\(.class_name) \\(.script_name)\"" "$n $c oa-$P-provisioner" "$b"
    done
    want="$(committed provisioning ratelimits | jq -c .)" || want=""
    [ -n "$want" ] || { echo "can't read provisioning's committed rate limits" >&2; exit 1; }
    got="$(jq -c '[.result.bindings[] | select(.type == "ratelimit") | {name, namespace_id: (.namespace_id | tostring), limit: .simple.limit, period: .simple.period}] | sort_by(.name)' <<< "$S")"
    [ "$got" = "$want" ] || { echo "rate limits: got $got, want $want" >&2; exit 1; }
    names_are "$S" "$(jq -r '[.[].name, "ASSETS", "AUTH_BROKER", "MANAGE_INSTALL", "OAUTH_KV", "PLATFORM_DB", "PROVISIONER", "PROVISION_INSTALL", "SIGNUPS"] | sort | join(",")' <<< "$want")"
    if [ "$env" = prod ]; then
      oidc="$(jq -r '[.result.bindings[] | select(.name | startswith("OIDC_")) | .name] | join(",")' <<< "$S")"
      [ -z "$oidc" ] || { echo "prod $W binds $oidc; prod has no OIDC principal" >&2; exit 1; }
      expect "$S" '.result.bindings[] | select(.name == "SIGNUPS_ENABLED") | .text | . == "test-users"' false "SIGNUPS_ENABLED (test-users is staging only)"
    fi
    # ADMIN_IDENTITIES and MCP_REDIRECT_URIS among them.
    vars_are "$S" provisioning
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names "$W" | sort | tr '\n' ' ')"
    [ "$names" = "ADMIN_BROKER_KEY ADMIN_SESSION_KEY " ] || { echo "$W secrets are '$names'" >&2; exit 1; }
    rc=0
    entry="$(kv_get "$BROKER_REGISTRY_ID" "$KEY")" || rc=$?
    [ "$rc" -eq 0 ] || { [ "$rc" -eq 3 ] && echo "$KEY is not in oa-$P-broker-registry" >&2; exit 1; }
    ok="$(jq -r --arg o "https://admin.$ZONE" '.installId == "i000000admin" and .origin == $o and .domains == [] and (.keys | length) >= 1
      and all(.keys[]; (.kid | type) == "string" and (.x | type) == "string") and (.disabled // false) == false' <<< "$entry" 2> /dev/null)" || ok=""
    [ "$ok" = true ] || { echo "$KEY in oa-$P-broker-registry is not the admin entry" >&2; exit 1; }
    rc=0
    kv_get "$DIRECTORY_REGISTRY_ID" "$KEY" > /dev/null || rc=$?
    [ "$rc" -eq 3 ] || { [ "$rc" -eq 0 ] && echo "$KEY is in oa-$P-directory-registry; it must never be" >&2; exit 1; }
    # The sign-in stub never reaches a deployed bundle (12.1).
    bundle="$(bundle_get "$W")" || exit 1
    if grep -q 'test-signin' <<< "$bundle"; then echo "$W's bundle contains test-signin" >&2; exit 1; fi
    ;;
  auth-broker)
    need BROKER_REGISTRY_ID; need GOOGLE_CLIENT_ID; need BROKER_PIN_FILE
    # Before anything is deployed: the client must be provision's pin.
    pin="$(broker_pin)" || { echo "can't read BROKER_GOOGLE_CLIENT_ID[$env] from $BROKER_PIN_FILE; refusing" >&2; exit 1; }
    [ "$pin" != null ] || { echo "BROKER_GOOGLE_CLIENT_ID[$env] is null in provision: pin the client first; refusing" >&2; exit 1; }
    [ "$pin" = "$GOOGLE_CLIENT_ID" ] || { echo "GOOGLE_CLIENT_ID differs from provision's BROKER_GOOGLE_CLIENT_ID[$env] ($pin); refusing" >&2; exit 1; }
    # No secret given and none there (a new Worker has none): refuse before
    # deploying, so no broker runs without its client secret.
    if [ -z "${GOOGLE_CLIENT_SECRET:-}" ] && [ -z "$VERIFY_ONLY" ]; then
      worker_exists oa-$P-auth-broker && grep -qx GOOGLE_CLIENT_SECRET <<< "$(secret_names oa-$P-auth-broker)" ||
        { echo "oa-$P-auth-broker has no GOOGLE_CLIENT_SECRET: set it in the Environment and rerun" >&2; exit 1; }
    fi
    BROKER_REGISTRY_ID="$BROKER_REGISTRY_ID" GOOGLE_CLIENT_ID_PROD="$GOOGLE_CLIENT_ID" \
      deploy auth-broker
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key). Secrets survive `wrangler deploy`, so the
    # Google secret is put only when given (rotation) or absent.
    have="$(secret_names oa-$P-auth-broker)"
    if [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
      printf '%s' "$GOOGLE_CLIENT_SECRET" | put_secret oa-$P-auth-broker auth-broker GOOGLE_CLIENT_SECRET
    elif ! grep -qx GOOGLE_CLIENT_SECRET <<< "$have" && [ -z "$VERIFY_ONLY" ]; then
      echo "oa-$P-auth-broker has no GOOGLE_CLIENT_SECRET: set it in the Environment and rerun" >&2
      exit 1
    fi
    if ! grep -qx BROKER_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-auth-broker auth-broker BROKER_STATE_KEY
    fi
    S="$(settings oa-$P-auth-broker)"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_REGISTRY") | .namespace_id' "$BROKER_REGISTRY_ID" "BROKER_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_CLIENT_ID") | .text' "$GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_ORIGIN") | .text' "https://auth.$ZONE" "BROKER_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-auth-broker | sort | tr '\n' ' ')"
    [ "$names" = "BROKER_STATE_KEY GOOGLE_CLIENT_SECRET " ] || { echo "oa-$P-auth-broker secrets are '$names'" >&2; exit 1; }
    ;;
  directory-broker)
    need DIRECTORY_REGISTRY_ID; need GOOGLE_DIRECTORY_CLIENT_ID; [ -n "$VERIFY_ONLY" ] || need GOOGLE_DIRECTORY_CLIENT_SECRET
    DIRECTORY_REGISTRY_ID="$DIRECTORY_REGISTRY_ID" GOOGLE_DIRECTORY_CLIENT_ID_PROD="$GOOGLE_DIRECTORY_CLIENT_ID" \
      deploy directory-broker
    printf '%s' "${GOOGLE_DIRECTORY_CLIENT_SECRET:-}" | put_secret oa-$P-directory-broker directory-broker GOOGLE_DIRECTORY_CLIENT_SECRET
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key).
    have="$(secret_names oa-$P-directory-broker)"
    if ! grep -qx DIRECTORY_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-directory-broker directory-broker DIRECTORY_STATE_KEY
    fi
    S="$(settings oa-$P-directory-broker)"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_REGISTRY") | .namespace_id' "$DIRECTORY_REGISTRY_ID" "DIRECTORY_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_DIRECTORY_CLIENT_ID") | .text' "$GOOGLE_DIRECTORY_CLIENT_ID" "GOOGLE_DIRECTORY_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_ORIGIN") | .text' "https://directory.$ZONE" "DIRECTORY_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-directory-broker | sort | tr '\n' ' ')"
    [ "$names" = "DIRECTORY_STATE_KEY GOOGLE_DIRECTORY_CLIENT_SECRET " ] || { echo "oa-$P-directory-broker secrets are '$names'" >&2; exit 1; }
    ;;
  dispatch)
    need HOSTS_KV_ID
    need_workers oa-$P-auth-broker oa-$P-directory-broker
    HOSTS_KV_ID="$HOSTS_KV_ID" deploy dispatch
    S="$(settings oa-$P-dispatch)"
    expect "$S" '.result.bindings[] | select(.name == "HOSTS") | .namespace_id' "$HOSTS_KV_ID" "HOSTS"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "AUTH_BROKER") | .service' oa-$P-auth-broker "AUTH_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_BROKER") | .service' oa-$P-directory-broker "DIRECTORY_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    expect "$S" '.result.observability.enabled // false' false "observability"
    ;;
  scheduler)
    need PLATFORM_DB_ID; need EMAIL_ZONE_TAGS; need EMAIL_DAILY_LIMIT
    # An empty ALERT_TO fails the run (4.8): no alert is ever "sent" nowhere.
    need ALERT_TO; need ALERT_FROM; need SIGNUP_DAILY_CAP; need SIGNUPS_ENABLED
    # It binds the provisioner's RPC and Workflows (10.2's order).
    need_workers oa-$P-auth-broker oa-$P-directory-broker oa-$P-provisioner
    PLATFORM_DB_ID="$PLATFORM_DB_ID" EMAIL_ZONE_TAGS="$EMAIL_ZONE_TAGS" EMAIL_DAILY_LIMIT="$EMAIL_DAILY_LIMIT" \
      ALERT_TO="$ALERT_TO" ALERT_FROM="$ALERT_FROM" SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" SIGNUPS_ENABLED="$SIGNUPS_ENABLED" \
      deploy scheduler
    S="$(settings oa-$P-scheduler)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_QUOTA_ZONES") | .text' "$EMAIL_ZONE_TAGS" "EMAIL_QUOTA_ZONES"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_DAILY_LIMIT") | .text' "$EMAIL_DAILY_LIMIT" "EMAIL_DAILY_LIMIT"
    expect "$S" '.result.bindings[] | select(.name == "ALERT_TO") | .text' "$ALERT_TO" "ALERT_TO"
    expect "$S" '.result.bindings[] | select(.name == "ALERT_FROM") | .text' "$ALERT_FROM" "ALERT_FROM"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUP_DAILY_CAP") | .text' "$SIGNUP_DAILY_CAP" "SIGNUP_DAILY_CAP"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS_ENABLED") | .text' "$SIGNUPS_ENABLED" "SIGNUPS_ENABLED"
    # The alert mail goes to ALERT_TO and nowhere else.
    expect "$S" '[.result.bindings[] | select(.name == "ALERT_EMAIL") | "\(.type) \(.destination_address)"] | join(",")' \
      "send_email $ALERT_TO" "ALERT_EMAIL"
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | "\(.service) \(.entrypoint)"' "oa-$P-provisioner ProvisionerRpc" "PROVISIONER"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS") | .queue_name' "oa-$P-signups" "SIGNUPS"
    for wf in "PROVISION_INSTALL oa-$P-provision-install ProvisionInstall" "MANAGE_INSTALL oa-$P-manage-install ManageInstall"; do
      read -r b n c <<< "$wf"
      expect "$S" ".result.bindings[] | select(.name == \"$b\") | \"\\(.workflow_name) \\(.class_name) \\(.script_name)\"" "$n $c oa-$P-provisioner" "$b"
    done
    crons="$(cf_get /workers/scripts/oa-$P-scheduler/schedules | must "read oa-$P-scheduler schedules" | jq -r '[.result.schedules[].cron] | sort | join(",")')"
    [ "$crons" = "*/2 * * * *,17 3 * * *" ] || { echo "oa-$P-scheduler schedules are '$crons'" >&2; exit 1; }
    ;;
  inventory)
    need PLATFORM_DB_ID; need HOSTS_KV_ID; need GITHUB_REPOSITORY_ID; need GITHUB_REPOSITORY
    [[ "$GITHUB_REPOSITORY_ID" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "GITHUB_REPOSITORY_ID must be digits" >&2; exit 2; }
    [[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GITHUB_REPOSITORY must be owner/repo" >&2; exit 2; }
    # The refs are the tag's committed list (W8 owns it): each a full ref on
    # main to one of 6.3's two workflows, prod's holding the monitor's
    # (POST /prodclean) and staging's red-line's. Checked before deploying;
    # the deployed list must equal it.
    refs_want="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed inventory vars | jq -r '.OIDC_JOB_WORKFLOW_REFS // empty')" || refs_want=""
    [ -n "$refs_want" ] || { echo "the tag commits no OIDC_JOB_WORKFLOW_REFS for $env inventory" >&2; exit 1; }
    base="$GITHUB_REPOSITORY/.github/workflows"
    IFS=, read -ra refs <<< "$refs_want"
    for ref in "${refs[@]}"; do
      case "$ref" in
        "$base/prodclean-monitor.yml@refs/heads/main" | "$base/redline-staging.yml@refs/heads/main") ;;
        *) echo "committed OIDC_JOB_WORKFLOW_REFS has '$ref': not a 6.3 workflow's full ref on main" >&2; exit 1 ;;
      esac
    done
    if [ "$env" = prod ]; then need_ref="$base/prodclean-monitor.yml@refs/heads/main"; else need_ref="$base/redline-staging.yml@refs/heads/main"; fi
    printf '%s\n' "${refs[@]}" | grep -qxF "$need_ref" ||
      { echo "committed OIDC_JOB_WORKFLOW_REFS lacks '$need_ref'" >&2; exit 1; }
    PLATFORM_DB_ID="$PLATFORM_DB_ID" HOSTS_KV_ID="$HOSTS_KV_ID" GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID" deploy inventory
    S="$(settings oa-$P-inventory)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "HOSTS") | .namespace_id' "$HOSTS_KV_ID" "HOSTS"
    # 6.3: exactly these non-secret bindings, each OIDC value pinned, no secret.
    got="$(jq -r '[.result.bindings[] | select(.type != "secret_text") | .name] | sort | join(",")' <<< "$S")"
    want="HOSTS,OIDC_AUDIENCE,OIDC_ENVIRONMENT,OIDC_JOB_WORKFLOW_REFS,OIDC_REPOSITORY,OIDC_REPOSITORY_ID,PLATFORM_DB"
    [ "$got" = "$want" ] || { echo "bindings: got '$got', want '$want'" >&2; exit 1; }
    oidc() { jq -r --arg n "$1" '[.result.bindings[] | select(.name == $n and .type == "plain_text") | .text] | join(",")' <<< "$S"; }
    [ "$(oidc OIDC_AUDIENCE)" = "https://oa-$P-inventory" ] || { echo "OIDC_AUDIENCE: got '$(oidc OIDC_AUDIENCE)', want 'https://oa-$P-inventory'" >&2; exit 1; }
    [ "$(oidc OIDC_REPOSITORY)" = "$GITHUB_REPOSITORY" ] || { echo "OIDC_REPOSITORY: got '$(oidc OIDC_REPOSITORY)', want '$GITHUB_REPOSITORY'" >&2; exit 1; }
    [ "$(oidc OIDC_REPOSITORY_ID)" = "$GITHUB_REPOSITORY_ID" ] || { echo "OIDC_REPOSITORY_ID: got '$(oidc OIDC_REPOSITORY_ID)', want '$GITHUB_REPOSITORY_ID'" >&2; exit 1; }
    [ "$(oidc OIDC_ENVIRONMENT)" = redline-staging ] || { echo "OIDC_ENVIRONMENT: got '$(oidc OIDC_ENVIRONMENT)', want 'redline-staging'" >&2; exit 1; }
    want="$(tr , '\n' <<< "$refs_want" | sort | paste -sd , -)"
    got="$(oidc OIDC_JOB_WORKFLOW_REFS | tr , '\n' | sort | paste -sd , -)"
    [ "$got" = "$want" ] || { echo "OIDC_JOB_WORKFLOW_REFS: got '$got', want '$want'" >&2; exit 1; }
    vars_are "$S" inventory
    no_secret_bindings "$S" oa-$P-inventory
    names="$(secret_names oa-$P-inventory | tr '\n' ' ')"
    [ -z "$names" ] || { echo "oa-$P-inventory has secrets '$names'; want none" >&2; exit 1; }
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac
if [ -n "$VERIFY_ONLY" ]; then echo "$env $target: verified (verify only)"; else echo "$env $target: deployed and verified"; fi
