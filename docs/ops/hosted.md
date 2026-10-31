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
| 11 | `send_email` binding | **Accepted**, listed as `EMAIL`. Every install sends from the env's one sender, `noreply@mail.<app-domain>` (staging `mail.open-artifacts-staging.app`, prod `mail.open-artifacts.app`), onboarded once per env in Email Sending (dashboard: Compute › Email Service › Email Sending › Onboard Domain; it adds the `cf-bounce` MX, SPF, DKIM and `_dmarc` records on that subdomain). Not per install: Email Sending onboards each subdomain separately, by hand, and allows 30 per zone. The server names the install in the From display name. Until the env's sender is onboarded, sends fail and email codes are never stored. |
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
- Nightly: the scheduler calls `DISPATCHER.get(id).scheduled(...)` for every `active` install, 6 at a time, 25 s each, 13-minute deadline (see "Nightly scheduler" below).
- Tokens: one user-owned token per env, `CLOUDFLARE_API_TOKEN` in the env's deploy Environment, used for provisioning, the platform deploys and the zones alike (its scopes are listed under "Platform Workers through CI"), verified before any write. Its end date must be at most 30 days out (`WfpOptions.maxTokenDays`, default 30); a token with no end date is refused. The hosted provisioner's own token is separate: the Secrets Store secret `oa-<p>-provision-token` (`oa-s-` on staging, `oa-p-` on prod), bound only by `oa-<p>-provisioner`, with a required end date at most 400 days out (`maxTokenDays: 400`). Within 5 days of a token's expiry, create, upgrade, var changes and Turnstile rotation are refused, with the expiry date: roll it (Cloudflare dashboard > My Profile > API Tokens > Roll), then for the provisioner token paste it into Secrets Store (`oa-<p>-provision-token`), and for the CLI token update `CLOUDFLARE_API_TOKEN` (the deploy Environment in CI, the keychain on a laptop). Rollback, delete and releasing a lease still run, with a WARNING note naming the date, so an incident never waits on a token roll. An expired token fails every operation.
- Provisioning tokens must be **user-owned** (created under My Profile > API Tokens), not account-owned. The provisioner (`cfClient().tokenVerify`, which the CLI uses) checks the token with `GET /user/tokens/verify`, and that endpoint refuses account-owned tokens. An account-owned token would need `GET /accounts/{account_id}/tokens/verify` instead, which the CLI does not call.
- The provisioning token also needs **Account > Turnstile > Read**, so `create` can check the env's widget. **Turnstile > Edit** is needed only for the one-time `oa:hosted turnstile-init --env <env>` (Task 8).
- Turnstile: one widget per env, not per install. It is named `oa-s-turnstile` or `oa-p-turnstile`, and its domains are exactly `[open-artifacts-staging.app]` or `[open-artifacts.app]` (a hostname covers its subdomains). Its sitekey and secret are kept in the keychain item `oa-hosted-<env>-turnstile`. When codes are on (`AUTH_PROVIDERS` includes `email`, or `EMAIL_CODE_DOMAIN=on`), `create` reads the widget (GET only) and uploads `TURNSTILE_SITE_KEY` as a var and `TURNSTILE_SECRET` as `secret_text`.
- Release records: `create` uploads and applies only the release's own files, never the local checkout. Those files are the modules, the assets, the server template, the D1 migrations and the Welcome artifact text. Each one is checked against the release record. The record names its `env` and `version`, and is signed with Ed25519 over `"oa-release-v1\n" + env + "\n" + canonicalJson(record)`, then verified against `RELEASE_PUBKEY[env]`. A downgrade below an install's current version is refused.
- Domain join: hosted installs always get `AUTH_DOMAIN_JOIN=invite`. Provision renders it and refuses `member`, because a tenant's `AUTH_DOMAINS` isn't verified as owned. Unlocking `member` after ownership is proven is #572.
- Gates: `PROD_UNLOCKED`, `ALLOW_ACCOUNT_TARGET`, `RELEASE_PUBKEY` and `FLOOR_MIN_SEQ` are code constants in `packages/provision/src/internal/gates.ts`. The package does not export them, and no option can set them. Prod was locked (`ProdLocked`) until the key ceremony set the real per-env public keys and a separate PR, after the red-line gate passed on staging, flipped `PROD_UNLOCKED` (2026-10-28). Re-locking prod is the same one-line change.

## Dispatch Worker: one-time deploy per env (Task 6, gated)

`apps/dispatch` maps the request host (lowercased, one trailing dot stripped, port ignored) to an install id in `HOSTS` and forwards the original request to `oa-<p>-<id>` in the env's dispatch namespace. A miss, a value that isn't an install id, a KV or binding error, a deleted script and a crashing install all get the same plain `404 Not found`. On an error it logs `dispatch failed <category> <host>`, where category is `kv`, `not_found` (no such script) or `exception`. It never logs the error text, the URL or headers. Observability (Workers Logs) is off in each env and must stay off, because it would record full URLs.

