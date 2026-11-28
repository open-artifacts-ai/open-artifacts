#!/usr/bin/env bash
# The CI e2e job (no secrets; the real suite runs a local `wrangler dev` only).
#   e2e.sh version  -> playwright=<version of @oa/dashboard's @playwright/test> to $GITHUB_OUTPUT
#   e2e.sh install  -> checks the Playwright image matches the pinned version, then
#                      Chromium and WebKit (a no-op: the image has them and their OS deps)
#   e2e.sh hosts    -> app.localhost and content.localhost resolve to 127.0.0.1
#   e2e.sh mock|real -> one suite, html report in playwright-report/<suite>; with
#                      E2E_SHARD=i/n (CI matrix) only that shard, as a blob report in
#                      blob-report/<suite>/ for the e2e job's merge
#   e2e.sh spaces    -> the real-server suite with spaces on (its own server); with
#                      E2E_SHARD set, whole, as a blob for the merge
#   e2e.sh merge     -> merges the shards' blob reports (mock, real, spaces) into
#                      playwright-report/<suite>
#   e2e.sh ui       -> @oa/ui real-browser checks (axe contrast, focus outlines)
#   e2e.sh landing  -> landing real-browser checks (no horizontal overflow)
#
# Smoke mode: on a pull request (GITHUB_EVENT_NAME exactly "pull_request") the
# mock and real suites run only the tests tagged @smoke (the happy path: sign
# in, library, viewer, publish, share, comment, ask, doc edit, guest), real on
# Chromium only, and spaces, ui and landing do not run. Any other value, an
# empty or missing one, a local run, the merge queue and a dispatch run the
# whole suite. A smoke run first counts its selection with `playwright test
# --list` (same config and project, no --shard) and fails when the count is 0 or
# cannot be read. Playwright itself exits 0 for an empty `--grep` with
# `--shard`, so its "No tests found" is not the guard.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hosts_file="${HOSTS_FILE:-/etc/hosts}"
blob_dir="${E2E_BLOB_DIR:-$root/apps/dashboard/blob-report}"
smoke=false
[ "${GITHUB_EVENT_NAME:-}" = pull_request ] && smoke=true

# Smoke: the number of tests the run would select, or a failure. Reads the JSON
# list (specs, at any depth); any error or unreadable output fails the run.
require_smoke_tests() {
  local out n
  if ! out="$(pnpm --filter @oa/dashboard exec playwright test "$@" --list --reporter=json 2> /dev/null)"; then
    echo "e2e: could not list the @smoke tests; failing (no smoke run without a readable selection)" >&2
    exit 1
  fi
  if ! n="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const c=(s)=>(s.specs||[]).length+(s.suites||[]).reduce((a,x)=>a+c(x),0);const n=(j.suites||[]).reduce((a,s)=>a+c(s),0);if(!Number.isInteger(n))process.exit(1);console.log(n)' <<< "$out" 2> /dev/null)"; then
    echo "e2e: the @smoke test list is unreadable; failing" >&2
    exit 1
  fi
  if [ "$n" -lt 1 ]; then
    echo "e2e: the @smoke selection is empty (0 tests); failing. Tag tests with { tag: \"@smoke\" }." >&2
    exit 1
  fi
  echo "e2e: $n @smoke tests selected"
}

# Suites with no @smoke test do not run on pull requests.
skip_in_smoke() {
  if [ "$smoke" = true ]; then
    echo "e2e $1: not part of the pull request smoke (the merge queue runs it)"
    exit 0
  fi
}

