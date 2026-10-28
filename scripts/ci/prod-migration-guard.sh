#!/usr/bin/env bash
# The prod deploy's guard for a non-additive D1 migration (a table rebuild).
# A migration whose first line is `-- oa:non-additive` holds the automatic
# deploy of its release; a manual run (workflow_dispatch) deploys it guarded:
# record the live Worker version and a D1 Time Travel bookmark, capture the
# database, upgrade, verify; on failure (if the run allows it) roll the Worker
# back, restore D1 to the bookmark and compare against the capture.
#   prod-migration-guard.sh detect   -> hold=, guarded= ($TAG vs the previous stable tag)
#   prod-migration-guard.sh record   -> worker_version=, bookmark=; capture to $GUARD_DIR/before.json
#   prod-migration-guard.sh verify   -> the migration's own verifier against the capture
#   prod-migration-guard.sh restore  -> rollback + restore + recapture and compare
# Env: TAG, EVENT (github.event_name), PROD_NAME (Worker and D1 name),
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, GUARD_DIR, VERIFY_SCRIPT
#   (the migration's verifier: capture/verify --db --out/--in), WORKER_VERSION
#   and BOOKMARK (restore), D1_LIMIT_BYTES (the database size cap, default
#   10 GB: a table rebuild briefly doubles a table). Never prints the token.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${GITHUB_OUTPUT:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
dir="${GUARD_DIR:-${RUNNER_TEMP:-/tmp}/prod-migration-guard}"
verifier="${VERIFY_SCRIPT:-apps/server/scripts/verify-migration.ts}"
MARK="-- oa:non-additive"

wr() {
  if [ -n "${WRANGLER:-}" ]; then "$WRANGLER" "$@"; else pnpm --filter @oa/server exec wrangler "$@"; fi
}
verifier_run() {
  [ -f "$root/$verifier" ] || {
    echo "the migration's verifier $verifier is missing: refusing a guarded deploy without it" >&2
    exit 1
  }
  node --experimental-strip-types --no-warnings "$root/$verifier" "$@"
}

case "${1:-}" in
  detect)
    : "${TAG:?}"
    # Any doubt holds: no previous stable tag, a git error, an unreadable file.
    hold() {
      echo "hold=true" >> "$out"
      echo "guarded=false" >> "$out"
      echo "::warning title=Prod deploy held::$1"
      echo "**Prod deploy held:** $1" >> "$summary"
      exit 0
    }
    prev="$(git -C "$root" tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -A1 -x "$TAG" | sed -n 2p)" ||
      hold "could not find the release before $TAG"
    [ -n "$prev" ] || hold "no stable release before $TAG to compare migrations with"
    added="$(git -C "$root" diff --name-only --diff-filter=A "$prev" "$TAG" -- 'apps/server/migrations/*.sql')" ||
      hold "could not list the migrations $TAG adds"
    marked=()
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # sed reads it all (head could SIGPIPE git and look like an error).
      first="$(git -C "$root" show "$TAG:$f" | sed -n 1p)" || hold "could not read $f"
      if [ "$first" = "$MARK" ]; then marked+=("$f"); fi
    done <<< "$added"
    if [ ${#marked[@]} -eq 0 ]; then
      echo "hold=false" >> "$out"
      echo "guarded=false" >> "$out"
      echo "no non-additive migration in $TAG (since $prev)"
      exit 0
    fi
    echo "non-additive migration(s) in $TAG: ${marked[*]}"
    if [ "${EVENT:-}" != workflow_dispatch ]; then
      hold "$TAG adds a non-additive migration (${marked[*]}); deploy it by hand (workflow_dispatch, tag $TAG) with the guard watching"
    fi
    echo "hold=false" >> "$out"
    echo "guarded=true" >> "$out"
    ;;
  record)
    # The bookmark and the capture are taken back to back (prod stays live):
    # writes between them would make a post-restore recapture differ from the
    # capture. After a restore the compare matches only because the restore
    # also rewinds every write made after the bookmark.
    : "${PROD_NAME:?}"
    mkdir -p "$dir"
    # A rebuild copies each rebuilt table before dropping the old one, so the
    # database briefly needs up to twice its size: refuse if that won't fit.
    limit="${D1_LIMIT_BYTES:-10737418240}"
    size="$(wr d1 info "$PROD_NAME" --json |
      node -e 'const n=JSON.parse(require("fs").readFileSync(0,"utf8")).database_size;if(!Number.isInteger(n))process.exit(3);console.log(n)')" || {
      echo "could not read the database size" >&2
      exit 1
    }
    if [ $((size * 2)) -gt "$limit" ]; then
      echo "the database is $size bytes: a rebuild may need twice that, over the $limit-byte limit; not migrating" >&2
      exit 1
    fi
    version="$(wr deployments list --name "$PROD_NAME" --json |
      node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=d.at(-1)?.versions??[];if(v.length!==1||v[0].percentage!==100)process.exit(3);console.log(v[0].version_id)')" || {
      echo "could not record the live Worker version (not exactly one version at 100%)" >&2
      exit 1
    }
    bookmark="$(wr d1 time-travel info "$PROD_NAME" --json |
      node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8")).bookmark;if(!b)process.exit(3);console.log(b)')" || {
      echo "could not record a D1 Time Travel bookmark" >&2
      exit 1
    }
    verifier_run capture --db "$PROD_NAME" --out "$dir/before.json"
    {
      echo "worker_version=$version"
      echo "bookmark=$bookmark"
    } >> "$out"
    {
      echo "### Before the non-additive migration"
      echo "- Database size: $size bytes (limit $limit)"
      echo "- Worker version: \`$version\`"
      echo "- D1 Time Travel bookmark: \`$bookmark\`"
    } >> "$summary"
    ;;
  verify)
    : "${PROD_NAME:?}"
    verifier_run verify --db "$PROD_NAME" --in "$dir/before.json"
    ;;
  restore)
    : "${PROD_NAME:?}" "${WORKER_VERSION:?}" "${BOOKMARK:?}"
    echo "::error title=Prod restore::verification failed: rolling the Worker back to $WORKER_VERSION and D1 to bookmark $BOOKMARK"
    # The restore discards every write made since the bookmark (accepted for
    # this release: the user's yes covers it).
    echo "**Restoring:** this discards every write made to $PROD_NAME since bookmark \`$BOOKMARK\`." >> "$summary"
    wr rollback "$WORKER_VERSION" --name "$PROD_NAME" --message "non-additive migration failed verification" --yes
    wr d1 time-travel restore "$PROD_NAME" --bookmark "$BOOKMARK" --json > /dev/null
    verifier_run capture --db "$PROD_NAME" --out "$dir/restored.json"
    if cmp -s "$dir/before.json" "$dir/restored.json"; then
      echo "**Restored:** Worker $WORKER_VERSION, D1 at $BOOKMARK; the database matches its pre-migration capture." >> "$summary"
    else
      echo "**Restored, but the database differs from its pre-migration capture.** Page the Manager." >> "$summary"
      echo "::error title=Prod restore::the restored database differs from its pre-migration capture"
      exit 1
    fi
    ;;
  *)
    echo "usage: prod-migration-guard.sh detect|record|verify|restore" >&2
    exit 2
    ;;
esac