**Broker gates (installs never fetch a broker).** A Worker in the dispatch namespace can't `fetch()` a Worker on a zone Route of the same zone: Cloudflare sends that subrequest to the `100::` origin and it gets a 522 ([custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication)), and WfP user Workers take no service bindings ([bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)). So dispatch binds both brokers (`AUTH_BROKER` → `oa-<p>-auth-broker`, `DIRECTORY_BROKER` → `oa-<p>-directory-broker`) and passes each mapped request two `BrokerGate` stubs in `ctx.props` (`@oa/broker-core/gate`, [props](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/#pass-data-and-capabilities-per-request)), valid for that request only. A gate is for one install and one broker: it forwards only `POST /google/redeem` (auth) or `POST /google/directory/token` and `/revoke` (directory), with no query string, `application/json` only, and a body of at most 8 KB whose `install` is that install (else a JSON `{error}` with `x-oa-gate: 1`, never forwarded: 404 `not_found`, 415 `json_only`, 413 `too_large`, 400 `bad_body` or `bad_json`, 403 `install_mismatch`, 500 `gate_misconfigured`; a broker's own response never carries that header). The gate also sets `x-oa-gate-install: <id>`, and the brokers charge their per-IP bucket on it as `gate:<id>` when the request has no `cf-connecting-ip` (Cloudflare sets that on every internet request, so only binding traffic lacks it, and a public caller's gate header is ignored); without it every hosted install would share one `ip:unknown` bucket (60/min). Broker refusals are all 401: `{"error":"unauthorized"}` for anything before the install's signature and registered key verify (size, body, unknown install, bad signature), so an outsider learns nothing; after verification `{"error":"stale"}` (the assertion's ts is off) or `{"error":"bad_flow"}` (the flow, grant or code doesn't bind). broker-check (#730) counts a broker ok only on `bad_flow` for its junk code, to the broker's fixed origin with only `content-type`, `x-oa-kid` and `x-oa-sig`. An unmapped host gets no gate. **Deploy both brokers before dispatch** (a service binding to a Worker that doesn't exist fails the deploy).

The repo config has no routes, custom domains or `workers.dev`, and no top-level name or `main`, so a deploy without `--env` is refused, even with `--name` (tests pin all of it). A positional entry (`wrangler deploy src/index.ts --name ...`) would still get past that guard. **Always deploy with `--env`, and never pass an entry point.** Routing is wired once per env by this step. **Deploys go through `deploy-hosted-platform.yml`** (see "Platform Workers through CI"); the steps here are the reference for what it does and checks.

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
4. (Laptop runbook only: CI's `zones` target uses the env's `CLOUDFLARE_API_TOKEN` instead.) Create a short-lived zone token (expires within the day), scoped to the env's two zones only, with Zone Read, Zone Settings Edit, DNS Edit and Workers Routes Edit. Verify it (`GET /user/tokens/verify`) before any write.
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

## Auth broker: one-time deploy per env (gated)

`apps/auth-broker` is the hosted Google sign-in broker on `auth.<app zone>`. It holds the multi-tenant Google client secret; the registry KV holds public keys only. The repo config has no routes, custom domains or `workers.dev`, and no top-level name or `main`, so a deploy without `--env` is refused, even with `--name` (tests pin all of it). A positional entry (`wrangler deploy src/index.ts --name ...`) would still get past that guard. **Always deploy with `--env`, and never pass an entry point.** Observability (Workers Logs) is off in each env and must stay off, because it records full URLs and the callback URL carries the OAuth code and state. **Deploys go through `deploy-hosted-platform.yml`** (see "Platform Workers through CI"); the steps here are the reference for what it does and checks.

| Env | Worker | Registry KV title | Config placeholder | Ratelimit ids |
|---|---|---|---|---|
| staging | `oa-s-auth-broker` | `oa-s-broker-registry` | `{{BROKER_REGISTRY_ID_STAGING}}` | 1101, 1102 |
| prod | `oa-p-auth-broker` | `oa-p-broker-registry` | `{{BROKER_REGISTRY_ID_PROD}}` | 1111, 1112 |

Prod's `GOOGLE_CLIENT_ID` is the placeholder `{{GOOGLE_CLIENT_ID_PROD}}` until a prod client exists, so a prod deploy is refused by step 3 until then (pass the id as `GOOGLE_CLIENT_ID_PROD`). The broker's vars are exactly `GOOGLE_CLIENT_ID` and `BROKER_ORIGIN`; it never holds the Directory client.

Set `ENV`, `P`, `APP` and `UP` as in the dispatch section. Then, per env:

1. Create the registry KV if provisioning hasn't (`pnpm exec wrangler kv namespace create oa-$P-broker-registry`; skip if `wrangler kv namespace list` shows it).
2. Build from a clean checkout of the reviewed commit, as in the dispatch section, and run `pnpm --filter @oa/auth-broker test`.
3. Deploy with the provisioning token, through the wrapper (`deploy-platform-worker.sh`, a hard-coded allowlist of apps). It runs from the app's directory, fills this env's placeholders from the environment into a gitignored `wrangler.deploy.jsonc`, refuses if any `{{..._<ENV>}}` remains, runs `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env <env>` (never an entry point, never `--name`), and removes the copy on exit:
   ```sh
   REG_ID=$(pnpm exec wrangler kv namespace list | jq -r --arg t "oa-$P-broker-registry" '.[] | select(.title == $t) | .id')
   BROKER_REGISTRY_ID="$REG_ID" scripts/ops/deploy-platform-worker.sh auth-broker "$ENV"   # prod also needs GOOGLE_CLIENT_ID_PROD
   ```
   The deploy output must name `oa-$P-auth-broker` with `BROKER_REGISTRY`, `RL_BROKER_IP`, `RL_BROKER_INSTALL` and the two vars, and no routes or workers.dev URL.
4. Set the secrets **after** the Worker exists, never before (`wrangler secret put` on a missing Worker creates one). Never echo them:
   ```sh
   pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env "$ENV"   # paste from the password manager
   openssl rand -base64 32 | pnpm exec wrangler secret put BROKER_STATE_KEY --env "$ENV"
   ```
5. The route, added in the same gated zone-token step as the dispatch routes (steps 4 to 7 of the dispatch section), on the app zone only: `POST /zones/<zone_id>/workers/routes` with `{"pattern": "auth.$APP/*", "script": "oa-$P-auth-broker"}`. The most specific matching route wins, so this beats the `*.$APP/*` dispatch wildcard (see [How routes work](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior)). `auth.$APP` is covered by the wildcard DNS record from the dispatch step.
6. Check: `curl -sS -o /dev/null -w '%{http_code}\n' "https://auth.$APP/"` must be the broker's answer, not dispatch's plain `404 Not found` with body `Not found`.

### Google clients (record)

Public values only. The client secrets live in the user's password manager until each Worker exists.

| Env | Project | Client | Client id | Redirect URI |
|---|---|---|---|---|
| staging | `open-artifacts-staging` | Sign-in (used by the broker) | `1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com` | `https://auth.open-artifacts-staging.app/google/callback` |
| staging | `open-artifacts-staging` | Directory (P3 directory sync; on `oa-<p>-directory-broker`, not on the auth broker) | `1032390278908-keuivn889b7c1rrisf4rbbgdtpu876vm.apps.googleusercontent.com` | `https://directory.open-artifacts-staging.app/google/directory/callback` |
| prod | not created yet | | | |

## Directory broker: one-time deploy per env (gated)

`apps/directory-broker` is the hosted Google Directory consent broker on `directory.<app zone>`. It holds the Directory client secret; its registry (`DIRECTORY_REGISTRY`, public keys only) is read, never written, and it never binds the auth broker's `BROKER_REGISTRY`, so a compromised directory Worker can't plant sign-in trust anchors. Its config has no routes, custom domains or `workers.dev`, and no top-level name or `main`, so a deploy without `--env` is refused, even with `--name` (tests pin all of it). **Always deploy through the wrapper, and never pass an entry point.** Observability (Workers Logs) is off in each env and must stay off, because it records full URLs and the callback URL carries the OAuth code and state. **Deploys go through `deploy-hosted-platform.yml`** (see "Platform Workers through CI"); the steps here are the reference for what it does and checks.

| Env | Worker | Registry KV title | Config placeholder | Ratelimit ids |
|---|---|---|---|---|
| staging | `oa-s-directory-broker` | `oa-s-directory-registry` | `{{DIRECTORY_REGISTRY_ID_STAGING}}` | 1121, 1122 |
| prod | `oa-p-directory-broker` | `oa-p-directory-registry` | `{{DIRECTORY_REGISTRY_ID_PROD}}` | 1131, 1132 |

Prod's `GOOGLE_DIRECTORY_CLIENT_ID` is the placeholder `{{GOOGLE_DIRECTORY_CLIENT_ID_PROD}}` until a prod Directory client exists, so a prod deploy is refused by step 3 until then (pass the id as `GOOGLE_DIRECTORY_CLIENT_ID_PROD`). The Worker's vars are exactly `GOOGLE_DIRECTORY_CLIENT_ID` and `DIRECTORY_ORIGIN`.

Set `ENV`, `P`, `APP` and `UP` as in the dispatch section. Then, per env:

1. Create the registry KV if provisioning hasn't (`pnpm exec wrangler kv namespace create oa-$P-directory-registry`; skip if `wrangler kv namespace list` shows it).
2. Build from a clean checkout of the reviewed commit, as in the dispatch section, and run `pnpm --filter @oa/directory-broker test`.
3. Deploy with the provisioning token, through the wrapper (see the auth broker's step 3):
   ```sh
   REG_ID=$(pnpm exec wrangler kv namespace list | jq -r --arg t "oa-$P-directory-registry" '.[] | select(.title == $t) | .id')
   DIRECTORY_REGISTRY_ID="$REG_ID" scripts/ops/deploy-platform-worker.sh directory-broker "$ENV"   # prod also needs GOOGLE_DIRECTORY_CLIENT_ID_PROD
   ```
   The deploy output must name `oa-$P-directory-broker` with `DIRECTORY_REGISTRY`, `RL_DIRECTORY_IP`, `RL_DIRECTORY_INSTALL` and the two vars, and no routes or workers.dev URL.
4. Set the secrets **after** the Worker exists, never before (`wrangler secret put` on a missing Worker creates one). Never echo them:
   ```sh
   cd apps/directory-broker
   pnpm exec wrangler secret put GOOGLE_DIRECTORY_CLIENT_SECRET --env "$ENV"   # paste from the password manager
   openssl rand -base64 32 | pnpm exec wrangler secret put DIRECTORY_STATE_KEY --env "$ENV"
   ```
5. The route, added in the same gated zone-token step as the dispatch and auth broker routes, on the app zone only: `POST /zones/<zone_id>/workers/routes` with `{"pattern": "directory.$APP/*", "script": "oa-$P-directory-broker"}`. The most specific matching route wins, so this beats the `*.$APP/*` dispatch wildcard (see [How routes work](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior)). `directory.$APP` is covered by the wildcard DNS record from the dispatch step.
6. Check: `curl -sS -o /dev/null -w '%{http_code}\n' "https://directory.$APP/"` must be the Directory broker's answer, not dispatch's plain `404 Not found` with body `Not found`.

## Nightly scheduler: one-time deploy per env (Task 7, gated)

User Workers in a dispatch namespace get no cron triggers, so `apps/scheduler` is the only nightly caller. Its cron (`17 3 * * *`, the same as a self-hosted install's) reads `SELECT id FROM installs WHERE state = 'active'` from the platform D1 (in keyset pages of 500) and calls `DISPATCHER.get(oa-<p>-<id>).scheduled({ cron, scheduledTime })` on each:

**Broker gates and directory sync.** Every call the scheduler makes to an install (nightly, directory revoke, directory sync) carries that install's two `BrokerGate` stubs in `ctx.props`, built from the scheduler's own `AUTH_BROKER` and `DIRECTORY_BROKER` bindings, as dispatch does (see the dispatch section). A props stub is valid only for the call that got it, so an install reaches a broker only inside a dispatched request or one of these calls; the SyncDO alarm makes no broker call. On the `*/2` tick, after the revoke tick, the scheduler calls every active install with `cron: "oa:directory-sync"` (6 at a time, 20 s per call, no new call after 80 s, so a tick ends inside its 2 minutes). An install with no directory returns at once, and SyncDO decides whether a run is due. Its lines use the `directory-sync` prefix (`summary`, `failed`, `skipped`, `leaked`, `db_error`, `aborted`). **Deploy both brokers before the scheduler.** **Version skew (pre-launch, accepted):** an install on a release before the server's broker-props change (Backend #722) rejects `oa:directory-sync` as an unknown system job, so until every install is upgraded the scheduler logs `directory-sync failed exception <id>` for it every 2 minutes; filter that line when reading tails. Order: deploy dispatch and the scheduler (#720) before any install moves to #722's release, because from #722 a hosted install with no gate in its props fails closed (`broker_unavailable`) instead of trying HTTPS.

- **Night order (stateless).** The installs form a fixed cycle, sorted by `sha256(id)` with a tie-break on id. Each night enters the cycle at `floor(frac(UTC day number × 0.3819660112501051) × N)`, where `frac(x) = x − floor(x)`: a golden-ratio step, scaled by tonight's N. A run that stops early leaves a tail, and the step moves that tail on by more than its own width. Because the step is a fraction of the cycle, installs created or deleted between nights move the window only slightly. Measured over 30 nights (tests pin all three):
  - 300 installs, run budget 190: never skipped 3 nights in a row; at most 2 (the test bound);
  - churn, +2 and −1 installs a night, budget 190: max streak 2, never 3 in a row. The earlier integer start, `day × round(0.382 N) mod N`, gave 7 and 652;
  - budget 100, the degraded case: at most 4 nights in a row.

  Independent daily shuffles (`sha256(id + date)`) gave 8 and 18. **A skip streak means the run budget is short:** raise `concurrency`, or move to the M2 Queue fan-out.
- **Re-checked per call.** Right before each call it re-reads the row, within 5 s and within the deadline. If the install has left `active`, or holds a live lifecycle lease (`lease_until` in the future: an upgrade, rollback or delete is running), it isn't called and counts as `skipped`, not failed. A stalled re-check is `skipped` too. A D1 error on the re-check is `db_error`, never blamed on the install. 3 in a row of either (errors or stalls, as a hanging D1) stop the run, and the rest is `skipped`. Installs in `creating`, `upgrading`, `deleting` or `deleted` are never called, nor is a row whose id isn't an install id.
- **Known window.** A lifecycle operation can take its lease after the re-check, while that install's nightly job is already running. Provision can't see the scheduler, so an upgrade, rollback or delete may overlap a nightly job that has already started. Nightly work must therefore be idempotent (the server's sweeps are), and upgrade and delete must tolerate it and retry their own steps. This is accepted for M1.
- **6 at a time.** Calling a service binding doesn't count toward the 6 simultaneous open connections, but the installs' own fetch, KV, R2, Cache and Queues calls share the scheduler's limit while they wait for headers ([limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections), [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits)). A call is reported `timeout` after 25 s, but it keeps its slot until it settles. A stuck call holds its slot for at most 60 s after its timeout. Then the slot is given back, the call counts as `leaked`, and the run goes on. A call still unsettled when the run ends is `leaked` too. Leaked calls may still hold connections, so the real bound is on unsettled calls: at most 12 (2 × the 6 slots, in a slot or leaked) at any time. At that cap no new call starts until one settles, or the deadline hits.
- **Deadline.** No call starts after 13 minutes, under the 15-minute cron wall time. The rest is `skipped`, and the summary still lands.
- One install throwing, timing out or missing never stops the others.
- **Directory revoke (H-DV), every 2 minutes.** `scheduled()` branches on `event.cron`: `*/2 * * * *` runs only the revoke tick, `17 3 * * *` only the nightly run (then the email-quota alert, then the owner-email purge), and any other cron runs nothing. Each tick runs one query on the partial index `installs_revoke_pending`: `SELECT id, version FROM installs WHERE state='deleting' AND directory_revoke='pending' LIMIT 10`, and calls each row's `DISPATCHER.get(oa-<p>-<id>).scheduled({ cron: "oa:directory-disconnect", scheduledTime })`, 3 at a time, 25 s each (a full tick ends inside its 2 minutes and never crowds a nightly run).
  - A version below `REVOKE_MIN_VERSION` (`@oa/provision/versions`; provisional `0.56.0`, the release whose `oa:directory-disconnect` keeps the tokens and rejects when the Google revoke fails), or no release version, is `unsupported` with no call: older releases ignore the cron, or can't confirm the revoke.
  - A resolve with outcome `ok` is `done` (with `directory_revoked_at`, never earlier than the attempt's `directory_revoke_requested_at`). Only the runtime's structured result `outcome: "scriptNotFound"` is `unsupported`; a thrown error, even one saying "Worker not found" (Cloudflare documents that text for `fetch()` on a missing script, not for `scheduled()`), a timeout or any other outcome adds one to `directory_revoke_attempts`, and the fifth is `failed`.
  - The scheduler writes only those revoke columns, only with `WHERE id = ? AND state = 'deleting' AND directory_revoke = 'pending'`, so a late result never overwrites an operator's skip. Each row is handled on its own: a D1 error on one row logs `directory-revoke db_error <id>` and the others still record; a failed tick logs `directory-revoke aborted exception`. Logs: `directory-revoke done|unsupported|retry|failed|db_error <id>`, `directory-revoke invalid ids=<n>` and `directory-revoke aborted exception`, never error text.
  - The version gate reads `installs.version`. After `releaseLease` on a rollback that crashed across `REVOKE_MIN_VERSION` (between its upload and its version write), the row can name the newer version while the older script is live: check the live `/healthz` version before deleting such an install, and skip the revoke if it is below `REVOKE_MIN_VERSION`.
- **Owner-email purge (H-DV), nightly.** In its own try, after the email-quota alert: `UPDATE installs SET owner_email = '', inputs_hash = '' WHERE state='deleted' AND updated_at < now - 30 days AND owner_email <> ''`. `inputs_hash` is an unsalted sha256 over the email, so it goes in the same write (it is compared only on a creating row's resume); `install_versions` holds no email (its stored metadata drops `OWNER_EMAIL`), and `hosts` and `hosted_audit` never held one. owner_email stays NOT NULL: a purged email is `''` (`PURGED_EMAIL` in `@oa/provision/names`). Idempotent; logs `owner-email purged count=<n>` (or `owner-email failed db`). The install row, its id and its hosted_audit rows (which hold no email) stay.
  - The purge does not touch `hosted_audit.actor`. It is the operator's `git config user.email` (or a CI run URL) on each `oa:hosted` command, operator data rather than the customer's, and it stays. If the operator is also the install's owner (staff, demo or test installs), that address remains in hosted_audit after the purge.
  - Every read of `installs.owner_email` goes through `ownerEmailOf(row)` (null when purged), and a source test fails on any other read. A purged email is never rendered, emailed or used as an address: upgrade, rollback and var changes on such an install refuse before any write, `status` shows `owner: "(purged)"` (or `"(set)"`, never the address), and delete still tears down.
- **Email-quota alert.** After the nightly run, in its own try, the scheduler reads the previous UTC day's sends from Cloudflare's Email Sending analytics (GraphQL, dataset `emailSendingAdaptiveGroups`, zone-level; [metrics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)) and sums them over `EMAIL_QUOTA_ZONES`. It never reads an install's D1, never changes or delays the nightly result, and gives up after 10 s. The sending limit is per account, not per zone ([limits](https://developers.cloudflare.com/email-service/platform/limits/)), so list every sending zone of the account and set `EMAIL_DAILY_LIMIT` to that account's current daily limit (new accounts start low and scale up, so re-check it in the dashboard). The window is `[day start, day end)` in UTC, from `event.scheduledTime`. The query filters `isLastEvent: 1`, so each email counts once (`count` is per event, and only an email's last event has it), and sums `count` over every status on purpose: Cloudflare doesn't count suppressed or verified-destination sends toward the limit, but the alert does, so it may read slightly high. Over-counting is the safe direction. At most 10 zones. Both vars are per-env placeholders, filled at deploy like `PLATFORM_DB`:

  | Var | Placeholder (staging, prod) | Value |
  |---|---|---|
  | `EMAIL_QUOTA_ZONES` | `{{EMAIL_ZONE_TAG_STAGING}}`, `{{EMAIL_ZONE_TAG_PROD}}` | Comma-separated zone tags (32 hex chars). Each is the zone's id: dashboard > the domain > Overview > API section > Zone ID |
  | `EMAIL_DAILY_LIMIT` | `{{EMAIL_DAILY_LIMIT_STAGING}}`, `{{EMAIL_DAILY_LIMIT_PROD}}` | The account's Email Sending daily limit, a positive integer: dashboard > Compute > Email Service > Email Sending |

  Step 3 below fills them in the same gitignored copy as the D1 id and refuses to deploy if any of this env's placeholders is left. An unfilled placeholder would be an invalid config, so the alert would skip.

A hosted upload carries no cron of its own (`TEMPLATE_BINDINGS_EXCLUDED.triggers`). That's pinned for the metadata in `packages/provision/test/metadata.test.ts`, and for the create, upgrade and rollback uploads, with no `/schedules` call, in `wfp-lifecycle.test.ts`. So the job runs once.

The repo config has no routes, custom domains or `workers.dev`, no fetch handler, and no top-level name or `main`. A deploy without `--env` is therefore refused, even with `--name` (tests pin all of it). A positional entry (`wrangler deploy src/index.ts --name …`) would still get past that guard. **Always deploy with `--env`, and never pass an entry point.** Observability (Workers Logs) is on for this Worker only: it serves no requests, so there are no URLs to record, and its lines carry install ids, fixed categories and counts only (a test pins the whole log vocabulary). The dispatch Worker stays off. **Deploys go through `deploy-hosted-platform.yml`** (see "Platform Workers through CI"); the steps here are the reference for what it does and checks.

| Env | Worker | Namespace | Platform D1 | Config placeholder |
|---|---|---|---|---|
| staging | `oa-s-scheduler` | `oa-staging` | `oa-s-platform` | `{{PLATFORM_DB_ID_STAGING}}` |
| prod | `oa-p-scheduler` | `oa-prod` | `oa-p-platform` | `{{PLATFORM_DB_ID_PROD}}` |

Steps, per env (`ENV`, `P` and `UP` as in the dispatch steps above):

1. Preconditions: the namespace `oa-$ENV` and the D1 `oa-$P-platform` exist, with the platform-db migrations applied.
2. Build and test from a clean checkout of the reviewed commit:
   ```sh
   git status --porcelain | grep -q . && { echo "dirty checkout" >&2; exit 1; }
   pnpm install --frozen-lockfile && pnpm --filter @oa/provision build && pnpm --filter @oa/scheduler test
   ```
3. Deploy with the provisioning token. Fill this env's placeholders into a gitignored copy, refuse if any of this env's `{{...}}` is left, deploy the copy, then remove it. `ZONES` is the sending zone tags, comma-separated (each is the zone's id: dashboard > the domain > Overview > API section > Zone ID, 32 lowercase hex chars). `LIMIT` is the account's Email Sending daily limit (dashboard > Compute > Email Service > Email Sending), a positive integer of at most 9 digits. Replace both quoted values before running; the chain refuses anything `apps/scheduler/src/quota.ts` would reject (an empty value, the example text, a bad tag or limit):
   ```sh
   cd apps/scheduler
   ZONES='<zone tag>[,<zone tag>...]'
   LIMIT='<daily limit>'
   DB_ID=$(pnpm exec wrangler d1 list --json | jq -r --arg n "oa-$P-platform" '.[] | select(.name == $n) | .uuid')
   printf '%s' "$ZONES" | grep -Eq '^[0-9a-f]{32}(,[0-9a-f]{32}){0,9}$' \
     && printf '%s' "$LIMIT" | grep -Eq '^[1-9][0-9]{0,8}$' \
     && test -n "$DB_ID" \
     && sed -e "s/{{PLATFORM_DB_ID_$UP}}/$DB_ID/" \
            -e "s/{{EMAIL_ZONE_TAG_$UP}}/$ZONES/" \
            -e "s/{{EMAIL_DAILY_LIMIT_$UP}}/$LIMIT/" wrangler.jsonc > wrangler.deploy.jsonc \
     && { ! grep -q "{{[A-Z_]*_$UP}}" wrangler.deploy.jsonc \
          || { rm wrangler.deploy.jsonc; echo "unfilled $UP placeholder" >&2; false; }; } \
     && pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env "$ENV" \
     && rm wrangler.deploy.jsonc
   ```
   The copy is the whole file, so the other env's placeholders stay in it (harmless: `--env` deploys only this env's block); the check is on this env's. A refused chain leaves nothing deployed; if `wrangler deploy` itself fails, remove `wrangler.deploy.jsonc` by hand.
   The deploy output must name `oa-$P-scheduler` with `DISPATCHER (oa-$ENV)`, `PLATFORM_DB (oa-$P-platform)`, `OA_ENV ("$ENV")`, `EMAIL_QUOTA_ZONES ("<your zone tags>")` and `EMAIL_DAILY_LIMIT ("<your limit>")` (no `{{`), the schedules `17 3 * * *` and `*/2 * * * *`, and no routes or workers.dev URL.
4. Binding check, from the deployed settings (in the same shell as step 3, so `ZONES` and `LIMIT` are still set): `PLATFORM_DB` must be the database named `oa-$P-platform`, `DISPATCHER` must be the namespace `oa-$ENV`, `OA_ENV` must be `$ENV`, `EMAIL_QUOTA_ZONES` and `EMAIL_DAILY_LIMIT` must be the values from step 3, and the schedules must be exactly `17 3 * * *` and `*/2 * * * *`. Never another env's (`CF_ACCOUNT_ID` and `CF_API_TOKEN` as in the dispatch check):
   ```sh
   API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"
   SET=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "$API/workers/scripts/oa-$P-scheduler/settings")
   BOUND=$(printf %s "$SET" | jq -r '.result.bindings[] | select(.name == "PLATFORM_DB") | .id')
   NAME=$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "$API/d1/database/$BOUND" | jq -r .result.name)
   test "$NAME" = "oa-$P-platform" || { echo "PLATFORM_DB bound to $NAME" >&2; exit 1; }
   test "$(printf %s "$SET" | jq -r '.result.bindings[] | select(.name == "DISPATCHER") | .namespace')" = "oa-$ENV" \
     || { echo "DISPATCHER is not oa-$ENV" >&2; exit 1; }
   test "$(printf %s "$SET" | jq -r '.result.bindings[] | select(.name == "OA_ENV") | .text')" = "$ENV" \
     || { echo "OA_ENV is not $ENV" >&2; exit 1; }
   test "$(printf %s "$SET" | jq -r '.result.bindings[] | select(.name == "EMAIL_QUOTA_ZONES") | .text')" = "$ZONES" \
     || { echo "EMAIL_QUOTA_ZONES is not the zones set at deploy" >&2; exit 1; }
   test "$(printf %s "$SET" | jq -r '.result.bindings[] | select(.name == "EMAIL_DAILY_LIMIT") | .text')" = "$LIMIT" \
     || { echo "EMAIL_DAILY_LIMIT is not the limit set at deploy" >&2; exit 1; }
   test "$(curl -sS -H "Authorization: Bearer $CF_API_TOKEN" "$API/workers/scripts/oa-$P-scheduler/schedules" \
     | jq -c '[.result.schedules[].cron] | sort')" = '["*/2 * * * *","17 3 * * *"]' \
     || { echo "schedules are not exactly 17 3 * * * and */2 * * * *" >&2; exit 1; }
   ```
5. **Per-request invocation limit: measured, no cap.** The service-bindings docs say "A single request has a maximum of 32 Worker invocations, and each call to a Service binding counts". Measured on staging 2026-10-24: 100 sequential dispatch `scheduled()` calls from one request, no invocation cap hit (probe: `.superpowers/platform/probe_invocations.py` in the platform workspace). The same probe showed that `scheduled()` resolves to `undefined` when the install's handler succeeds, and rejects with the handler's own error when it throws. The scheduler logs only a fixed category, never that text. On the first real staging run, also confirm:
   - the rejection for a missing script maps to `not_found`;
   - whether a timed-out install's job is canceled when the scheduler's invocation ends.
   - the first `email-quota` line (once the token is set) is `ok` or `warn`, not `failed graphql` (the window variables are sent as ISO times with milliseconds, e.g. `2026-10-23T00:00:00.000Z`; a `graphql` failure on the first run points there or at the `datetimeHour_lt` filter).

### Email-quota token (optional, set after the scheduler is deployed)

The alert needs one secret, `EMAIL_QUOTA_TOKEN`: a Cloudflare API token that can only read analytics. Without it the alert skips, and nothing else changes.

| | |
|---|---|
| Permission | Zone > Analytics > Read |
| Scope | Specific zone: each zone in `EMAIL_QUOTA_ZONES`. Nothing else. |
| TTL | 30 days or less (set an expiry; recreate it before it lapses, or the alert logs `email-quota failed http`) |

Steps, per env:

1. Dashboard > My Profile > API Tokens > Create Token > Custom token.
2. Add Zone / Analytics / Read. Zone Resources: Include > Specific zone, then pick the sending zone (add one row per zone). Set the TTL.
3. Create the token and copy it. Don't paste it anywhere else.
4. Only after the scheduler is deployed, from `apps/scheduler`:
   ```sh
   pbpaste | npx wrangler secret put EMAIL_QUOTA_TOKEN --env <staging|prod>
   ```
5. Put the expiry in a calendar: at 30 days or less the token lapses, and the alert then logs `email-quota failed http` every night until it is rotated (repeat steps 1 to 4).
6. Clear the clipboard. The token is used only as the `Authorization` header of the call to `api.cloudflare.com`, and is never logged.

### Reading the nightly run

Read the lines in Workers Logs for `oa-$P-scheduler` (dashboard, or the Observability API with the Platform read-only token), filtered on `nightly`. To watch live, run `pnpm exec wrangler tail oa-$P-scheduler --format pretty` around 03:17 UTC. The dashboard's Cron Events list (Worker > Settings > Triggers) shows each past invocation and its outcome. The run itself fails there only when it aborts (`nightly aborted`). The lines carry no error text, emails or vars:

| Line | Meaning |
|---|---|
| `nightly summary active=<n> ok=<n> failed=<n> skipped=<n> capped=<n> db_errors=<n> leaked=<n>` | One per run, at the end. `active` counts the valid active ids read (ok + failed + skipped + db_errors). `capped` is the part of `skipped` held back by the unsettled cap. `leaked` counts timed-out calls still unsettled 60 s later, or at the end; they're also in `failed` as `timeout`. A large `skipped` with few `failed` means the deadline hit: see the scale line. |
| `nightly skipped <state\|deadline\|capped\|recheck\|db_error> <installId>` | One per install not called, when it happens. `state`: it left `active` or took a lease before its turn. `deadline`: not started by the 13-minute deadline, including a re-check that would start with under 1 s left or that the deadline cut short. `capped`: held back by the 12-unsettled cap until the deadline: 12 calls never settled, so look at the `leaked` lines first. `recheck`: the per-call D1 re-check stalled for its full 5 s. `db_error`: the run stopped after 3 D1 errors or full 5 s stalls in a row (the reason covers both). A `deadline`-skipped tail is near the head on a later night (night order). The same id skipped night after night means the run budget is short. |
| `nightly db_error <installId>` | The platform D1 re-check failed for that install, so it wasn't called. Check the platform D1, not the install. |
| `nightly leaked <installId>` | The install's call never settled within 60 s of its timeout (or by the end of the run), and its slot was given back. Read that install's own Workers Logs: its nightly job is hanging. |
| `nightly failed <category> <installId>` | One per failed install, logged when it happens. `timeout`: over 25 s; the job may have been canceled when the run ended, so treat it as not done. `canceled`: the runtime canceled the install's handler. `not_found`: no script in the namespace (a rejection starting "Worker not found", with or without an `Error: ` prefix, or outcome `scriptNotFound`; an install's own error that starts that way would land here too); check the row's state against the namespace. `exception`: the install's handler threw (the call rejected), the call failed, or it resolved with an outcome other than `ok` (`exceededCpu`, `exceededMemory`, …); read that install's own Workers Logs. |
| `nightly invalid ids=<n>` | Active rows whose id isn't an install id; skipped. Fix the rows. |
| `nightly scale active=<n> over 300` | Past what one run fits (about 190 at 6 × 25 s in 13 minutes, fewer under shared-connection queuing). The M2 Queue fan-out is overdue. |
| `nightly aborted <env\|exception>` | The run stopped before any call: a bad `OA_ENV` (`env`) or a platform D1 read error (`exception`). Cron Events shows the failure. |

Email-quota lines (one per run, after `nightly summary`; filter on `email-quota`). Same rules: no token, zone tag, response text, address or URL:

| Line | Meaning |
|---|---|
| `email-quota ok sent=<n> limit=<L> pct=<p>` | Yesterday's (UTC) sends are under 80% of the limit. `console.log`. |
| `email-quota warn sent=<n> limit=<L> pct=<p>` | At or above 80% (`pct` is rounded down; over 100 means the limit was passed). `console.warn`. Ask Cloudflare for a higher limit, or cut sending. |
| `email-quota skipped no_token` | `EMAIL_QUOTA_TOKEN` isn't set. No call was made. |
| `email-quota skipped config` | `EMAIL_QUOTA_ZONES` has no zone, a bad tag, or more than 10, or `EMAIL_DAILY_LIMIT` isn't a positive integer (an unfilled `{{...}}` placeholder is one). No call was made. |
| `email-quota failed http` | Non-2xx from the API (an expired or wrongly scoped token is a 401 or 403) or a network error. |
| `email-quota failed graphql` | The API answered with GraphQL `errors`. |
| `email-quota failed timeout` | No full answer within 10 s. |
| `email-quota failed shape` | Not JSON, or not the expected shape (including a configured zone missing from the answer). |

A failed or skipped alert never changes the nightly lines above.

## Platform Workers through CI (`deploy-hosted-platform.yml`)

The platform Workers and the zone wiring deploy from CI, never a laptop: `deploy-hosted-platform.yml` is dispatch-only and takes an env (`staging` or `prod`), a stable release tag and a comma-separated target list in dependency order (`platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,provisioning,zones`). Prod runs only from main: the workflow checks `github.ref`, and the script refuses a CI prod run unless `GITHUB_REF` is `refs/heads/main` and the Environment is `hosted-prod-deploy`. The workflow file and its deploy scripts come from main; everything deployed comes from the tag. It runs `scripts/ops/deploy-hosted-platform.sh <env> <target>`, which deploys through `deploy-platform-worker.sh` (the allowlist, placeholders filled and checked), sets secrets only after the Worker exists, then reads the live settings back and refuses on any mismatch: bindings, vars, the dispatch namespace, service bindings, observability (off on the brokers and dispatch), the scheduler's two schedules, and the exact secret names. `verify_only` deploys and sets nothing: it reads the live Workers back and runs every check (a read-only rehearsal). Before deploying, `auth-broker` refuses unless `GOOGLE_CLIENT_ID` equals provision's pin, `BROKER_GOOGLE_CLIENT_ID[<env>]` in main's `packages/provision/src/wfp.ts` (a `null` pin is a refusal too). The inventory Worker deploys through the same wrapper (its config has per-env blocks); it authenticates callers with GitHub OIDC, so its read-back checks the OIDC vars and the `inventory` target refuses any secret on it.

`zones` runs `scripts/ops/hosted-zones.sh <env> plan`, then `apply`, in its own step, with the same `CLOUDFLARE_API_TOKEN`. It wires both zones exactly as the dispatch section says (the two `AAAA * → 100::` records, the four routes, and `ssl` strict, `always_use_https` on, `min_tls_version` 1.2; no HSTS). Every run plans, then applies in the same job (`verify_only` stays plan only); the plan, with "ok" for what already matches, and the result go to the job summary. Before writing, it refuses unless every planned change is an addition or a setting change from that fixed set, and both modes refuse a different `*` record, one of our route patterns on another Worker, or a route that isn't ours but one of our patterns matches (other routes on the zone are left alone). After applying, it reads the records, routes and settings back and fails unless they equal the set exactly. Secrets reach wrangler on stdin and the API token reaches curl on stdin; none is in argv or printed.

No one approves a run. Before anything is checked out or deployed, the release gate (`scripts/ci/tag-passed-checks.sh <env> <tag>`, main's copy, read-only with `github.token`: `contents: read`, `actions: read`) refuses the tag unless it is a published, non-draft, non-prerelease release; its commit is on `main`; the `release-please.yml` push run for that commit concluded `success`, with `verify-release`, `hosted-check` and `hosted-attach-<env>` each `success`; and the release has an `oa-release-<env>-*` asset. Any API error fails the gate. If a release was not safe, one of those checks failed first.

Each env has its own GitHub Environment, `hosted-staging-deploy` or `hosted-prod-deploy`: deployment branch `main` only, admin bypass off, no approval step. They stay separate from `hosted-staging` and `hosted-prod`, so release signing can't read the deploy token and deploys can't read the signing key. Both hold the same secret names and no variables:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The env's one Cloudflare token. It is user-owned (My Profile > API Tokens), rolled in the dashboard and pasted here, with exactly these scopes: Account (the hosted account): Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Workers R2 Storage Edit, Turnstile Edit, Queues Edit, Workflows Edit, Secrets Store Edit. Zone (Include > Specific zone, the env's two zones only: `open-artifacts.app` and `open-artifacts.page` for prod): Zone Read, Zone Settings Edit, DNS Edit, Workers Routes Edit. Every Cloudflare call in `deploy-hosted-platform` and `hosted-ops` uses it: the deploys, the zones, the resource id and Turnstile lookups, and R2 (its S3 key is derived from it in the run) |
| `GOOGLE_CLIENT_SECRET` | The env's sign-in client secret |
| `GOOGLE_DIRECTORY_CLIENT_SECRET` | The env's Directory client secret |

Everything else CI derives, and fails closed:

- Constants: `.github/hosted/<env>.json` (main's copy) holds `account_id`, `email_zone` (the sending zone's name: hosted mail is `noreply@mail.<app domain>`, so it is the app zone), `email_daily_limit`, `google_client_id` and `google_directory_client_id`. `scripts/ci/hosted-constants.sh` checks each against its consumer's rule (32 hex, a zone name, 1 to 9 digits, a Google client id) and only then loads them into the job (`CLOUDFLARE_ACCOUNT_ID`, `EMAIL_ZONE`, `EMAIL_DAILY_LIMIT`, `GOOGLE_CLIENT_ID`, `GOOGLE_DIRECTORY_CLIENT_ID`); a missing, empty or malformed value (a placeholder included) fails and writes nothing. It also holds the scheduler's `alert_from` and, once a person commits it, `alert_to` (the alert destination: `ALERT_TO` and the pinned `ALERT_EMAIL` destination); until then `alert_to` is absent and the `scheduler` target refuses. Tests pin `google_client_id` to provision's `BROKER_GOOGLE_CLIENT_ID[<env>]`, `account_id` to the hosted account (`docs/ops/staging.md`), `email_zone` to provision's `HOSTED_DOMAINS[<env>].app`, staging's Directory client to the directory broker's staging config, and prod's to the client made in project `open-artifacts-prod` during setup C (2026-10-24).
- Resource ids: `scripts/ci/hosted-resource-ids.sh <env>` lists the account's D1 databases, KV namespaces and zones (every page) and resolves `oa-<p>-platform` (`PLATFORM_DB_ID`), `oa-<p>-hosts` (`HOSTS_KV_ID`), `oa-<p>-broker-registry` (`BROKER_REGISTRY_ID`), `oa-<p>-directory-registry` (`DIRECTORY_REGISTRY_ID`) and the sending zone's tag (`EMAIL_ZONE_TAGS`, the zone's id; the lookup is `account.id`-scoped and each result's `account.id` must match) by exact name. Each must match exactly one; none, two or more, a failed call or a network error stops the run naming the resource. It runs only when the targets include one that binds them (`auth-broker`, `directory-broker`, `dispatch`, `scheduler`, `inventory`).

The broker state keys (`BROKER_STATE_KEY`, `DIRECTORY_STATE_KEY`) are never stored anywhere: the first run generates each one inside the runner, and later runs keep it (a failed secrets listing stops the run instead of reading as "absent"). The Google secrets are set on every run, so rotating one is: update the Environment secret, then re-run that target.

The only secret a person sets for prod today is the token, in two dashboards (no laptop). The inventory has no key: GitHub OIDC replaced it (the `inventory` target refuses any secret on it), and `CREATE_OWNER_EMAIL` retires with the `hosted-ops` create (see there).

1. **Scopes.** At https://dash.cloudflare.com/profile/api-tokens, open the prod token (user-owned) > ⋯ > Edit and check it has:
   - Account (the hosted account): Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Workers R2 Storage Edit, Turnstile Edit, Queues Edit, Workflows Edit, Secrets Store Edit. (Read-only check 2026-10-30: prod lacked only Secrets Store.)
   - Zone, with Include > Specific zone for `open-artifacts.app` and again for `open-artifacts.page`: Zone Read, Zone Settings Edit, DNS Edit, Workers Routes Edit.
   - Continue to summary > Update token. The edit page has no prefill link.
2. **Roll.** On the same list: the token > ⋯ > Roll > confirm, and copy the new value (Cloudflare shows it once). Rolling replaces the old value: every other copy, the keychain item `oa-hosted-prod` included, stops working until it is updated. The Environment secret is the source of truth.
3. **Paste.** At https://github.com/open-artifacts-ai/open-artifacts/settings/environments/25812490011/edit (the `hosted-prod-deploy` Environment), under Environment secrets: Add environment secret (or the pencil on an existing one), name `CLOUDFLARE_API_TOKEN`, paste the value, Add secret. The form can't be prefilled with a value.

A `verify_only` run proves only the read scopes: it makes GETs (Workers settings and secrets, the D1, KV and zone listings, the zone settings, DNS records and routes) and stops at the first one refused. It cannot check the token's own permission list: that is `GET /user/tokens/<id>`, which needs the user-level API Tokens Read permission ([Create a token via the API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/), user token endpoints), and this token does not have it (it would let CI read every token's policies). The write scopes are proven by use: the first real deploy (Workers Scripts Edit, the secret puts), `zones` apply (Zone Settings Edit, DNS Edit, Workers Routes Edit), and later the provisioning calls (KV, D1, R2, Turnstile, Queues, Workflows, Secrets Store).

Trade-off (accepted for M1): "Deploy and verify" runs the tag's wrangler and build with this broad token in its environment. That is accepted because the tag passed the release gate first, and Workers Scripts Edit alone already reaches every binding a deployed Worker holds. R2 reach is account-wide too, see "R2 API token". Follow-up: once installs are made only through the Provisioning API (with its Secrets Store token), drop the provisioning scopes (KV, D1, R2, Turnstile, Queues, Workflows, Secrets Store) from the CI token, and narrow its R2 grant to Bucket Item Write on `oa-<p>-releases`.

Optional alternative, from a terminal whose keychain item already holds the current (rolled) value; after a roll it works only once the keychain is updated (nothing is printed, and the value never reaches argv):

```sh
security find-generic-password -s oa-hosted-prod -a open-artifacts -w |
  gh secret set CLOUDFLARE_API_TOKEN --env hosted-prod-deploy -R open-artifacts-ai/open-artifacts
```

## Hosted release files (T3b)

- The stored record is `{ "record": "<canonicalJson(record)>", "signature": "<base64url>" }`. The signature covers `"oa-release-v1\n" + env + "\n" + record` (the exact string). Readers verify that string, parse it refusing duplicate keys (objects built with a null prototype), and require it to re-serialize byte for byte.
- CI signs and never uploads to Cloudflare. On a stable release, `release-please.yml` runs `hosted-guard` (tag to one commit on `main`, equal to `package.json`), `hosted-build` (both variants and the release files, `manifest.json`), `hosted-check` (every hash, `check-no-test-hooks` on the release bundle), `hosted-sign-staging` and `hosted-sign-prod` (environments `hosted-staging` and `hosted-prod`; checkout, `actions/setup-node` pinned by SHA with Node 22 from `.nvmrc` (no cache) and a v22 assert, then download-artifact and the sign step: plain `.mjs` (node:* imports, no install), key on stdin, in the sign step's env only) and `hosted-attach-staging` / `hosted-attach-prod` (each rebuilds its env's tars and `.sig.json` files, verifies them and attaches them to the GitHub release; refused if that env's assets are already there).
- `publishRelease` (laptop; Task 8 wires the CLI) verifies a tar and its `.sig.json` against `RELEASE_PUBKEY[env]` and copies exactly those bytes to `oa-<p>-releases/releases/<version>/<variant>/`, every object `If-None-Match: *`. A version is never overwritten; a partial one (objects byte-identical to the tar, no record) is resumed, and a create-once PUT that answers 412 is accepted only when the object already holds exactly those bytes.
- Writes go through R2's S3 API (`https://<account id>.r2.cloudflarestorage.com/oa-<p>-releases/<key>`, SigV4 via `aws4fetch`, region `auto`) with the env's R2 API token. Cloudflare documents atomic conditional PutObject (`If-None-Match`, `If-Match`) only there ([consistency: conditional writes](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes), [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)); a staging run showed the `api.cloudflare.com` object routes ignore `If-None-Match: *`. The reads a write depends on (the floor and its etag, resume byte checks) use S3 too, so the etag is the one S3 checks. Listings and the `create` release reader stay on the REST routes with the provisioning token: they never write, and `create` needs no R2 write credential.
- `publishRelease` and `publishFloor` first need `probeR2Conditionals(r2, env)` to pass in the same process, on the same S3 client: on a throwaway `probe/` key, an `If-None-Match: *` PUT must land, a second must answer 412, an `If-Match` with a wrong etag must answer 412, and one with the current etag must land. A 2xx where 412 is expected refuses publishing.
- The key ceremony's one-line PR sets the public keys in both `packages/provision/src/internal/gates.ts` and `scripts/ci/release-pubkeys.mjs` (a test pins them equal); the key jobs then refuse a signing key that is not the pinned one.
- The signed floor `releases/floor.json` (`{ env, seq, minVersion, revoked }`, signed over `"oa-release-floor-v1\n" + env + "\n"` plus the record) gates `create`. The platform D1 `release_floor.floor_seq` is only a cache (raised with `MAX`); the anchor is `FLOOR_MIN_SEQ[env]`. `publishFloor` needs a higher `seq`, the same or a higher `minVersion` and a superset of `revoked`, and writes with `If-Match` (or `If-None-Match: *` for the first floor). A 412 refuses with "floor seq exists": the floor changed meanwhile; check it and re-run. It is never retried as success.

### R2 API token (laptop only)

CI does not use a bucket-scoped R2 token: `hosted-ops` derives the S3 key from `CLOUDFLARE_API_TOKEN` (id and SHA-256 of the value), so CI's R2 reach is that token's Workers R2 Storage Edit, account-wide. A user-owned token can't narrow it to one bucket: per [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/) (Access Policy > Resources > Bucket), bucket resources apply only to the Object Read and Object Read & Write groups (Workers R2 Storage Bucket Item Read and Write), and this same token needs the account-wide Workers R2 Storage Edit to create install buckets. The follow-up under "Platform Workers through CI" narrows it once provisioning leaves the CI token.

On a laptop, `publish-release` and `publish-floor` read an R2 API token per env, scoped to that env's releases bucket only. R2 tokens can't be prefilled by URL; create each by hand ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)):

1. In the Cloudflare dashboard of the hosted account, open R2 Object Storage, then Overview, and select Manage next to API Tokens (under Account Details).
2. Select Create Account API token (an account token keeps working if a user leaves the account).
3. Name it `oa-hosted-<env>-r2`. Permissions: Object Read & Write.
4. Scope it to specific buckets only: `oa-s-releases` for staging, `oa-p-releases` for prod. Never both.
5. If an expiry (TTL) is offered, set it short, and roll the token before it ends.
6. Create it. Copy the Access Key ID and the Secret Access Key now: the secret is shown once.
7. Store both in the keychain, as `<accessKeyId>:<secretAccessKey>`, pasted at the prompt (never on the command line):

   ```sh
   security add-generic-password -U -s oa-hosted-<env>-r2 -a open-artifacts -w
   ```

On a laptop the CLI reads only this keychain item. In CI (staging and prod) it reads the 0600 file `hosted-ops` derives, named by `OA_HOSTED_R2_FILE`, with the same rules as `OA_HOSTED_TOKEN_FILE`.

### Key-ceremony checklist (per env, with the user's OK)

1. Confirm the controls on GitHub (all must hold; the script below refuses otherwise):
   - Environments `hosted-staging` and `hosted-prod`: deployment branches `main` only (a custom branch policy that is exactly the branch `main`, not protected branches, not a pattern). This is the real control against a `workflow_dispatch` from another ref reaching the key. Check with `gh api repos/{repo}/environments/hosted-<env>` and `gh api repos/{repo}/environments/hosted-<env>/deployment-branch-policies`.
   - Admin bypass is OFF on both Environments (`can_admins_bypass: false`). Neither Environment has a required reviewer: no one approves a release, and the checks before signing are the gate. Releases sign from `main` only.
   - Two tag rulesets are active on `refs/tags/v*` (nothing excluded). Ruleset A restricts creation, and its only bypass actor is the release App (its numeric id, `RELEASE_APP_ID`). Ruleset B restricts update and deletion with no bypass actor at all, so not even the App can move or delete a release tag. Check with `gh api repos/{repo}/rulesets` and each tag ruleset's `gh api repos/{repo}/rulesets/<id>`.
2. Generate the Ed25519 keypair locally and pipe the private key straight into `RELEASE_APP_ID=<id> scripts/ops/hosted-set-signing-key.sh <env>` (never onto disk). The script runs the `gh api` reads above and refuses the upload unless every control holds; only then does it `gh secret set RELEASE_SIGNING_KEY --env hosted-<env>` from stdin.
3. Put the public key (JWK `x`) in both `packages/provision/src/internal/gates.ts` and `scripts/ci/release-pubkeys.mjs` in one PR (a test pins them equal); flip `PROD_UNLOCKED` there for prod.

### Platform resource names (per env)

Every name carries the env prefix `oa-<p>-` (`oa-s-` staging, `oa-p-` prod), and provision refuses to touch a name without it. The source is `platformNames` in `packages/provision/src/names.ts`.

| Name | What it is |
| --- | --- |
| `oa-<p>-platform` | Platform D1 (installs, hosts, audit, floor cache) |
| `oa-<p>-releases` | R2 bucket of signed releases and floors |
| `oa-<p>-hosts` | HOSTS KV (host to install id), read by dispatch |
| `oa-<p>-broker-registry` | Install registry KV, bound only by the sign-in broker |
| `oa-<p>-directory-registry` | Copy of the install registry, bound only by the directory broker (`DIRECTORY_REGISTRY`) |
| `oa-<p>-auth-broker` | P2 sign-in broker Worker |
| `oa-<p>-directory-broker` | P3 directory broker Worker |
| `oa-<p>-dispatch` | Dispatch Worker |
| `oa-<p>-scheduler` | Scheduler Worker |
| `oa-<p>-inventory` | Inventory |
| `oa-<p>-turnstile` | The env's one Turnstile widget |

Why a copy: Workers KV has no read-only binding, so a directory broker bound to `oa-<p>-broker-registry` could plant a sign-in trust anchor if it were compromised. Both hold the same key, `install:<id>` (`registryKey` in `names.ts`, the key the auth broker reads). The entry also carries `domains`, the install's `AUTH_DOMAINS` parsed by `@oa/auth-core`'s `parseDomains` (lowercase A-labels, unique, sorted, at most 50, `[]` when none). `updateVars` rewrites both copies in its lease once the vars are live; if it returns `ok: false`, rerun it, because `registryDrift` compares the two copies with each other, not with the vars, so two copies that are equally stale don't show up. Only create and `updateVars` check the domains (more than 50, or invalid, is refused); upgrade and rollback never write the registry and never refuse on it. Provision writes each install's entry to the broker registry first, then the identical value to the directory registry, in the same step. Delete removes the directory copy first, then the broker entry, so the directory never trusts a key that sign-in has dropped. `WfpProvisioner.status(id)` reports drift per install in `registryDrift` (`missing_broker`, `missing_directory`, `mismatch`, or `missing_both` for an install that should have an entry: active, upgrading, or creating past the registry step) and never repairs it.

Fixing drift: for a `creating` install, rerun `create`; it finishes both writes. For a `deleting` install, rerun `delete`. There is no repair op for an `active` install yet: `create` refuses it, and nothing else writes the copy. That is fine for M1, because no env has a brokered install yet (T9 has not run).

TODO (Platform): before directory sync is enabled on any env that already has brokered installs, ship a lease-held backfill op that copies each broker entry to the directory registry (one way only, never directory to broker). The repair op overwrites the directory copy from the broker entry, never the reverse.

### Inventory `GET /hosts` (read-only, for the red-line suite)

`apps/inventory` binds `HOSTS` (`oa-<p>-hosts`) next to `PLATFORM_DB`; the Worker only reads both (a source test forbids KV and D1 writes). Same `Authorization: Bearer <INVENTORY_KEY>` as `/installs`, and the same plain 404 for anything else. `GET /hosts` returns `{"hosts":[{"host","installId"}],"complete":true}`, sorted by host, paged through every KV cursor, capped at 10,000 keys (`complete:false` past it). `GET /hosts?host=<h>` returns `{"host","installId"}` for that exact key (nothing is normalized). `installId` is `null` for a miss or a value that isn't an install id; raw values are never returned. Fill the `HOSTS` id in `wrangler.jsonc` at deploy, as for `PLATFORM_DB`. The red-line env reads the endpoint through `REDLINE_STG_INVENTORY_URL` (variable) and `REDLINE_STG_INVENTORY_KEY` (secret).

### First-create checklist (per env)

1. Create the KV namespaces `oa-<p>-broker-registry` and `oa-<p>-directory-registry` side by side, before any provision run on the env (any provision version that includes the directory copy). With the broker on, create and every lifecycle operation (status aside) refuse before any write if either is missing.
2. Apply every platform D1 migration to `oa-<p>-platform` that it does not have yet, in order, before deploying the scheduler or running a CLI that needs it (0005 before the H-DV scheduler, whose 2-minute tick otherwise logs `directory-revoke aborted exception` every time; a delete run before 0005 moves the row to `deleting` and then fails on its first revoke write, so rerun it once 0005 is applied) (0004 adds a column, so it can't be re-run; check with `PRAGMA table_info(hosted_audit)` before applying it): `apps/platform-db/migrations/0001_installs.sql`, then `0002_release_floor.sql` (the `release_floor` cache), then `0003_lifecycle.sql` (per-version metadata, the operation lock and the session-cut journal), then `0004_audit_actor.sql` (the `hosted_audit.actor` column the CLI writes), then `0005_directory_revoke.sql` (the four directory revoke columns and the `installs_revoke_pending` index; `owner_email` is unchanged; not re-runnable, so check `PRAGMA table_info(installs)` for `directory_revoke` first). Without 0002, create fails closed on the floor_seq read; without 0003, create fails closed on its first metadata write; without 0004, every `oa:hosted` command fails closed on its first audit row; without 0005, delete stops at its first revoke write with the row already `deleting` (rerun after applying it).
3. Key ceremony done: `RELEASE_PUBKEY[env]` set in gates.ts (and `PROD_UNLOCKED` for prod).
4. Laptop only (CI derives its key): create the env's R2 API token and keychain item `oa-hosted-<env>-r2` (see "R2 API token").
5. Sign the env's first floor with the `hosted-floor` workflow (dispatch on `main`: `env`, `seq` >= `FLOOR_MIN_SEQ[env]`, `min_version`, `revoked`), download its `floor-<env>-<seq>` artifact, and `publishFloor` it.
6. `publishRelease` the signed tar and `.sig.json` from the GitHub release for each variant the env takes.

### Release checklist: revoking a version or raising the floor

1. For each env, dispatch the `hosted-floor` workflow on `main` (next `seq`, `min_version`, `revoked` keeping every earlier entry), download the `floor-<env>-<seq>` artifact and run `publishFloor` with it.
2. In the same change, bump `FLOOR_MIN_SEQ[env]` in `packages/provision/src/internal/gates.ts` to the new `seq`, so a replayed older floor is refused even if the D1 cache was reset.
3. Merge and release; creates refuse any floor below the new anchor.

### The `oa:hosted` CLI (Task 8)

`pnpm oa:hosted <command> --env staging|prod [flags]` wraps `@oa/provision` (`scripts/hosted/src/cli.ts`); it holds no provisioning logic of its own. It prints one JSON line per step and never a token, PAT, secret or generated key.

| Command | Flags | Wraps |
| --- | --- | --- |
| `create` | `--slug`, `--owner`, `--to <version>`, `--var K=V`..., `--test-hooks` (staging only), `--install <id>` to resume | `create` (bundle `redline` with `--test-hooks`, else `release`) |
| `upgrade` | `--install`, `--to` | `upgrade` |
| `rollback` | `--install` | `rollback` |
| `update-vars` | `--install`, the full set of `--var K=V` | `updateVars` |
| `delete` | `--install`, `--confirm <same id>`, `--skip-directory-revoke "<reason>"` | `delete`: waits for the directory revoke (one progress line at most every 60 s), then tears down |
| `release-lease` | `--install`, `--confirm <same id>`, `--force` | `releaseLease` |
| `status` | `--install` | `status` (state, versions, lease, `sessionCut.pending` and `sessionCut.armed`, registry drift, `directoryRevoke`, `owner` as `(set)` or `(purged)`) |
| `publish-release` | `--tag v<version>` | `gh release download` of `oa-release-<env>-*` into a temp dir, then `probeR2Conditionals` and `publishRelease` per variant |
| `publish-floor` | `--floor <path to floor-<env>-<seq>.sig.json>` | `probeR2Conditionals`, then `publishFloor` |
| `turnstile-init` | none | `turnstileInit`: creates `oa-<p>-turnstile` once (managed, exactly the env's app domain). Every create attempt is preceded by a listing by that exact name, so a create whose reply was lost is adopted, not duplicated. A same-named widget that differs is refused, and two or more are refused with both ids |
| `redline-creds` | `--install`, `--confirm <same id>` (staging only, laptop only) | The red-line suite's credentials for rl-a or rl-b (see below) |
| `owner-token` | `--install`, `--confirm <same id>` (laptop only) | `reissueOwnerToken`: mints a fresh owner PAT (label `provision`) into the install's 0600 PAT file under the lease, and retires the earlier `provision` tokens |
| `ci-token-sweep` | `--install`, `--run <GitHub run id>` | `ciTokenSweep`: revokes every active owner token labelled `ci-<run id>` in the install's D1, then lists them again and exits 1 unless none remains (no lease; a deleted install has none) |

- `pnpm oa:hosted --help` prints every command and flag. The flags beyond the plan's list: `--tag` (publish-release), `--floor` (publish-floor) and `--force` (release-lease only: releases a live lease, only when no operation is running).
- Sign-in broker: on for an install whose vars turn google on (`AUTH_PROVIDERS` includes `google`); there is no flag. `create` reads it from `--var`; `update-vars` from the new `--var` set or the install's current vars; the other commands from the install's current vars. With it on, provision requires both `oa-<p>-broker-registry` and `oa-<p>-directory-registry`, writes the entry with origin `https://<app host>`, and renders `AUTH_BROKER_URL` as exactly `https://auth.<the env's app domain>` and `DIRECTORY_BROKER_URL` as exactly `https://directory.<the env's app domain>` (without it the server's directory transport is `none` on HOSTED=1, so directory sync would be dead) and `GOOGLE_CLIENT_ID` as the env's broker client (`BROKER_GOOGLE_CLIENT_ID`, equal to `apps/auth-broker/wrangler.jsonc`, pinned by a test) on every upload. Prod's is the sign-in client in project `open-artifacts-prod`, the same id the prod deploy fills into the broker's `{{GOOGLE_CLIENT_ID_PROD}}`. A caller `AUTH_BROKER_URL` or `GOOGLE_CLIENT_ID` that differs is refused, `GOOGLE_CLIENT_SECRET` is never a hosted var, google with no `AUTH_DOMAINS` (after the server's own parse) is refused, and google with the broker off is refused, both before any write.
- Google on an existing install is not supported yet: the broker key and the first registry entry are only issued at create, so `update-vars` that turns google on for an install with no broker key is refused before any write (no session cut). TODO (Platform): a broker-enrol op for active installs.
- Upgrade and rollback never refuse on these: a stale stored `AUTH_BROKER_URL` or `GOOGLE_CLIENT_ID` is re-rendered as the derived value, with a note.
- Google off: `update-vars` that turns google off keeps the install's registry entry (still trusted, its domains still synced) until a broker-disable op exists.
- Refused before any call: `--test-hooks` with `--env prod`, `delete` or `release-lease` whose `--confirm` is not the `--install` id, a `--var` that `HOSTED_VARS` rejects, and any missing or malformed flag.
- Token: the keychain item `oa-hosted-<env>` with account `open-artifacts` (`/usr/bin/security find-generic-password -a open-artifacts -s oa-hosted-<env> -w`, never a PATH lookup). Every keychain read and write the CLI does uses that account, the Turnstile item included. CI reads a 0600 file it owns, named by `OA_HOSTED_TOKEN_FILE`, opened with `O_NOFOLLOW` (a symlink is refused) and checked and read through that one fd (`fstat`), never by path again. On a laptop, prod refuses that variable (keychain only). Then the provisioner's own token checks run (`verifyToken`) before the CLI's first write.
- Prod in CI: refused ("CI is staging only; prod refused") unless all three hold: `GITHUB_ACTIONS=true`, `GITHUB_REF=refs/heads/main` and `OA_HOSTED_ENVIRONMENT=hosted-prod-deploy` (set by `hosted-ops.yml` from the same expression that picks its Environment). `CI=true` alone is CI and refused for prod. The check runs before any secret is read or any call. GitHub's Environment protection (main only) and the workflow's automated gates are the real control; no person approves a run. This check stops a misconfigured workflow from reaching prod. Prod in CI then reads both the token and the R2 credentials from their files, with the same checks.
- R2 credentials (`publish-release` and `publish-floor` only): on a laptop, the keychain item `oa-hosted-<env>-r2`, account `open-artifacts`, holding `<accessKeyId>:<secretAccessKey>` of a bucket-scoped token (see "R2 API token" above). The item name is per env, so another env's token is never read; R2 also denies that token outside its one bucket. CI uses a 0600 file named by `OA_HOSTED_R2_FILE`, derived from `CLOUDFLARE_API_TOKEN` (account-wide R2 reach, see "R2 API token"), with the same `O_NOFOLLOW` and `fstat` rules as the token file and the same prod guard; prod on a laptop refuses it. Both halves are redacted from every output line and never reach argv, a child's environment, an error or the audit.
- `--ci-owner-token` (CI only: refused outside CI, without a numeric `GITHUB_RUN_ID`, and on any command but `create`, `upgrade`, `rollback` and `update-vars`): the selftest runs on an owner PAT labelled `ci-<GITHUB_RUN_ID>`, minted into the install's D1 right after the operation claims its lease, held only in memory (never a file, an output line, an error or the audit) and revoked, then read back, before the lease is released. No PAT file is read or written: `create` gives the owner no PAT from provisioning (they sign in), and `upgrade`, `rollback` and `update-vars` skip the PAT-file pre-flight. A failed revoke is a note naming the sweep, and the operation's result stands. With the flag, the CLI prints `{"step":"ci-owner-token","install":"<id>"}` for the workflow's sweep.
- `CLOUDFLARE_ACCOUNT_ID` must be the hosted account id; it also names the S3 endpoint.
- Turnstile keys: on a laptop, the keychain item `oa-hosted-<env>-turnstile` holds `<sitekey>:<secret>` (CI reads a file derived from the env's widget instead, see `hosted-ops.yml` below). `turnstile-init` writes it through `/usr/bin/security -i` on stdin (never argv) and reads it back; `create`, `update-vars`, `upgrade` and `rollback` read it (every command that renders an install's vars).
- Turnstile test keys: a test-hooks install (rl-a and rl-b on staging) with codes on always gets Cloudflare's always-pass pair (sitekey `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`, `TURNSTILE_TEST_KEYS` in provision), never the env widget, so the red-line suite can sign in by code. `update-vars` re-sends that secret every time, which moves an install that held the env's secret onto the test pair; rotation skips test-hooks installs. Any other install refuses a Cloudflare test key (`1x`/`2x`/`3x`) as the env widget, and prod refuses test keys always.
- Audit: every command writes `cli.<command>.start` before it acts and `cli.<command>.done` or `.failed` after, with `actor` set to `git config user.email` (or the CI run URL).
  - The actor is attribution, not authentication: anyone can set `git config user.email`, and the row records what the operator's machine claimed.
  - `hosted_audit` is append-only by convention: triggers refuse UPDATE and DELETE. That is not a security boundary against someone holding the D1 (provisioning) token, who can drop the triggers or the table.
  - Audit gap: a failed after-row is retried once. If the retry fails too, the CLI prints `AUDIT GAP: <command> <install> took effect, after-row not written` on stderr, exits 3, and records the gap in a 0600 file under `~/.config/oa-hosted/pending-audit/` (directory 0700), named `<env>-<install>-<time>.json`, holding only env, install id, action, command, exit code and actor. The next command for that install (same env) writes the recovered after-row first (detail `recovered: 1`), then removes the file. If even the file can't be written, stderr says to add the row by hand.
- Release candidate on the red-line installs (before the final gate, T19): `CLOUDFLARE_ACCOUNT_ID=<hosted account> scripts/ops/redline-deploy.sh vX.Y.Z [--with-rl-b]` publishes that tag's staging release (an already published one is fine: a version is never overwritten), upgrades rl-a (and rl-b), and exits non-zero unless each install's `/healthz` reports that version and its own install id. An upgrade keeps the install's data. The gate then checks `rl-a /healthz version == the tag`.
- PAT files go to `~/.open-artifacts/hosted-<env>/` (laptop runs; CI runs use `--ci-owner-token` instead). Every lifecycle operation (upgrade, rollback, update-vars) runs its pre-flight and selftest with that owner PAT, so every install keeps one there, the red-line installs rl-a and rl-b included; never revoke it. If the file is lost or the token was revoked, `owner-token` re-mints it. The red-line suite never uses it: it signs in as its own admin test user (`redline-creds`).
- `redline-creds` (P5): for an active staging install with test hooks whose slug is `rl-a` or `rl-b` only, and whose `/healthz` reports `testHooks: true` and that install id. It reads the hook key from create's 0600 file `~/.open-artifacts/hosted-staging/<app host>-hook-key` (`O_NOFOLLOW`, `fstat`), opens a session for the suite's admin test user `redline-admin@<TEST_DOMAIN>` (`POST /__test/session`; never the owner), mints one PAT labelled `redline-<UTC yyyymmddhhmm>`, and checks it on `/api/v1/me`. Then it sets `REDLINE_RL_A_PAT` and `REDLINE_RL_A_HOOK_KEY` (or `RL_B`) in the `redline-staging` Environment with `gh secret set` on stdin, writes the same two values as 0600 files `REDLINE_RL_A_PAT` and `REDLINE_RL_A_HOOK_KEY` (or `RL_B`) in `~/.open-artifacts/redline-capture/secrets/` (0700, `O_NOFOLLOW`; the suite's `secretsDir` layout, for a local run such as the sign-in capture), and only then revokes that user's earlier `redline-*` PATs, so at most one is live. The token API has no scope or expiry, so every run rotates. The PAT, the key and the session cookie are redacted from every output line and never reach argv, a child's environment or the audit. An HTTP failure reports only the status.
- Delete revokes the Google directory grant first (H-DV):
  - Phase 1: claim the lease, set `state='deleting'`, `directory_revoke='pending'`, `directory_revoke_attempts=0` and `directory_revoke_requested_at` (this attempt's start), unmap every HOSTS key of the install (the revoke job needs none, and the dispatch Worker 404s at once), audit `delete.revoke_pending`, release the lease. Every read-only refusal (a resource id that isn't `names(id)`'s) comes before this, so a refused delete writes nothing. Every rerun that isn't already settled starts a fresh attempt this way.
  - Phase 2: poll the row every 15 s, up to 10 minutes, until the scheduler sets `done`; then the teardown (its unmap is an idempotent no-op). A `done` unlocks teardown only if `directory_revoked_at >= directory_revoke_requested_at`; a stale `done` from an earlier attempt is set back to `pending` (at a poll, or at the teardown's re-read) and waited for again.
  - `unsupported` (an install below `REVOKE_MIN_VERSION`, or no script) is audited as `delete.revoke_unsupported` and refused: "install <id> is below <REVOKE_MIN_VERSION> and can't confirm the Google revoke; upgrade it or pass --skip-directory-revoke <reason>". It never tears down by itself.
  - Still `pending` after 10 minutes, or `failed`: refused, and the row stays `deleting`.
  - `--skip-directory-revoke "<reason>"`: the `delete.revoke_skipped` audit row is written before the row says `skipped`, and a `skipped` row with no such audit row is refused until the flag is given again. A one-line reason, at most 200 characters, no email (it goes to hosted_audit as `delete.revoke_skipped`). It sets `skipped` and tears down at once, also from `pending` or `failed`, and prints: "the Google grant stays live; revoke it in the customer's Google Admin console: Security > Access and data control > API controls > Manage Third-Party App Access (Manage App Access in newer consoles), find the Open Artifacts Directory app, then Change access to Blocked" (path checked against Google's Workspace Admin help, 2026-10-26).

### `hosted-ops.yml`: the CLI in CI

Every hosted install operation and release publish runs from the `hosted-ops` workflow (dispatch on `main`), never a laptop. The platform Workers deploy from `deploy-hosted-platform` instead.

- Inputs: `env` (staging or prod), `op` (`create`, `upgrade`, `rollback`, `update-vars`, `status`, `delete`, `release-lease`, `turnstile-init`, `publish-release`, `publish-floor`), `install`, `tag` (a stable `vX.Y.Z`: the version for `create` and `upgrade`, the release for `publish-release`), `args` (JSON) and `confirm` (the install id again, for `delete` and `release-lease`).
- `args` per op: `create` `{"slug","owner","to"?,"var"?:["K=V"],"testHooks"?}` (`testHooks` staging only; `to` must equal the tag when both are given), `update-vars` `{"var":["K=V",...]}` (the full set; only names `HOSTED_VARS` accepts), `delete` `{"skipDirectoryRevoke"?:"<reason>"}`, `release-lease` `{"force"?:true}`, `publish-floor` `{"floor":{"record","signature"}}` (the signed floor from a `hosted-floor` run's artifact; `publishFloor` verifies it). Every other op takes `{}`.
- Environment: `hosted-prod-deploy` for prod, `hosted-staging-deploy` for staging (main only, no required reviewer: no run waits for a person), the same one `deploy-hosted-platform` uses. Secret: `CLOUDFLARE_API_TOKEN`, the env's one user-owned token (scopes under "Platform Workers through CI"). The Environment secret is the source of truth; a laptop's keychain item `oa-hosted-<env>` is a copy that a roll invalidates. The account id comes from `.github/hosted/<env>.json`. Derived in the run, each into a 0600 file the CLI reads, never in args or output:
  - R2 (`publish-release`, `publish-floor` only): `scripts/ci/hosted-r2-key.sh` reads the token's id from `GET /user/tokens/verify` and writes `<token id>:<sha256 hex of the token>`, Cloudflare's S3 credentials for an API token ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), "Get S3 API credentials from an API token"). Both halves are masked first. A status other than `active` or any API error fails the step.
  - Turnstile (`create`, `upgrade`, `rollback`, `update-vars`, the ops that render an install's vars): `scripts/ci/hosted-turnstile-keys.sh` finds the widget named `oa-<p>-turnstile` in the account's widget list (every page, exactly one), reads its secret from the widget's own GET (the list omits it), masks it and writes `<sitekey>:<secret>`. No such widget writes no file and no flag, and provision then refuses a codes-on install by itself. Two or more widgets, an empty secret or any API error fails the step.
- `create` reads its owner email from the `CREATE_OWNER_EMAIL` secret (the repo is public and so are a run's inputs, so the owner's email is never an input, and `args` refuses an `owner` key). It is retiring with the `hosted-ops` create: the owner email moves to the Provisioning API's create body, so there is no terminal step to set it.
- Steps: prod checks `github.ref` is main; checkout of the workflow's commit; `scripts/hosted/src/ci-args.ts` validates the inputs (passed through env, never shell text) and prints the CLI argv as a JSON array; one step, the only one that sees the token, writes it (and the derived R2 or Turnstile keys) to 0600 files under `umask 077` with `set +x`; `pnpm -s oa:hosted <argv>` runs with `--ci-owner-token` for `create`, `upgrade`, `rollback` and `update-vars`; then, always: `ci-token-sweep` for those ops, removal of the files, and a job summary of every JSON line (already redacted).
- Concurrency: one run per `hosted-ops-<env>-<install or env>`. Audit actor: the run URL.
- Gates (user ruling, 2026-10-30: no person approves a release to prod; a check that should have caught a problem fails first):
  - Release gate: every `create`, `upgrade` and `publish-release` run (both envs) runs `scripts/ci/tag-passed-checks.sh <env> <tag>` right after the inputs check, before any token is read. The tag is the version being installed (create, upgrade, from `tag` or `args.to`) or published; `ci-args.ts` hands it over as the `release` step output. It fails closed: a tag that is not a published stable release on `main` whose release-please run and checks passed, or any API error, stops the run. The workflow gets `actions: read` for it.
  - "Prod is clean": a prod `create` or `upgrade` first runs the `precheck` job in the `redline-staging` Environment (where the read-only `REDLINE_PROD_*` secrets live), which runs `tests/redline/src/prod-clean-cli.ts` (the red-line suite's `prodClean`). Only a pass lets `op` run. The one exception: `not-applicable` passes for a `create` when the prod inventory reads back an empty install list (the first prod install). Any other result, a fail or an error fails the precheck, and `op` is skipped. Staging runs and the other ops don't need it.
- The sweep: when the CLI never finished and a `create`'s install is unknown, the step fails naming the label (`ci-<run id>`) to sweep by hand: `pnpm oa:hosted ci-token-sweep --env <env> --install <id> --run <run id>`.
- Laptop only: `turnstile-init` (it creates the env's widget and writes the keychain item; in CI it is refused, "laptop only"). Every other op runs in CI, and the ops that render an install's vars read the pair from the env's widget (above). Until `turnstile-init` has made the widget, a codes-on install that is not a test-hooks install can't be created, upgraded, rolled back or have its vars changed (provision refuses: the Turnstile sitekey and secret are missing). Test-hooks installs (rl-a, rl-b) get the test pair and work.

### Leases and recovery (Task 5)

- **Rollback barrier at Durable Object tag v3.** The release that adds tag v3 (`DirectorySync`, #571) is a rollback barrier for hosted installs. Provision refuses any rollback that crosses a Durable Object migration tag, so an install on that release or later can't roll back below it: fix forward instead. This is separate from the signed release floor (`releases/floor.json`, `minVersion`), which this doesn't raise.
- Every create, upgrade, rollback, var change, Turnstile rotation and delete holds the install row's lease (`installs.lease`, `lease_until`, 30 minutes, renewed before each step). A second operation on the same install is refused while the lease is live. `status(id)` shows the state, the versions, `lease_until` and any pending session cut without taking the lease.
- Use one `WfpProvisioner` per concurrent operation. A second operation started on an instance that is already running one is refused.
- **After a `<op>.lost_lease` audit row** (the operation stopped with "lost the lease"), check `status(id)`. After `create.lost_lease`, re-run `delete(id, confirm: id)` if the install should go, or re-run create to resume it. Either one claims the row only once the other operation's lease has ended.
- **The lease has a time-of-check to time-of-use window.** An operation renews its lease and then makes its Cloudflare call. If the process stalls for longer than the lease between the two (for example, a laptop sleeps), another operation can claim the row in the meantime, and the stalled call still lands once. Example: a create's `HOSTS` put lands after a delete has unmapped the hosts. The stalled operation's next step raises `LostLease`, so it goes no further. A stale `HOSTS` entry left this way points only at the deleted install's id, never at another install: the dispatch Worker finds no script and answers 404. To clear it, re-run delete, which removes the `HOSTS` keys first.
- **A pending session cut** (`status(id).sessionCut.pending`) means google was turned on and the epoch bump that ends earlier sessions has not run yet. Re-run `updateVars` with the intended vars; any upgrade or rollback also settles it right after its upload. Rotation refuses while a cut is pending.
- A lease left by a dead process: `releaseLease(id, confirm: id)` once it has expired, or with `force: true` only when you are sure nothing is running. Both are audited.
