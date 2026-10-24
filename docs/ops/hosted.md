# Hosted (Workers for Platforms)

Planned runbook. The spike below (P1 Task 1) ran on 2026-10-21 in the throwaway namespace
`oa-spike-staging` on the shared account 26ac34…, then was deleted.

## Limits

| Resource | Limit | Consequence |
|---|---|---|
| Scripts per dispatch namespace | **Unlimited** ([WfP limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/limits/), checked 2026-10-21) | No account slot math: the 500-scripts-per-account cap and the "refuse under 50 free" rule applied to plan B only and are gone. Namespace scripts are not listed under `/workers/scripts`. |
| Durable Object namespaces | No WfP limit | One class per install is fine. |
| D1 per account | 50,000 databases, 10 GB each, 1 TB total (raisable) | ~100 installs at the cap. |
| R2 per account | 1,000,000 buckets | No constraint. |
| KV per account | **1,000 namespaces** | **Still caps hosted at ~1,000 installs** (one `OAUTH_KV` each). M2 item (D1-backed shim). |
| Cloudflare API | 1,200 requests / 5 min per token | A create is ~15 calls; upgrade waves must budget. |
| Tags per script | 8 | We set 2 (`<id>`, `v<version>`). |
| Unsupported in user Workers | `caches.default`, `request.cf` (needs trusted mode), gradual deployments | The server uses none of them; every upgrade goes to 100% at once. |
| Rate limiting | `namespace_id` is **account-wide** and unique; `limit` counts per Cloudflare location, so bursts can exceed it; `period` is 10 or 60 | Per-install blocks (`1000000×env + 8×seq`) keep tenants apart. |

## Task 1 spike: results (2026-10-21)

Namespace `oa-spike-staging`, dispatch Worker `oa-s-spike-dispatch` (account script, `dispatch_namespace` binding), real `apps/server` 0.22.0 bundle uploaded as `oa-s-ispike000001`.

