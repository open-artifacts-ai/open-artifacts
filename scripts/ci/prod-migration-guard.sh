#!/usr/bin/env bash
# The prod deploy's guard for a non-additive D1 migration (a table rebuild).
# A marked migration needs a Worker version and D1 bookmark before upgrade.
# After upgrade, compare the applied migration names to the release tag.
# Restore runs only with an explicit choice for this release.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${GITHUB_OUTPUT:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
MARK="-- oa:non-additive"

wr() {
  if [ -n "${WRANGLER:-}" ]; then "$WRANGLER" "$@"; else pnpm --filter @oa/server exec wrangler "$@"; fi
}
case "${1:-}" in
  detect)
    : "${TAG:?}"
    # Any doubt holds: prod's running version unknown or not a release, a git
    # error, an unreadable file.
    hold() {
      echo "hold=true" >> "$out"
      echo "guarded=false" >> "$out"
      # One line: the workflow's final step fails the job with it (#2257).
      echo "reason=$(printf '%s' "$1" | tr '\r\n' '  ')" >> "$out"
      echo "::warning title=Prod deploy held::$1"
      echo "**Prod deploy held:** $1" >> "$summary"
      exit 0
    }
    # Compare with what prod RUNS (its /healthz version, PROD_VERSION), never
    # with the release before TAG: a held release never reaches prod, so the
    # next one must still count its migrations (0.73.0 shipped 0017 unguarded
    # after 0.72.0 was held).
    running="${PROD_VERSION:-}"
    [[ "$running" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      hold "could not read the version prod runs (got '${running:0:40}')"
    prev="v$running"
    git -C "$root" rev-parse -q --verify "refs/tags/$prev" > /dev/null ||
      hold "prod runs $running, which has no release tag $prev to compare migrations with"
    git -C "$root" rev-parse -q --verify "refs/tags/$TAG" > /dev/null ||
      hold "no release tag $TAG"
    added="$(git -C "$root" diff --name-only --diff-filter=A "$prev" "$TAG" -- 'apps/server/migrations/*.sql')" ||
      hold "could not list the migrations $TAG adds"
    # An already-shipped server migration must never change: installs record
    # applied migrations by name, so an edit never reaches a deployed database.
    changed="$(git -C "$root" diff --name-only --diff-filter=MDRT "$prev" "$TAG" -- 'apps/server/migrations/*.sql')" ||
      hold "could not list the migrations $TAG changes"
    if [ -n "$changed" ]; then
      names="$(printf '%s' "$changed" | tr '\n' ' ')"
      hold "$TAG changes an already-deployed server migration (${names% }); add a new migration instead"
    fi
    # Validate the released files against the same policy that reviewed the PR.
    validation="$(python3 "$root/scripts/ci/check-migration-marker.py" "$root" "$prev" apps/server/migrations "$TAG" 2>&1)" ||
      hold "migration review check failed for $TAG: $validation"
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
      echo "no non-additive migration in $TAG (since $prev, which prod runs)"
      exit 0
    fi
    echo "non-additive migration(s) in $TAG: ${marked[*]}"
    echo "hold=false" >> "$out"
    echo "guarded=true" >> "$out"
    ;;
  record)
    : "${PROD_NAME:?}"
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
    : "${PROD_NAME:?}" "${TAG:?}"
    expected="$(git -C "$root" ls-tree --name-only "refs/tags/$TAG:apps/server/migrations" | LC_ALL=C sort | sed -n '/\.sql$/p')"
    [ -n "$expected" ] || { echo "release migration list is empty" >&2; exit 1; }
    applied="$(wr d1 execute "$PROD_NAME" --remote --json --command 'SELECT name FROM d1_migrations ORDER BY name' |
      jq -er 'if length == 1 and .[0].success == true then .[0].results[].name else error("migration list unavailable") end')"
    [ "$applied" = "$expected" ] || { echo "applied migration list differs from $TAG" >&2; exit 1; }
    ;;
  restore)
    : "${PROD_NAME:?}" "${WORKER_VERSION:?}" "${BOOKMARK:?}"
    echo "::error title=Prod restore::verification failed: rolling the Worker back to $WORKER_VERSION and D1 to bookmark $BOOKMARK"
    # The restore discards every write made since the bookmark (accepted for
    # this release: the user's yes covers it).
    echo "**Restoring:** this discards every write made to $PROD_NAME since bookmark \`$BOOKMARK\`." >> "$summary"
    wr rollback "$WORKER_VERSION" --name "$PROD_NAME" --message "non-additive migration failed verification" --yes
    wr d1 time-travel restore "$PROD_NAME" --bookmark "$BOOKMARK" --json > /dev/null
    echo "**Restored:** Worker $WORKER_VERSION and D1 bookmark \`$BOOKMARK\`." >> "$summary"
    ;;
  *)
    echo "usage: prod-migration-guard.sh detect|record|verify|restore" >&2
    exit 2
    ;;
esac
