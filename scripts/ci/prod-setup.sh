#!/usr/bin/env bash
# Production setup via @oa/setup. Never prints the owner token or ANALYTICS_TOKEN
# (read by the setup secrets step from env, when set).
# Usage: prod-setup.sh <install|preflight|upgrade|cleanup>
#        prod-setup.sh <demo-install|demo-upgrade|demo-cleanup>   (the public demo; reads DEMO_*)
# The demo modes run the same wrapper (oa_pat_ and ANALYTICS_TOKEN scan, status handling).
set -uo pipefail

case "${1:-}" in
  demo-*)
    # The demo must never target the production Worker or its hosts.
    if [[ "${DEMO_NAME:-}" == "open-artifacts-prod" || "${DEMO_NAME:-}" == "${PROD_NAME:-@}" ||
      "${DEMO_APP_HOST:-}" == "artifacts.leourbina.com" ]]; then
      echo "demo setup refuses the production name or host" >&2
      exit 2
    fi
    PROD_NAME="${DEMO_NAME:-}" PROD_APP_HOST="${DEMO_APP_HOST:-}"
    PROD_CONTENT_HOST="${DEMO_CONTENT_HOST:-}" PROD_OWNER_EMAIL="${DEMO_OWNER_EMAIL:-}"
    ;;
esac
: "${PROD_NAME:?}" "${PROD_APP_HOST:?}" "${PROD_CONTENT_HOST:?}" "${PROD_OWNER_EMAIL:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
mode="${1:-}"
# Prod is Workers Paid, but stateless CI reads the plan as unknown and --json
# never guesses team or the PLAN var: thumbnails (--browser), team, the sending
# domain and --plan paid are explicit. mail.leourbina.com is onboarded for
# Email Sending (MX, SPF, DKIM and DMARC in DNS); the first deploy after this
# lands adds the EMAIL binding and EMAIL_FROM.
EMAIL_SWITCH=(--team --yes-paid --email-domain mail.leourbina.com)
case "$mode" in
  install) mode_args=(--ci "${EMAIL_SWITCH[@]}" --browser --plan paid) ;;
  preflight) mode_args=(--check --strict --upgrade "${EMAIL_SWITCH[@]}" --browser --plan paid) ;; # read-only; skips if not installed, fails if drifted or partial
  upgrade) mode_args=(--ci --upgrade "${EMAIL_SWITCH[@]}" --browser --plan paid) ;;
  cleanup) mode_args=(--ci --revoke-ci-tokens) ;;
  demo-install) mode_args=(--ci --json --solo --no-email --yes-paid) ;;
  demo-upgrade) mode_args=(--ci --json --upgrade --solo --no-email --yes-paid) ;;
  demo-cleanup) mode_args=(--ci --revoke-ci-tokens) ;;
  *) echo "usage: $0 <install|preflight|upgrade|cleanup|demo-install|demo-upgrade|demo-cleanup>" >&2; exit 2 ;;
esac

# Demo only: PUBLIC_HOME is the gallery artifact shown to signed-out visitors. Same rule as
# isId in packages/shared/src/ids.ts (16 base58 chars). Setup keeps it across later upgrades.
case "$mode" in
  demo-install | demo-upgrade)
    if [[ -n "${DEMO_PUBLIC_HOME:-}" ]]; then
      if [[ ! "$DEMO_PUBLIC_HOME" =~ ^[1-9A-HJ-NP-Za-km-z]{16}$ ]]; then
        echo '{"step":"demo-vars","status":"error","message":"DEMO_PUBLIC_HOME is not an artifact id"}'
        exit 1
      fi
      mode_args+=(--var "PUBLIC_HOME=$DEMO_PUBLIC_HOME")
    fi
    ;;
esac