| # | Check | Result |
|---|---|---|
| 1 | Dispatch namespaces API | Was 403 ("contact the account manager") on 2026-10-21; now 200 with an empty list. `POST` creates a namespace. WfP is enabled. |
| 2 | `scheduled()` through a namespace binding | **Works.** A tiny user Worker wrote a KV stamp; `env.DISPATCHER.get("spike-user").scheduled({cron, scheduledTime})` ran the handler (KV `scheduled` = `{at, cron:"17 3 * * *"}`). Re-run against the real server script: no throw. Task 7's primary path stands; the signed `/__oa/nightly` route is no longer needed. |
| 3 | Real bundle with every template binding + assets | **Accepted, 27 bindings live**: plain_text vars, `d1`, `r2_bucket`, `kv_namespace`, `durable_object_namespace`, `ratelimit` (`1000008`), `browser`, `send_email`, `assets`, `service` (to an account Worker), `secret_text` ×2. `GET …/settings` lists all of them with the right types. |
| 4 | Assets upload | Session: `POST …/dispatch/namespaces/{ns}/scripts/{name}/assets-upload-session` with `{manifest: {"/path": {hash, size}}}`; **hash is the first 32 hex chars of SHA-256** (64 is rejected: "file hash size of 64 is too large"). Upload `POST …/accounts/{id}/workers/assets/upload?base64=true` (account path, not namespace) with `Authorization: Bearer <session jwt>` and base64 string parts; **202 while buckets remain, 201 with the jwt on the completing bucket**. That jwt goes in `metadata.assets.jwt`. 120 files / 3 buckets. |
| 5 | `keep_assets` without a jwt | **Accepted** (200), assets still served afterwards (`/` → 200, SPA HTML). |
| 6 | Durable Object `new_sqlite_classes` in a namespace | **Works.** Upload with `migrations: {new_tag:"v1", steps:[{new_sqlite_classes:[…]}]}`; then a namespace script instantiated the DO twice and persisted state (`n=1`, `n=2`). |
| 7 | Durable Object migration tag, read back | **Not exposed.** `GET …/scripts/{name}/settings` (account *and* namespace) returns `migration_tag: null` right after a successful migration. Re-uploading a migration that is already applied either 412s with `"expected tag is 'vX'"` (wrong or missing `old_tag`) or 400s with "already depended on by existing Durable Objects". An upload with **no** `migrations` is 200. |
| 8 | `ratelimit` at runtime | **Works** on a namespace script with a custom `namespace_id`: a 3/60 s limiter returned `{success:false}` on the 6th request. Counters are per Cloudflare location, so a client hitting several colos can exceed the limit. |
| 9 | `service` binding from a namespace script to an account Worker | **Works** (called, got the peer's response). P2's broker can use it. |
| 10 | `browser` binding | **Accepted as `type: "browser"`** (as wrangler sends; `browser_rendering` is not needed) and listed as `browser` in settings. Not exercised at runtime (no screenshot route hit). |
| 11 | `send_email` binding | **Accepted**, listed as `EMAIL`. Not exercised: sending needs a verified sender domain for the install's `noreply@<slug>.mail.<app-domain>`. |
| 12 | Script subdomain API on a namespace script | `POST …/dispatch/namespaces/{ns}/scripts/{name}/subdomain` → **405 method_not_allowed**. Namespace scripts have no workers.dev subdomain, so the `{enabled:false, previews_enabled:false}` call is account-target only. |
| 13 | Routing: wildcard DNS + wildcard Worker route | **Works.** Proxied `*` AAAA on `open-artifacts-staging.app` + route `*.open-artifacts-staging.app/*` → the dispatch Worker. Certificate issued without extra steps. Mapped host served the real install (`/healthz` 200 `{ok:true,plan:"paid",version:"0.22.0"}`, `/` 200); an unmapped subdomain got the dispatch Worker's own 404; the apex has no record (needs one for the platform page). |
| 14 | Namespace scripts and the account script list | The 4 spike namespace scripts did **not** appear in `/accounts/{id}/workers/scripts`; only the dispatch Worker did. |

### Rulings

1. **Task 7 uses `DISPATCHER.get(id).scheduled(...)`.** The signed nightly route (plan B) is dropped from M1. Keep the route contract with Backend parked for M2.
2. **Task 4's `doMigrationTag` read has no supported API.** Read it once with the 412 probe (upload with the planned `old_tag`; parse `expected tag is '<tag>'` from the 412) or record it in `installs` on our own uploads and reconcile with the same probe on resume. Either way, an upload whose live tag already equals the target must send **no** `migrations`; a resume after a successful migration otherwise fails (400/412).
3. **Task 4 `scriptSubdomainSettings()` only for `target: "account"`.** Skip it for namespace scripts (405).
4. **Routing is a wildcard route, not per-install Custom Domains.** One proxied `*` record and one `*.open-artifacts-<env>.<tld>/*` route per env pointing at the dispatch Worker; the Workers Custom Domains path (and its DNS Edit permission need) goes away from M1.
5. **Task 3 metadata: `type: "browser"` stands; assets hash is 32 hex chars**; the `assets.jwt` flow is as in row 4.
6. **`/healthz` does not report `installId` yet** (0.22.0 returns `{ok, plan, version}`). The create health check can only confirm version today; Backend's `INSTALL_ID` in healthz (Task 6b) is needed before create can verify identity.
7. **Unproven at runtime:** `send_email` delivery (needs sender onboarding) and `browser` rendering. Both bindings are accepted and bound.

## Runbook skeleton

- Per env: one dispatch namespace (`oa-staging`, `oa-prod`), one dispatch Worker with the `dispatch_namespace` binding, one wildcard DNS record and wildcard route per tenant domain pair, platform D1 + `HOSTS` KV, `BROKER_REGISTRY`, the scheduler.
- Create/upgrade/delete: see `@oa/provision` and the P1 plan tasks 4/5/8.
- Nightly: the scheduler calls `DISPATCHER.get(id).scheduled(...)` for every `active` install, 10 at a time, 25 s each.
- Tokens: per-env provisioning token (Workers Admin + KV/R2/D1 Edit account-wide) and per-env zone tokens (Zone Read, DNS Edit, Workers Routes Edit on the env's two zones), each ≤ 30 days and verified before any write.
- Provisioning tokens must be **user-owned** (created under My Profile > API Tokens), not account-owned. The provisioner (`cfClient().tokenVerify`, which the CLI uses) checks the token with `GET /user/tokens/verify`, and that endpoint refuses account-owned tokens. An account-owned token would need `GET /accounts/{account_id}/tokens/verify` instead, which the CLI does not call.
- The provisioning token also needs **Account > Turnstile > Read**, so `create` can check the env's widget. **Turnstile > Edit** is needed only for the one-time `oa:hosted turnstile-init --env <env>` (Task 8).
- Turnstile: one widget per env, not per install. It is named `oa-s-turnstile` or `oa-p-turnstile`, and its domains are exactly `[open-artifacts-staging.app]` or `[open-artifacts.app]` (a hostname covers its subdomains). Its sitekey and secret are kept in the keychain item `oa-hosted-<env>-turnstile`. When codes are on (`AUTH_PROVIDERS` includes `email`, or `EMAIL_CODE_DOMAIN=on`), `create` reads the widget (GET only) and uploads `TURNSTILE_SITE_KEY` as a var and `TURNSTILE_SECRET` as `secret_text`.
- Release records: `create` uploads and applies only the release's own files, never the local checkout. Those files are the modules, the assets, the server template, the D1 migrations and the Welcome artifact text. Each one is checked against the release record. The record names its `env` and `version`, and is signed with Ed25519 over `"oa-release-v1\n" + env + "\n" + canonicalJson(record)`, then verified against `RELEASE_PUBKEY[env]`. A downgrade below an install's current version is refused.
- Gates: `PROD_UNLOCKED`, `ALLOW_ACCOUNT_TARGET`, `RELEASE_PUBKEY` and `FLOOR_MIN_SEQ` are code constants in `packages/provision/src/internal/gates.ts`. The package does not export them, and no option can set them. Prod stays locked (`ProdLocked`) until a separate one-line PR, after the key ceremony, sets the real per-env public keys and flips `PROD_UNLOCKED`.

## Dispatch Worker: one-time deploy per env (Task 6, gated)

`apps/dispatch` maps the request host (lowercased, one trailing dot stripped, port ignored) to an install id in `HOSTS` and forwards the original request to `oa-<p>-<id>` in the env's dispatch namespace. A miss, a value that isn't an install id, a KV or binding error, a deleted script and a crashing install all get the same plain `404 Not found`. On an error it logs `dispatch failed <category> <host>`, where category is `kv`, `not_found` (no such script) or `exception`. It never logs the error text, the URL or headers. Observability (Workers Logs) is off in each env and must stay off, because it would record full URLs.

The repo config has no routes, custom domains or `workers.dev`, and no top-level name, so a deploy without `--env` is refused (tests pin all of it). Routing is wired once per env by this step. **The Manager and the user run it by hand; CI never does.**

| Env | Worker | Namespace | HOSTS KV title | Config placeholder |
|---|---|---|---|---|
| staging | `oa-s-dispatch` | `oa-staging` | `oa-s-hosts` | `{{HOSTS_KV_ID_STAGING}}` |
| prod | `oa-p-dispatch` | `oa-prod` | `oa-p-hosts` | `{{HOSTS_KV_ID_PROD}}` |

The four routes (two per env, one per tenant zone):

| Env | Zone | Route | Worker |
|---|---|---|---|
| staging | `open-artifacts-staging.app` | `*.open-artifacts-staging.app/*` | `oa-s-dispatch` |
| staging | `open-artifacts-staging.page` | `*.open-artifacts-staging.page/*` | `oa-s-dispatch` |
| prod | `open-artifacts.app` | `*.open-artifacts.app/*` | `oa-p-dispatch` |
| prod | `open-artifacts.page` | `*.open-artifacts.page/*` | `oa-p-dispatch` |

**Platform hosts on the tenant zones** (the auth broker at `auth.<app zone>`, and any later one) must be attached as a Custom Domain, which takes precedence over routes, or as an exact route (`auth.$APP/*`). Never rely on a wildcard. Attach them before or with step 6, because the wildcard route sends anything unattached to dispatch, which returns 404. Their slugs are reserved (`RESERVED_SLUGS`), so no install can hold them.

Steps, per env. Set only `ENV`; everything else is derived from it:

```sh
case "$ENV" in
  staging) P=s; APP=open-artifacts-staging.app; PAGE=open-artifacts-staging.page ;;
  prod)    P=p; APP=open-artifacts.app;         PAGE=open-artifacts.page ;;
  *) echo "ENV must be staging or prod" >&2; exit 1 ;;
esac
UP=$(printf %s "$ENV" | tr a-z A-Z)
```

1. Preconditions: the namespace `oa-$ENV` and the `oa-$P-hosts` KV namespace exist (create's preflight needs both anyway).
2. Build from a clean checkout of the reviewed commit. `@oa/provision/names` resolves to `packages/provision/src/names.ts` under wrangler (the `workerd` export condition), so the bundle never uses a stale `dist`. The build is still needed for the typecheck and tests:
   ```sh
   git status --porcelain | grep -q . && { echo "dirty checkout" >&2; exit 1; }
   pnpm install --frozen-lockfile && pnpm --filter @oa/provision build && pnpm --filter @oa/dispatch test
   ```
3. Deploy with the provisioning token. Fill only this env's placeholder into a gitignored copy of the config, deploy it, then remove the copy:
   ```sh
   cd apps/dispatch
   HOSTS_ID=$(pnpm exec wrangler kv namespace list | jq -r --arg t "oa-$P-hosts" '.[] | select(.title == $t) | .id')
   test -n "$HOSTS_ID" \
     && sed "s/{{HOSTS_KV_ID_$UP}}/$HOSTS_ID/" wrangler.jsonc > wrangler.deploy.jsonc \
     && pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env "$ENV" \
     && rm wrangler.deploy.jsonc
   ```
   Then check that the deployed binding is the right namespace: the Worker's `HOSTS` id must be the namespace titled `oa-$P-hosts`. `CF_ACCOUNT_ID` is the hosted account's id, and `CF_API_TOKEN` is the env's provisioning token read from the keychain (never echoed):
   ```sh
   CF_ACCOUNT_ID=<the hosted account id>
   CF_API_TOKEN=$(security find-generic-password -s "oa-hosted-$ENV" -w)
   BOUND=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/oa-$P-dispatch/settings" \
     | jq -r '.result.bindings[] | select(.name == "HOSTS") | .namespace_id')
   TITLE=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces/$BOUND" | jq -r .result.title)
   test "$TITLE" = "oa-$P-hosts" || { echo "HOSTS bound to $TITLE" >&2; exit 1; }
   ```
   The deploy output must name `oa-$P-dispatch` with `DISPATCHER (oa-$ENV)`, `HOSTS` and `OA_ENV ("$ENV")`, and no routes or workers.dev URL.
4. Create a short-lived zone token (expires within the day), scoped to the env's two zones only, with Zone Read, Zone Settings Edit, DNS Edit and Workers Routes Edit. Verify it (`GET /user/tokens/verify`) before any write.
5. HTTPS hardening, on each of the two zones (`PATCH /zones/<zone_id>/settings/<name>`): `ssl` = `strict` (Full (strict)), `always_use_https` = `on`, `min_tls_version` = `1.2`. Turn on HSTS (`security_header`) once every host on the zone is confirmed HTTPS-only; it is hard to undo.
6. On each of the two zones, add one proxied wildcard record, `AAAA * 100::` with `proxied: true` (`POST /zones/<zone_id>/dns_records`); refuse if a `*` record already exists that isn't this one. Then add the route (`POST /zones/<zone_id>/workers/routes`): `{"pattern": "*.$APP/*", "script": "oa-$P-dispatch"}` on the app zone and `{"pattern": "*.$PAGE/*", "script": "oa-$P-dispatch"}` on the page zone.
7. Revoke the zone token.
8. Check, on both zones:
   ```sh
   for Z in "$APP" "$PAGE"; do
     for H in "nope.$Z" "www.$Z" "$Z"; do
       test "$(curl -sS -o /tmp/body -w '%{http_code}' "https://$H/")" = 404 && test "$(cat /tmp/body)" = "Not found" \
         || echo "FAIL https://$H/"
     done
     test "$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "http://nope.$Z/")" = "301 https://nope.$Z/" \
       || echo "FAIL http://nope.$Z/ does not redirect to https"
   done
   curl -sS -o /dev/null -w '%{http_code}\n' "https://auth.$APP/"   # the broker's answer, not dispatch's 404 "Not found"
   ```
   The bare apex has no record from this step, so it may fail to resolve instead of returning 404. Either result is fine; reaching an install is not. Task 9's smoke then checks a real install's host on each zone.
9. CPU, after some traffic: CPU time for `oa-$P-dispatch` must stay under 1 ms at both p50 and p99 (Global Constraints). Read it from the GraphQL Analytics API (`workersInvocationsAdaptive`, `filter: { scriptName: "oa-$P-dispatch" }`, `quantiles { cpuTimeP50 cpuTimeP99 }`, in microseconds), or the Worker's Metrics tab. It can't be measured locally, because workerd's clock doesn't advance without I/O.

Unmapping and slug purges: dispatch reads HOSTS with `cacheTtl: 60`, so an edge can serve a removed mapping for up to about 60 s plus KV propagation. `delete` deletes the user script right after the unmap (`packages/provision/src/wfp.ts`: HOSTS keys at line 2792, script at line 2804, then KV, R2 and D1), so a stale mapping hits a missing script and gets the 404, not a half-deleted install. **A slug purge (freeing a deleted install's hosts for reuse) must wait at least 2 minutes after the unmap**, so no edge still maps the host to the old id when a new install takes it.

## Hosted release files (T3b)

- The stored record is `{ "record": "<canonicalJson(record)>", "signature": "<base64url>" }`. The signature covers `"oa-release-v1\n" + env + "\n" + record` (the exact string). Readers verify that string, parse it refusing duplicate keys (objects built with a null prototype), and require it to re-serialize byte for byte.
- CI signs and never uploads to Cloudflare. On a stable release, `release-please.yml` runs `hosted-guard` (tag to one commit on `main`, equal to `package.json`), `hosted-build` (both variants and the release files, `manifest.json`), `hosted-check` (every hash, `check-no-test-hooks` on the release bundle), `hosted-sign-staging` and `hosted-sign-prod` (environments `hosted-staging` and `hosted-prod`; checkout and download-artifact only, the runner's own node on plain `.mjs` (node:* imports, no install), key on stdin) and `hosted-attach-staging` / `hosted-attach-prod` (each rebuilds its env's tars and `.sig.json` files, verifies them and attaches them to the GitHub release; refused if that env's assets are already there).
- `publishRelease` (laptop, provisioning token; Task 8 wires the CLI) verifies a tar and its `.sig.json` against `RELEASE_PUBKEY[env]` and copies exactly those bytes to `oa-<p>-releases/releases/<version>/<variant>/`, every object `If-None-Match: *`. A version is never overwritten; a partial one (objects byte-identical to the tar, no record) is resumed. `publishRelease` and `publishFloor` first need `probeR2Conditionals(cf, env)` to pass in the same process (it proves the REST object routes enforce `If-None-Match` and `If-Match`).
- The key ceremony's one-line PR sets the public keys in both `packages/provision/src/internal/gates.ts` and `scripts/ci/release-pubkeys.mjs` (a test pins them equal); the key jobs then refuse a signing key that is not the pinned one.
- The signed floor `releases/floor.json` (`{ env, seq, minVersion, revoked }`, signed over `"oa-release-floor-v1\n" + env + "\n"` plus the record) gates `create`. The platform D1 `release_floor.floor_seq` is only a cache (raised with `MAX`); the anchor is `FLOOR_MIN_SEQ[env]`. `publishFloor` needs a higher `seq`, the same or a higher `minVersion` and a superset of `revoked`, and writes with `If-Match`.

### Key-ceremony checklist (per env, with the user's OK)

1. Confirm the controls on GitHub (all must hold; the script below refuses otherwise):
   - Environments `hosted-staging` and `hosted-prod`: deployment branches `main` only (a custom branch policy that is exactly the branch `main`, not protected branches, not a pattern). This is the real control against a `workflow_dispatch` from another ref reaching the key. Check with `gh api repos/{repo}/environments/hosted-<env>` and `gh api repos/{repo}/environments/hosted-<env>/deployment-branch-policies`.
   - Each Environment has a required reviewer, and admin bypass is OFF (`can_admins_bypass: false`).
   - Two tag rulesets are active on `refs/tags/v*` (nothing excluded). Ruleset A restricts creation, and its only bypass actor is the release App (its numeric id, `RELEASE_APP_ID`). Ruleset B restricts update and deletion with no bypass actor at all, so not even the App can move or delete a release tag. Check with `gh api repos/{repo}/rulesets` and each tag ruleset's `gh api repos/{repo}/rulesets/<id>`.
2. Generate the Ed25519 keypair locally and pipe the private key straight into `RELEASE_APP_ID=<id> scripts/ops/hosted-set-signing-key.sh <env>` (never onto disk). The script runs the `gh api` reads above and refuses the upload unless every control holds; only then does it `gh secret set RELEASE_SIGNING_KEY --env hosted-<env>` from stdin.
3. Put the public key (JWK `x`) in both `packages/provision/src/internal/gates.ts` and `scripts/ci/release-pubkeys.mjs` in one PR (a test pins them equal); flip `PROD_UNLOCKED` there for prod.

### First-create checklist (per env)

1. Apply every platform D1 migration to `oa-<p>-platform`, in order: `apps/platform-db/migrations/0001_installs.sql`, then `0002_release_floor.sql` (the `release_floor` cache), then `0003_lifecycle.sql` (per-version metadata, the operation lock and the session-cut journal). Without 0002, create fails closed on the floor_seq read; without 0003, create fails closed on its first metadata write.
2. Key ceremony done: `RELEASE_PUBKEY[env]` set in gates.ts (and `PROD_UNLOCKED` for prod).
3. Sign the env's first floor with the `hosted-floor` workflow (dispatch on `main`: `env`, `seq` >= `FLOOR_MIN_SEQ[env]`, `min_version`, `revoked`), download its `floor-<env>-<seq>` artifact, and `publishFloor` it.
4. `publishRelease` the signed tar and `.sig.json` from the GitHub release for each variant the env takes.

### Release checklist: revoking a version or raising the floor

1. For each env, dispatch the `hosted-floor` workflow on `main` (next `seq`, `min_version`, `revoked` keeping every earlier entry), download the `floor-<env>-<seq>` artifact and run `publishFloor` with it.
2. In the same change, bump `FLOOR_MIN_SEQ[env]` in `packages/provision/src/internal/gates.ts` to the new `seq`, so a replayed older floor is refused even if the D1 cache was reset.
3. Merge and release; creates refuse any floor below the new anchor.

### Leases and recovery (Task 5)

- Every create, upgrade, rollback, var change, Turnstile rotation and delete holds the install row's lease (`installs.lease`, `lease_until`, 30 minutes, renewed before each step). A second operation on the same install is refused while the lease is live. `status(id)` shows the state, the versions, `lease_until` and any pending session cut without taking the lease.
- Use one `WfpProvisioner` per concurrent operation. A second operation started on an instance that is already running one is refused.
- **After a `<op>.lost_lease` audit row** (the operation stopped with "lost the lease"), check `status(id)`. After `create.lost_lease`, re-run `delete(id, confirm: id)` if the install should go, or re-run create to resume it. Either one claims the row only once the other operation's lease has ended.
- **The lease has a time-of-check to time-of-use window.** An operation renews its lease and then makes its Cloudflare call. If the process stalls for longer than the lease between the two (for example, a laptop sleeps), another operation can claim the row in the meantime, and the stalled call still lands once. Example: a create's `HOSTS` put lands after a delete has unmapped the hosts. The stalled operation's next step raises `LostLease`, so it goes no further. A stale `HOSTS` entry left this way points only at the deleted install's id, never at another install: the dispatch Worker finds no script and answers 404. To clear it, re-run delete, which removes the `HOSTS` keys first.
- **A pending session cut** (`status(id).sessionCut.pending`) means google was turned on and the epoch bump that ends earlier sessions has not run yet. Re-run `updateVars` with the intended vars; any upgrade or rollback also settles it right after its upload. Rotation refuses while a cut is pending.
- A lease left by a dead process: `releaseLease(id, confirm: id)` once it has expired, or with `force: true` only when you are sure nothing is running. Both are audited.