case "${1:-}" in
  version)
    v="$(node -p "require('$root/apps/dashboard/node_modules/@playwright/test/package.json').version")"
    echo "playwright=$v" >> "$GITHUB_OUTPUT"
    ;;
  install)
    # CI runs in mcr.microsoft.com/playwright:v<version>-noble. A mismatch would
    # download other browsers and miss their OS deps, so fail fast instead.
    v="$(node -p "require('$root/apps/dashboard/node_modules/@playwright/test/package.json').version")"
    if [ -n "${PLAYWRIGHT_IMAGE_VERSION:-}" ] && [ "$v" != "$PLAYWRIGHT_IMAGE_VERSION" ]; then
      echo "@playwright/test is $v but the CI image is $PLAYWRIGHT_IMAGE_VERSION; bump the e2e image in ci.yml" >&2
      exit 1
    fi
    pnpm --filter @oa/dashboard exec playwright install chromium webkit
    ;;
  hosts)
    # systemd-resolved already maps *.localhost; this makes it independent of the resolver.
    # Root in the CI container (no sudo there); sudo elsewhere.
    sudo=sudo
    [ "$(id -u)" = 0 ] && sudo=
    grep -q "app.localhost content.localhost" "$hosts_file" ||
      echo "127.0.0.1 app.localhost content.localhost" | $sudo tee -a "$hosts_file" > /dev/null
    ;;
  mock | real)
    suite=$1
    if [ "$suite" = mock ]; then
      pnpm --filter @oa/shared --filter @oa/runtime build
      PLAYWRIGHT_BLOB_OUTPUT_FILE="$blob_dir/$suite/shard-${E2E_SHARD%/*}.zip" \
        pnpm --filter @oa/dashboard exec playwright test e2e/doc-version-keeps-editor.spec.ts \
        --repeat-each=20 --retries=0 --reporter=list,blob
      exit 0
    fi
    args=()
    # The mock suite's pin-bubbles spec serves the built runtime in a stand-in
    # frame (#2019): build it first, as the dist integration tests do.
    [ "$suite" = mock ] && pnpm --filter @oa/shared --filter @oa/runtime build
    [ "$suite" = real ] && args+=(-c playwright.real.config.ts)
    if [ "$smoke" = true ]; then
      args+=(--grep @smoke)
      # The real config also has a webkit project; the smoke runs Chromium only
      # (the mock config has no projects).
      [ "$suite" = real ] && args+=(--project chromium)
      echo "e2e $suite: smoke (@smoke only), pull request"
      # Counted without --shard and reporters: the run's own arguments only.
      require_smoke_tests ${args[@]+"${args[@]}"}
    fi
    if [ -n "${E2E_SHARD:-}" ]; then
      # One file per shard and suite, so the merge sees every shard.
      PLAYWRIGHT_BLOB_OUTPUT_FILE="$blob_dir/$suite/shard-${E2E_SHARD%/*}.zip" \
        pnpm --filter @oa/dashboard exec playwright test ${args[@]+"${args[@]}"} \
        --shard="$E2E_SHARD" --reporter=list,blob
    elif [ "$suite" = mock ]; then
      PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/mock \
        pnpm --filter @oa/dashboard exec playwright test ${args[@]+"${args[@]}"} --reporter=list,html
    else
      PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/real \
        pnpm --filter @oa/dashboard exec playwright test ${args[@]+"${args[@]}"}
    fi
    ;;
  merge)
    # Each suite's shards, from the e2e job's downloaded artifacts.
    for suite in mock real spaces; do
      dir="$blob_dir/$suite"
      [ -d "$dir" ] || continue
      PLAYWRIGHT_HTML_OUTPUT_DIR="playwright-report/$suite" \
        pnpm --filter @oa/dashboard exec playwright merge-reports --reporter=html "$dir"
    done
    ;;
  spaces)
    skip_in_smoke spaces
    # Its own server (port 8797, FEATURES=spaces): hosted screens on the real
    # server. Small (one spec): in CI it runs whole in one shard, as a blob.
    if [ -n "${E2E_SHARD:-}" ]; then
      PLAYWRIGHT_BLOB_OUTPUT_FILE="$blob_dir/spaces/shard-${E2E_SHARD%/*}.zip" \
        pnpm --filter @oa/dashboard test:e2e:spaces --reporter=list,blob
    else
      PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/spaces \
        pnpm --filter @oa/dashboard test:e2e:spaces
    fi
    ;;
  ui)
    skip_in_smoke ui
    pnpm --filter @oa/ui test:browser
    ;;
  landing)
    skip_in_smoke landing
    pnpm --filter @oa/landing test:browser
    ;;
  *)
    echo "usage: e2e.sh version|install|hosts|mock|real|spaces|merge|ui|landing" >&2
    exit 2
    ;;
esac