# Prod only: direct sign-in from the repository variables (PROD_AUTH_PROVIDERS,
# PROD_AUTH_DOMAINS, PROD_AUTH_DOMAIN_JOIN, PROD_GOOGLE_CLIENT_ID, in env). An
# unset or empty one passes no flag, so setup keeps the live Worker's value.
# Each value is one argv element (--flag=value); setup validates it.
case "$mode" in
  install | preflight | upgrade)
    for pair in auth-providers=PROD_AUTH_PROVIDERS auth-domains=PROD_AUTH_DOMAINS \
      auth-domain-join=PROD_AUTH_DOMAIN_JOIN google-client-id=PROD_GOOGLE_CLIENT_ID; do
      var="${pair#*=}"
      if [[ -n "${!var:-}" ]]; then mode_args+=("--${pair%%=*}=${!var}"); fi
    done
    ;;
esac

run_setup() {
  if pnpm -s oa:setup "${mode_args[@]}" --name "$PROD_NAME" --app-host "$PROD_APP_HOST" \
    --content-host "$PROD_CONTENT_HOST" --owner-email "$PROD_OWNER_EMAIL" 2>&1; then
    echo '{"step":"setup-exit","status":"ok"}'
  else
    echo '{"step":"setup-exit","status":"error"}'
  fi
}

pat='oa_pat_[1-9A-HJ-NP-Za-km-z]{32}'
# ANALYTICS_TOKEN as given and as setup uses it (trimmed): either one leaking aborts.
an_raw="${ANALYTICS_TOKEN:-}"
an_trim="${an_raw#"${an_raw%%[![:space:]]*}"}"
an_trim="${an_trim%"${an_trim##*[![:space:]]}"}"
leaks() {
  [[ -n "$an_trim" && "$1" == *"$an_trim"* ]] || [[ -n "${an_raw//[[:space:]]/}" && "$1" == *"$an_raw"* ]]
}
bad=0
# preflight only: "not installed" (no D1, R2 and KV, and no Worker) is told apart
# from drift or a partial install by the check lines setup already emits
# (resources: "missing: D1 .., R2 .., KV .."; deploy: "Worker .. never deployed").
# The wrapper owns the call: setup reports per step and has no whole-instance verdict.
all_missing=0 no_worker=0 step_err=0
{
  echo "| step | status |"
  echo "|---|---|"
} >>"$summary"

while IFS= read -r line; do
  if [[ "$line" =~ $pat ]] || leaks "$line"; then
    echo "token pattern found in output; aborting" >&2
    exit 1
  fi
  echo "$line"
  step=$(jq -r '.step // "?"' <<<"$line" 2>/dev/null || echo "?")
  status=$(jq -r '.status // empty' <<<"$line" 2>/dev/null || true)
  [[ -z "$status" ]] && continue
  echo "| $step | $status |" >>"$summary"
  case "$status" in error | action_required)
    bad=1
    [[ "$step" == setup-exit ]] || step_err=1 # strict's exit 2 alone is not a step error
    ;;
  esac
  if [[ "$step" == resources && "$status" == todo ]]; then
    msg=$(jq -r '.message // ""' <<<"$line" 2>/dev/null || true)
    [[ "$msg" == *"missing: D1 "*", R2 "*", KV "* ]] && all_missing=1
  fi
  if [[ "$step" == deploy && "$status" == todo ]]; then
    msg=$(jq -r '.message // ""' <<<"$line" 2>/dev/null || true)
    [[ "$msg" == *"never deployed"* ]] && no_worker=1
  fi
done < <(run_setup)

if [[ "$mode" == preflight ]]; then
  if ((all_missing && no_worker && !step_err)); then
    msg="not installed: run the Ops - prod install workflow first"
    echo "{\"step\":\"preflight\",\"status\":\"skipped\",\"message\":\"$msg\"}"
    echo "| preflight | skipped ($msg) |" >>"$summary"
    echo "::notice::prod $PROD_NAME $msg; skipping upgrade and cleanup"
    echo "installed=false" >>"${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  echo "installed=true" >>"${GITHUB_OUTPUT:-/dev/null}"
fi
exit "$bad"
