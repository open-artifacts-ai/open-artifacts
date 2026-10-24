# Hosted M1 · P1: Hosting on Workers for Platforms (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run any number of isolated Open Artifacts installs as user Workers in one Workers for Platforms dispatch namespace, provisioned through one interface that also wraps today's self-hosted `oa:setup`, and hand-provision FinQore on it.

**Architecture:** A new package `@oa/provision` defines `Provisioner` (create, upgrade, rollback, delete, export, import) with two implementations: `WfpProvisioner` (Cloudflare REST API only, no wrangler, no laptop state) and `SetupProvisioner` (adapter over `@oa/setup`). Two small platform Workers sit in front: `apps/dispatch` maps a hostname to an install ID and forwards the request untouched; `apps/scheduler` runs every install's nightly job through the dispatch namespace. The server code is unchanged in both modes.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers for Platforms, D1, R2, KV, Durable Objects, vitest (`@cloudflare/vitest-pool-workers` for the two Workers), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` (sections 3, 4.1, 4.4, 4.7, 4.8, 5). Roadmap: M1 "FinQore pilot".

## Spec 4.8 open items, confirmed against Cloudflare docs (2026-10-20)

| Item | Finding | Consequence |
|---|---|---|
| Cron Triggers in user Workers | **Not supported.** Cloudflare staff on workers-sdk#13840 (2026-05-11); Wrangler now warns that crons are ignored with `--dispatch-namespace`. No `/schedules` API for namespace scripts. | The central scheduler (Task 7) is required, not optional. |
| Per-customer logs | Workers Logs per user Worker by setting `observability` in the upload metadata, queryable per script through the Workers Observability API. Logpush can cover the whole namespace via the dispatch Worker. | Task 3 sets `observability.enabled`, `logs.enabled`, `head_sampling_rate: 1` and **`invocation_logs: false`** on every upload (signed content paths are bearer credentials). |
| Live tail per customer | Tail Workers attach per user Worker (`tail_consumers` in upload metadata); a Tail Worker on the dispatch Worker gets two trace items, one for each Worker. | No Tail Worker in M1; Workers Logs is enough for one customer. Recorded in the runbook. |
| D1 per account | 50,000 databases, 10 GB each (hard), **1 TB total per account** (raisable). | ~100 installs at the 10 GB cap before a raise; fine for M1. |
| R2 per account | 1,000,000 buckets. | No constraint. |
| **KV per account** | **1,000 namespaces** (Free and Paid). | **Caps hosted at ~1,000 installs** (one `OAUTH_KV` each). Not an M1 problem; flagged to the Manager for M2. |
| Cloudflare API | 1,200 requests per 5 minutes per token. | Upgrade waves (M2) must budget calls; a create costs ~15. |
| Unsupported in user Workers | `caches.default`, `request.cf`, gradual deployments. The server uses neither API (verified: no matches in `apps/server/src`). | Each upgrade goes to 100% at once. |

## KV cap: inventory and the M2 move (Manager: note for M2, not built in M1)

The 1,000-namespace KV cap matters only because each install gets its own namespace. Inventory on `origin/main`:

| Binding | Used by | Operations | Holds customer data |
|---|---|---|---|
| `OAUTH_KV` (one per install) | `@cloudflare/workers-oauth-provider` (reads `env.OAUTH_KV` directly: 19 get, 9 put with `expirationTtl`, 6 delete, 7 prefix `list` with cursor); `services/usage.ts` reads its id for KV analytics | MCP OAuth clients, grants, tokens (hashed) | Yes |
| P3 content-URL deny list (planned, behind a flag) | content host | revoked user ids, ~60 s TTL | User ids only; must live in the install's own namespace (no new namespace), and moves with `OAUTH_KV` (with the `test:otp:` keys) in M2 |
| Platform `HOSTS` (this plan, one total) | dispatch Worker | host → install ID | No (metadata only) |

Nothing else in `apps/server/src` uses KV. Spec 3 rules out the obvious fix (one shared KV with per-install key prefixes): it would be a shared store holding customer data.

**Proposal (M2, Backend-owned code, Platform provisioning):** replace the per-install KV namespace with a KV-compatible shim backed by the install's own D1. A table `oauth_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)` and a `d1Kv(db): KVNamespace`-shaped object implementing `get` (text and json, filtering out expired rows), `put` (with `expirationTtl`), `delete`, and `list({ prefix, cursor, limit })` as a key-range scan (`key >= prefix AND key < prefix || char(0x10FFFF)`), swept by the existing nightly job. `serveAppHost` passes `{ ...env, OAUTH_KV: d1Kv(env.DB) }` to the provider. Each install keeps its own store, so the red line holds, and the cap goes away. M2 must also verify, before building: whether the provider uses `getWithMetadata` or `metadata` on `put`/`list`; that `list` cursor semantics (opaque cursor, `list_complete`) match; and D1 read latency on `/mcp` (with the D1 Sessions API for read-after-write). Durable Objects were the alternative; D1 wins because the data is small, already per install, and needs no new class or migration tag. Costs to check in M2: D1 rows written per token refresh (2 KV writes become 2 D1 rows, inside the Paid allowance) and the CPU budget on `/mcp` (one indexed read). Migration for live installs: dual-read (D1 first, then KV) for one release, then drop the KV binding. Self-hosted installs get the same change, so the code stays identical.

**Ratelimit namespaces, found while checking:** `RL_ANON` uses `namespace_id: "1001"`. A namespace ID is account-wide, so every hosted install would share one per-IP counter, and one tenant's traffic would throttle another's. That isn't a data leak, but it is a cross-tenant effect. Fixed in M1: Task 3 gives each install its own block of IDs (Task 4 allocates `installs.rl_ns`), and Task 1 confirms ratelimit bindings work on user Workers and whether there's a per-account cap.

Answered by the Task 1 spike (2026-10-21, `docs/ops/hosted.md`): `Fetcher.scheduled()` works through a dispatch namespace binding; `send_email`, `browser`, `ratelimit`, `service` and `assets` bindings are all accepted on user Workers, and SQLite Durable Objects work in a namespace. `send_email` delivery and `browser` rendering are not yet exercised.

## Shared account state (review finding 10)

All installs share one Cloudflare account, so some state is shared even though no customer data is:

| Shared thing | Risk | M1 handling |
|---|---|---|
| Email Sending quota and sender reputation | One install's sends exhaust or damage another's | Per-install daily cap: today `MAX_EMAILS_PER_DAY = 100` is hardcoded in `email/send.ts`; Backend is turning it into the var `EMAIL_DAILY_CAP` (default 100) in P2's email-pool task, with a separate `CODE_EMAILS_PER_DAY` (default 200) for sign-in codes; both count toward the account check. Until that lands, `oa:hosted create` checks `100 × installs` against the account limit, and after it, the sum of the vars; sender address `noreply@<slug>.mail.<app-domain>` per install (DNS at the gate), mapped into `EMAIL_FROM`; an alert at 80% of the account limit in the scheduler's nightly run |
| Workers Logs | Invocation logs record request URLs, and signed content paths (`/c/<exp>.<sig>/…`) are bearer credentials, readable account-wide | `invocation_logs: false` on user Workers (Backend's central logger redacts URLs, emails and tokens, with a lint test against raw `console.*`; that PR must merge before the first hosted install); the Observability API token is a separate, read-only token held by Platform only; shortest retention available |
| `ANALYTICS_TOKEN` | An account analytics token would show every install's traffic | Stays in `TEMPLATE_BINDINGS_EXCLUDED`; the Usage page is off in hosted through the `FEATURES` flag `usage_off` (the Usage page and `/api/v1/usage` return 404) |
| Browser Rendering | Noisy neighbour on thumbnails (low) | Accepted for M1; per-install concurrency cap in M2 |
| Same-site tenants | `a.<app-domain>` and `b.<app-domain>` are same-site, so SameSite cookies flow between tenants | The app domain goes into the Public Suffix List private section before the second tenant (Task 10 gate; Backend files it too); P5 checks it |

## Spec gaps closed here (review finding 12)

- **Audit of control-plane actions:** a platform D1 table `hosted_audit(id INTEGER PRIMARY KEY, at INTEGER, actor TEXT, action TEXT, install_id TEXT, detail TEXT)`, append-only (triggers abort `UPDATE` and `DELETE`). Every `oa:hosted` command writes a row before and after it acts (Task 8).
- **Control-plane token:** the CLI's Cloudflare token can read every customer's D1 and R2. It lives in the macOS keychain (`security find-generic-password -s oa-hosted-<env>`), never in a file. CI holds only the staging token; for prod it holds just the inventory key and a Workers Scripts Read token (Task 7b).
- **Custom hostnames:** M4 in the roadmap, not M1. Rule for later: a `HOSTS` key is written only after the Cloudflare for SaaS hostname is active and its ownership verified, and is unique across installs.
- **P2's `HOSTED=1`** is set on every hosted install (Task 3).
- **Backups:** export is `NotInM1`, so FinQore has no R2 or Durable Object backup in M1. **User-accepted on 2026-10-21** (via the Manager): FinQore runs without backup or export until M2. D1 Time Travel (30 days) covers the database only.

## Hosted domains (user decision, 2026-10-21)

| Env | App suffix | Content suffix | Dispatch namespace |
|---|---|---|---|
| prod | `open-artifacts.app` (tenants `<slug>.open-artifacts.app`) | `open-artifacts.page` (`<slug>.open-artifacts.page`) | `oa-prod` |
| staging | `open-artifacts-staging.app` | `open-artifacts-staging.page` | `oa-staging` |

- All four are separate registrable domains in our Cloudflare account, and every tenant hostname is one level deep, so Universal SSL covers them (no Advanced Certificate Manager).
- `hosts(slug, domains)` (Task 2) already refuses equal or nested app and content domains; the CLI (Task 8) takes the pair from a fixed per-env table (`DOMAINS[env]`), never from flags, and a test pins the table to the values above.
- **PSL:** all four domains go in the Public Suffix List private section, each whole domain as a suffix (they are tenant-only). For each: a `_psl.<domain>` TXT record holding the publicsuffix/list PR URL, then one PR listing all four with purpose and contact. Weeks to reach browsers; FinQore alone is fine before then, a second prod tenant waits on it, and P5 marks same-site cases `unproven` until the entries ship.
- **No zone permissions on the provisioning tokens.** With WfP the routing is one wildcard record and one wildcard route per zone, set once (Task 6 deploy, by the user or a one-off ops run), so provisioning needs no DNS or Routes rights at all: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit, and Workers Scripts Read for the check. The two zone-scoped tokens that plan B's per-install Custom Domains needed are retired once the four zones are wired. The account-level rights cross envs (one account), which is why the CLI keeps its env-prefix guard.
- **Token lifetime (user, 2026-10-21):** every laptop-held Cloudflare token has `expires_on` at most **30 days** out. Before any write the CLI calls `/user/tokens/verify` and refuses unless `status` is `active`, `not_before` ≤ now and `expires_on` is set and ≤ now + 30 days; within 5 days of expiry it refuses forward changes (create, upgrade, vars, Turnstile rotation) and lets rollback, delete and lease release run with a warning naming the date (Manager ruling 2026-10-24). The token check is a Workers Scripts **Read** call (`GET /accounts/{id}/workers/scripts?per_page=1`), not a zone probe. Tests pin each refusal.
- **Gate:** no DNS, route or `_psl` write until the Manager gives an explicit go once all four zones are active.

## Workers for Platforms is the M1 target (Manager, 2026-10-21: plan B dropped)

The user enabled Workers for Platforms on the account (`GET /accounts/{id}/workers/dispatch/namespaces` answers 200). The Task 1 spike passed, so M1 goes straight to WfP: there is no plan-B install and **no export/import cutover**. Results and the rulings below: `docs/ops/hosted.md` (PR #407).

- **One provisioner, one target.** `WfpProvisioner` takes `target: { kind: "namespace"; ns: string }`. Every `cf.ts` script call goes to `/accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}` (upload, secrets, settings, assets, delete). Everything else is unchanged: names by install ID (`oa-<id>`, env-prefixed), per-install D1, R2, KV and secrets, upload metadata, the drift test, resume, rollback rules, the platform D1. Keep the `account` target in `cf.ts` for tests and for the dispatch Worker itself (platform scripts live in the account).
- **Routing: one dispatch Worker, two wildcard routes per env.** `apps/dispatch` maps `Host` → install ID (platform D1 or `HOSTS`) and forwards the request untouched. Each env wires **both** its tenant zones: a proxied `*` AAAA record and the route `*.<zone>/*` → `oa-<env>-dispatch`, for `<env>.app` and `<env>.page` (four zones in total). Universal SSL covers the one-level tenant names; both routes and both records are part of Task 6's deploy, and Task 9's smoke checks a host on each zone.
- **An unmapped host never reaches an install.** The dispatch Worker answers a plain 404 for anything not mapped: a typo, an old install, uppercase, a trailing dot, a port, a bare apex, or the `www`/`auth`-style platform names. No fallthrough to a default install, no 500. P5 adds the cross-install case (a host mapped to A must never serve B's content).
- **Tokens: no zone permissions.** The per-env provisioning token needs Workers Scripts Edit (which covers dispatch namespaces and their scripts, assets, secrets and subdomain), D1 Edit, Workers R2 Storage Edit and Workers KV Storage Edit, plus Workers Scripts Read for the check. DNS and routes are a one-time per-zone setup, not a provisioning permission, so DNS Edit, Zone Read and Workers Routes Edit are dropped from the provisioning tokens and the two zone tokens are retired once the four zones are wired.
- **Scheduler: central, no per-install crons.** Task 7 calls `DISPATCHER.get(names(id).script).scheduled({ cron, scheduledTime })` for every active install (10 at a time, 25 s timeout each). The signed `/__oa/nightly` route is **not** part of M1; Backend's contract stays parked for M2.
- **Durable Object migration tag.** The settings API does not expose it (`migration_tag` is null for account and namespace scripts alike). Read it with the 412 probe: send the upload with a deliberately empty or wrong `old_tag` and parse `expected tag is '<tag>'` from `Actor migration tag precondition failed` (the upload is rejected, nothing changes). Alternatively record the tag in `installs` on our own uploads and reconcile it with the same probe on resume. Either way: **send no `migrations` when the live tag already equals the target** (re-sending an applied migration fails 400/412).
- **Limits.** Scripts per dispatch namespace are unlimited, so the account's 500-script cap and the "refuse under 50 free slots" rule are gone. D1 50,000 DBs / 1 TB per account, R2 no constraint, **KV 1,000 namespaces per account stays the ~1,000-install cap** (M2: the D1-backed KV shim). Rate limiting counts per Cloudflare location, so a tenant can exceed its own limit across colos.

## Test-hook bundles (agreed with Backend, 2026-10-21; #393)

Backend's test hooks are guarded at build time by the define `__OA_TEST_HOOKS_ALLOWED__` (the template sets `"false"`). So each release has **two bundles from one dry-run config**, differing only in that define:
- `release` (`false`): uploaded to every install, prod and staging alike, except the red-line pair.
- `redline` (`true`): uploaded only to `rl-a` and `rl-b`, the only installs with `test_hooks = 1` (staging only). `stg-a`, `stg-b` and self-hosted staging get no hooks; `wrangler.staging.jsonc` is unchanged.

Safeguards, each pinned by a test:
1. `buildBundle` emits both variants. A test normalizes the one define literal and fails if the two bundles differ in anything else. (The hook code is present in both; only the literal differs.)
2. A mandatory CI check runs the **release** bundle with `TEST_HOOKS=1` and a valid key and asserts 404 on every `/__test/*` path. This is the real proof that release is inert.
3. The provisioner refuses to upload `redline` to any install unless `test_hooks = 1` and the env is staging; it refuses `release` on an install with test hooks too, so the red-line pair never silently loses its hooks.
4. `/healthz` reports `testHooks: true` only when hooks are on; the field is absent otherwise. P5's prod check asserts `testHooks !== true`, and the secret and settings check stays the real proof.

## Global Constraints

- Same product, same code: the user Worker is the normal `apps/server` build. No hosted-only branches in `apps/server/src`.
- Isolation per install: own Worker, D1, R2, KV, Durable Objects and secrets. No table or bucket shared across installs holds customer data. Platform storage holds only install metadata.
- Every resource is named by install ID (`names(id)`, Task 2).
- Secrets are generated per install and sent to Cloudflare as `secret_text` bindings in the upload; they're never stored, logged or printed. The owner PAT and, on test installs only, the test-hook key go to 0600 files.
- The control plane's (here: the CLI's) Cloudflare token is scoped to: Workers Scripts Edit, Workers for Platforms Edit, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit. No zone or DNS permissions.
- Upgrades never pass `--allow-downgrade`; the downgrade guard applies.
- Durable Object class additions ship **one release before** the code that uses them (the class exists, unused, for a release), and every upgrade that carries a new DO migration tag is first proven on `rl-a` and `rl-b` (P5's gate runs it). Task 5 refuses a hosted upgrade whose release adds a tag and code that binds it in the same version (the release metadata records which classes are referenced).
- Free-plan-style CPU budgets still apply per request; the dispatch Worker adds under 1 ms CPU.
- Tests run as `env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run`; never print env.
- Copy: no em dashes in user-facing copy; say "any AI agent".
- Human gates (ask the Manager, do not act): the Workers for Platforms subscription ($25/month); buying or adding the hosted app and content domains; any DNS record or Worker route on them; FinQore's go-live.

## Review Focus

1. **A hostname that isn't mapped** (typo, old install, uppercase, trailing dot, a port, a bare apex) must get a generic 404 and never reach another install. Pinned in Task 6.
2. **A create that fails halfway** (D1 created, upload fails, or the broker registry write fails) must resume on rerun by slug, without duplicate resources, and leave the broker keypair consistent on both sides. Pinned in Task 4.
3. **An upgrade whose healthcheck fails** must roll that install back to its previous bundle and report it, leaving other installs alone; a rollback across a Durable Object migration tag is refused (forward-fix only). Pinned in Task 5.
4. **Deleting the wrong install**: `delete` must require `--confirm <installId>` to match and must unmap hosts before touching resources. Pinned in Task 5.
5. **One install's nightly job throwing or timing out** must not stop the others. Pinned in Task 7.

---

### Task 1: Spike and limits record — DONE (2026-10-21)

**Files:**
- Create: `docs/ops/hosted.md` — written, PR #407 (limits table, spike results, rulings, runbook skeleton)
- Create: `scripts/hosted/spike/` (throwaway; deleted with the spike resources)

- [x] **Step 1:** Workers for Platforms is on the account (user, 2026-10-21). `GET /accounts/{id}/workers/dispatch/namespaces` answers 200.
- [x] **Step 2:** `scheduled()` through a namespace binding ran the handler (KV stamp, then the real server script). Task 7 keeps the primary path.
- [x] **Step 3:** The real 0.22.0 bundle uploaded with 27 bindings live (`d1`, `r2`, `kv`, DO, `ratelimit`, `browser`, `send_email`, `assets`, `service`, secrets); SQLite DOs work in a namespace; assets use the 32-hex manifest hash and a 202→201 jwt flow; `keep_assets` works without a jwt. Wildcard DNS + wildcard route to a dispatch Worker served the install on a mapped host and answered 404 on an unmapped one.
- [x] **Step 4:** Results and rulings in `docs/ops/hosted.md`.
- [x] **Step 5:** Spike namespace, scripts, D1, R2, KV, route and DNS record deleted.

### Task 2: `@oa/provision` package: types, install IDs, names

**Files:**
- Create: `packages/provision/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/names.ts`
- Test: `packages/provision/test/names.test.ts`

**Interfaces:**
- Produces:
  - `type InstallId = string` matching `/^i[a-z0-9]{11}$/`; `newInstallId(): InstallId` (crypto random, base32 lowercase); `isInstallId(s: string): s is InstallId`.
  - `names(id: InstallId): { script: string; d1: string; r2: string; kv: string }` → `oa-<id>`, `oa-<id>`, `oa-<id>`, `oa-<id>-oauth`.
  - `hosts(slug: string, domains: { app: string; content: string }): { appHost: string; contentHost: string }`; throws when the two domains are equal or one is a suffix of the other; `slug` matches `/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/` and is not in `RESERVED_SLUGS` (`www`, `api`, `admin`, `app`, `mail`, `status`, `docs`, `staging`, `content`).
  - `interface Provisioner { create(i: CreateInput): Promise<Install>; upgrade(id, to: Release): Promise<UpgradeResult>; rollback(id): Promise<UpgradeResult>; delete(id, confirm: string): Promise<void>; export(id, dest: string): Promise<never>; import(src: string, i: CreateInput): Promise<never> }`
  - `CreateInput = { slug; ownerEmail; plan: "paid"; vars?: Record<string,string>; testHooks?: boolean; resumeId?: InstallId }`; `Install = { id; slug; appHost; contentHost; version; patFile: string }`; `Release = { version: string; bundleKey: string }`; `UpgradeResult = { id; from: string; to: string; ok: boolean; rolledBack: boolean; reason?: string }`.
  - `class NotInM1 extends Error` thrown by `export`/`import` in both implementations. (Ruling: the spec puts whole-install export in the interface; the roadmap schedules it for M2. The signatures land now so callers compile; the bodies come in M2.)

- [ ] **Step 1: Write the failing tests**

```ts
it("install ids are 12 chars, lowercase, i-prefixed", () => {
  for (let n = 0; n < 200; n++) expect(isInstallId(newInstallId())).toBe(true);
  expect(isInstallId("I0123456789a")).toBe(false);
});
it("names are derived only from the id", () => {
  expect(names("iabc123def45")).toEqual({ script: "oa-iabc123def45", d1: "oa-iabc123def45", r2: "oa-iabc123def45", kv: "oa-iabc123def45-oauth" });
});
it("rejects reserved, uppercase, dotted and too-long slugs", () => {
  for (const s of ["www", "Acme", "a.b", "-a", "a-", "x".repeat(33)])
    expect(() => hosts(s, D)).toThrow(/slug/);
  expect(hosts("finqore", D)).toEqual({ appHost: "finqore.app.test", contentHost: "finqore.content.test" });
});
it("refuses equal or nested app and content domains", () => {
  expect(() => hosts("a", { app: "x.test", content: "x.test" })).toThrow(/domain/);
  expect(() => hosts("a", { app: "x.test", content: "c.x.test" })).toThrow(/domain/);
});
```

- [ ] **Step 2:** Run `env -i PATH="$PATH" HOME="$HOME" pnpm --filter @oa/provision exec vitest run`; expect FAIL (module missing).
- [ ] **Step 3:** Implement `src/types.ts`, `src/names.ts`, export from `src/index.ts`; add the package to the root test run.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(provision): install ids, names and the Provisioner interface`.

### Task 3: User Worker bundle and upload metadata

**Files:**
- Create: `packages/provision/src/bundle.ts`, `packages/provision/src/metadata.ts`
- Modify: `apps/server/package.json` (script `build:bundle`: `wrangler deploy --dry-run --outdir dist-worker` with a rendered config)
- Test: `packages/provision/test/metadata.test.ts`

**Interfaces:**
- Consumes: `names()`, `Install` (Task 2).
- Produces:
  - `buildBundle(root: string): Promise<{ modules: { name: string; type: "esm" | "wasm"; bytes: Uint8Array }[]; mainModule: string; assetsDir: string; version: string }>`
  - `userWorkerMetadata(i: { id; appHost; contentHost; ownerEmail; vars }, r: { d1Id; kvId; version; rlNs: number; doMigrationTag: string | null }): UploadMetadata` — bindings mirror `apps/server/wrangler.template.jsonc` with values from `names(id)`; `observability: { enabled: true, logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 } }`; `tags: [id, "v" + version]`; `migrations` taken from the template's `migrations` list: every tag after the install's recorded `do_migration_tag` is sent (`old_tag`/`new_tag`), so new Durable Object classes (P3 adds `DirectorySync` and `UserPresence`) arrive on upgrade, not only on create; no `routes`, no `triggers`.
  - `i.testHooks: boolean` (from `installs.test_hooks`): when true adds var `TEST_HOOKS="1"` (P5's contract); `upgrade` keeps the saved value. `userWorkerMetadata` throws when `testHooks` is true and the namespace is `oa-prod`.
  - Secrets ride in the upload as `secret_text` bindings: on create, all of them; on later uploads only the ones the script lacks, with `keep_bindings: ["secret_text", "secret_key"]` so existing secrets survive.
  - Hosted-only vars: `HOSTED="1"` (P2), `INSTALL_ID` (P2; also reported by `/healthz`, see Task 6b), `EMAIL_DAILY_CAP` and `CODE_EMAILS_PER_DAY` (Backend's P2 vars), and `FEATURES` always including `usage_off`.
  - `ratelimits[k].namespace_id` = `rlNs + k` for the k-th template entry (`RL_ANON`, P2's `RL_AUTH`), never a template literal. `rlNs = 1_000_000 × envIndex + 8 × seq` (staging `envIndex` 1, prod 2), so hosted IDs never overlap self-hosted literals.
  - `TEMPLATE_BINDINGS_EXCLUDED: Record<string, string>`: binding name → reason (filled from Task 1; `routes`, `crons` and `ANALYTICS_TOKEN` are always excluded).
  - Upload metadata sets `observability.logs.invocation_logs: false` (signed content paths are bearer credentials; see Shared account state).

- [ ] **Step 1: Write the failing tests**
  - `every template binding is mapped or explicitly excluded`: parse `apps/server/wrangler.template.jsonc`, collect binding names and var names; each must appear in `userWorkerMetadata(...).bindings` or in `TEMPLATE_BINDINGS_EXCLUDED`. This is the drift guard: a new server binding fails this test until hosted handles it.
  - `hosted vars`: `FEATURES` (P3's flag list, e.g. `spaces,directory_sync`; Backend owns the names) and P2's `AUTH_PROVIDERS`, `AUTH_DOMAINS`, `AUTH_BROKER_URL`, `INSTALL_ID` come from `vars`, validated by the same allowlist pattern as setup's `tunables.ts`.
  - `vars carry the install's own hosts`: `APP_HOST`, `CONTENT_HOST`, `OWNER_EMAIL`, `WORKER_NAME === names(id).script`, `PLAN === "paid"`, `ENVIRONMENT === "production"`.
  - `Durable Object migrations`: a null tag sends every template tag; tag `v1` sends only later tags; the latest tag sends none.
  - `each install gets its own ratelimit namespace_id`: two installs' metadata never share a `namespace_id`; the template has at most 8 `ratelimits` entries, and every literal ID in it is below 1,000,000.
  - `test hooks`: `testHooks: true` adds `TEST_HOOKS` and the `TEST_HOOK_KEY` secret binding; in `oa-prod` it throws; the drift test lists both names.
  - `later uploads send only missing secrets, with keep_bindings secret_text and secret_key`.
  - `observability`: `logs.invocation_logs` is exactly `false` and `logs.enabled` is `true` for every install.
  - `no secret names appear in bindings` (`SESSION_SECRET`, `CONTENT_SIGNING_KEY`, `ACCESS_CLIENT_SECRET`, `ANALYTICS_TOKEN`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. `buildBundle` runs the dry-run build once per release, not per install.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(provision): user Worker bundle and upload metadata`.

### Task 4: Cloudflare API client and `WfpProvisioner.create`

**Files:**
- Create: `packages/provision/src/cf.ts`, `packages/provision/src/wfp.ts`, `packages/provision/src/platform.ts`
- Create: `apps/platform-db/migrations/0001_installs.sql` (platform D1 `oa-platform`)
- Test: `packages/provision/test/wfp-create.test.ts`, `packages/provision/test/fake-cf.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `cfClient(o: { accountId: string; token: string; fetch?: typeof fetch }): Cf` with typed calls: `d1Create/d1Get/d1Query/d1Delete`, `r2Create/r2Delete`, `kvCreate/kvDelete/kvPut/kvGet/kvDeleteKey`, `nsScriptUpload(ns, script, metadata, modules)`, `nsScriptDelete(ns, script)`, `nsSecretPut(ns, script, name, value)`, `nsSecretList(ns, script)`, `nsAssetsUpload(ns, script, dir)` (assets upload session, then completion JWT into metadata). Retries 429 and 5xx with backoff (3 tries); never includes request bodies in errors.
  - Platform D1 table `installs(id TEXT PRIMARY KEY, slug TEXT UNIQUE, app_host TEXT UNIQUE, content_host TEXT UNIQUE, owner_email TEXT, d1_id TEXT, kv_id TEXT, version TEXT, previous_version TEXT, rl_ns INTEGER UNIQUE CHECK(rl_ns % 8 = 0), do_migration_tag TEXT, test_hooks INTEGER NOT NULL DEFAULT 0, inputs_hash TEXT NOT NULL, broker_kid TEXT, state TEXT CHECK(state IN ('creating','active','upgrading','deleting')), created_at INTEGER, updated_at INTEGER)`. No customer data.
  - Platform KV `HOSTS`: key = lowercase host, value = install ID. Written last on create, removed first on delete.
  - `new WfpProvisioner(o: { cf: Cf; namespace: string; platformDb: string; hostsKv: string; domains; releases: R2BucketName; patDir: string })`.
- Resume: `create` with a slug whose row is `creating` resumes that row (or pass `resumeId`); a slug whose row is `active` fails. The row stores `inputs_hash` (sha256 of canonical JSON of owner email, vars and testHooks); a resume with different inputs is refused before any Cloudflare call. `rl_ns` is allocated when the row is first inserted.
- Create order, each step idempotent by checking first: insert `installs` row (`creating`, `rl_ns`, `test_hooks`) and a `hosted_audit` row → D1 → R2 → KV → apply `apps/server/migrations/*.sql` in order via `d1Query`, recording applied names in a `d1_migrations` table the same way wrangler does → upload the script with assets and **all secrets as `secret_text` bindings** (48 random bytes base64url each: `SESSION_SECRET`, `CONTENT_SIGNING_KEY`, `DIRECTORY_TOKEN_KEY` (P3), and on test installs `TEST_HOOK_KEY`, also written to `<patDir>/<appHost>-hook-key`, 0600). A rerun after a successful upload skips this step (the script exists).
  → **Broker keypair** (P2 v3 contract, 2026-10-21): install secret `BROKER_SIGNING_KEY` (Ed25519 private key, PKCS#8 DER, base64url without padding); no kid var: `kid` is derived as the first 16 chars of base64url(SHA-256(x)). Registry KV `BROKER_REGISTRY` (one namespace in total, metadata only), key = install ID, value `{ installId, origin, keys: [{ kid, x }], disabled? }` where `x` is the raw 32-byte public key, base64url without padding, at most 2 active keys. Order on create and on repair: generate a pair → **add** `{kid, x}` to the registry entry (at most 2) → upload `BROKER_SIGNING_KEY` → remove the other key from the entry. Because the secret is write-only, a rerun can't read the install's current kid, so repair is keyed on the provisioner's own journal: the `installs` row records `broker_kid` after the upload succeeds; if the registry lacks `broker_kid`, holds a second key, or the row has no `broker_kid`, the rerun runs the same sequence again (a rotation). A half-done write always heals and the control plane never stores the private key.
  → `HOSTS` keys → `/healthz` until `{ ok: true, installId }` (120 s, longer than the dispatch Worker's 60 s KV cache) → mint owner PAT by SQL insert (reuse the `owner-token.ts` SQL and hashing; `newPat()` from `@oa/shared`) into `<patDir>/<appHost>-pat-token`, mode 0600, O_NOFOLLOW → MCP selftest (publish and read back a private Welcome artifact, as setup's `selftest.ts`) → row `active`, audit row.

- [ ] **Step 1: Write the failing tests** (against `fake-cf.ts`, an in-memory Cloudflare with call log)
  - `creates every resource named by install id and maps both hosts`.
  - `an upgrade that introduces DIRECTORY_TOKEN_KEY sends only that secret binding, with keep_bindings, and leaves the others untouched`.
  - `resume by slug`: a `creating` row is resumed; an `active` slug fails, and a resume with a different owner, vars or testHooks is refused, both before any Cloudflare call.
  - `broker keypair stays consistent`: fail between the registry add and the secret upload, and again between the upload and the old-key removal; each rerun heals, the entry never holds more than 2 keys, ends with exactly one key whose `kid` equals `installs.broker_kid` and is recomputed from `x` (first 16 chars of base64url(SHA-256(x))), and that `x` verifies a signature made with `BROKER_SIGNING_KEY` (round trip in the fake).
  - `drift test names`: `BROKER_SIGNING_KEY` is a secret binding; neither `BROKER_KID` nor `BROKER_KEY` appears anywhere.
  - `testHooks in oa-prod is refused before any Cloudflare call`; on staging the hook-key file is 0600 and its value never appears in output.
  - `secrets are 48-byte random, differ between two installs, and never appear in the call log's printable fields or thrown errors`.
  - `resumes after an upload failure without duplicating resources`: fail `nsScriptUpload` once, rerun `create` with the same slug; assert one D1, one R2, one KV, and the final script has every secret binding.
  - `hosts are written last`: the call log shows `kvPut(HOSTS)` after `nsScriptUpload`.
  - `slug or host already taken fails before any Cloudflare call`.
  - `the PAT file is 0600 and its content never appears in returned values`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `cf.ts`, `platform.ts`, `wfp.ts#create`.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(provision): WfpProvisioner.create`.

### Task 5: `upgrade`, `rollback`, `delete` (WfP)

**Files:**
- Modify: `packages/provision/src/wfp.ts`
- Create: `packages/provision/src/releases.ts`
- Test: `packages/provision/test/wfp-lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `publishRelease(cf, bucket, bundle): Promise<Release>`: stores the bundle (modules and assets) at `releases/<version>/` in the platform R2 bucket `oa-releases`; idempotent per version.
  - Each successful upload also stores that install's rendered metadata (no secret values; secrets are kept by `keep_bindings`) at `installs/<id>/<version>/metadata.json`, plus the `do_migration_tag` it reached.
  - `upgrade(id, to)`: refuses when `to.version` < installed (reuse `@oa/setup`'s semver compare from `version-guard.ts`; move it to `@oa/shared` if it isn't exported) → row `upgrading` → apply new D1 migrations → upload `to` with `keep_bindings` and `tags` updated → healthcheck and selftest → on failure call `rollback(id)` and return `{ ok: false, rolledBack: true, reason }` → row `active`, `previous_version` = old.
  - `rollback(id)`: refuses when the previous version's stored `do_migration_tag` differs from the current one (a Durable Object class added or changed in between; user Workers have no gradual deploys to soften it, so it's forward-fix only, and the result says so). Otherwise it re-uploads the previous bundle with its stored metadata; never rolls back D1 migrations (forward-only, as today); swaps `version` and `previous_version`. An automatic rollback after a failed upgrade follows the same rule: across a tag change, the install stays on the new version and the failure is reported for a forward fix.
  - `delete(id, confirm)`: throws unless `confirm === id`; row `deleting` → remove `HOSTS` keys → delete script → delete KV, R2 (emptied first), D1 → delete row. Idempotent.

- [ ] **Step 1: Write the failing tests**
  - `upgrade applies only new migrations and keeps bindings`.
  - `a failed healthcheck after upgrade rolls back to the previous bundle and reports it`.
  - `upgrade to an older version is refused`.
  - `rollback with no previous version is a clear error, not a re-upload`.
  - `rollback across a Durable Object migration tag is refused, and a failed upgrade across one reports forward-fix instead of rolling back`.
  - `rollback uploads exactly the stored metadata of the previous version`.
  - `an upgrade whose release adds a DO class and first uses it in the same version is refused`.
  - `delete requires confirm === id and unmaps hosts before anything else`: call log order.
  - `delete is idempotent after a partial failure`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(provision): upgrade, rollback and delete for hosted installs`.

### Task 6: Dispatch Worker

**Files:**
- Create: `apps/dispatch/package.json`, `wrangler.jsonc`, `src/index.ts`, `vitest.config.ts`
- Test: `apps/dispatch/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `HOSTS` KV contract and `names(id).script` (Tasks 2, 4).
- Produces: a Worker with bindings `DISPATCHER` (dispatch namespace) and `HOSTS` (KV). No routes in the repo config: **four** routes and four proxied wildcard records are wired at deploy time, one pair per env, covering **both** tenant zones: `*.<env>.app/*` and `*.<env>.page/*` → `oa-<env>-dispatch` (staging and prod). Task 9's smoke checks one host on each of the four zones; a missing route on the `.page` zone means tenant content hosts 404, so both are part of the same deploy step and both appear in the runbook.

Behavior: `host = new URL(req.url).hostname.toLowerCase().replace(/\.$/, "")` → `HOSTS.get(host, { cacheTtl: 60 })` → `isInstallId` → `await DISPATCHER.get(names(id).script).fetch(req)` with the request unchanged. Any miss, invalid value, `DISPATCHER.get` error or rejected `.fetch()` returns `new Response("Not found", { status: 404 })` with no other body or headers. It reads no other header, sets none, and never logs request headers or URLs beyond the host.

- [ ] **Step 1: Write the failing tests** (vitest pool workers, fake `DISPATCHER` recording which script was called)
  - `unmapped host → 404 with a generic body and nothing dispatched` (typo, an old install's host, uppercase, trailing dot, an explicit port, the bare apex and `www`).
  - `uppercase, trailing dot and explicit port map to the same install`.
  - `app and content hosts of one install dispatch to the same script`.
  - `a HOSTS value that isn't an install id → 404` (no script name injection).
  - `the request reaches the user Worker byte-for-byte` (method, URL, headers including `Cookie` and `Authorization`, body stream).
  - `a throwing DISPATCHER.get → 404, not 500 with a stack`, and `a rejected .fetch() (script missing) → 404`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement (under 60 lines).
- [ ] **Step 4:** Rerun; expect PASS; also run `pnpm --filter @oa/dispatch exec wrangler deploy --dry-run` and check the bundle is under 50 KB.
- [ ] **Step 5:** Commit `feat(dispatch): route hosted hostnames to install Workers`.

### Task 6b: Server answers only its own hosts (small server change, Backend reviews)

**Files:**
- Modify: `apps/server/src/index.ts:50-66` (today any host that isn't `CONTENT_HOST` gets the app), and the `/healthz` route
- Test: `apps/server/test/hosts.test.ts`

- [ ] **Step 1: Write the failing tests**: `a request whose host is neither APP_HOST nor CONTENT_HOST gets a plain 404` (in dev, `localhost` and `content.localhost` keep working); `/healthz reports installId when INSTALL_ID is set, and omits it otherwise`. `installId` is optional and the **last** key, because `/healthz` has exact-shape tests (the skeleton test and `smoke/healthz`); update both.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS); run the CPU tests.
- [ ] **Step 5:** Commit `fix(server): answer only the configured app and content hosts`; send Backend the diff before the PR.

### Task 7: Central scheduler

**Files:**
- Create: `apps/scheduler/package.json`, `wrangler.jsonc` (cron `17 3 * * *`; bindings `DISPATCHER`, `PLATFORM_DB`), `src/index.ts`
- Test: `apps/scheduler/test/scheduler.test.ts`

**Interfaces:**
- Consumes: platform `installs` table (Task 4), `names()`.
- Produces: `runNightly(env, now: number, o?: { concurrency?: number }): Promise<{ ok: string[]; failed: { id: string; reason: string }[] }>`; `scheduled` calls it and logs one line per failure. It also sums each install's email sends from the previous day against the account limit and logs an `email-quota` alert at 80%.
- Scale limit: 10 at a time × up to 25 s each fits about 360 installs inside one cron invocation's wall time. M2 replaces the loop with a Queue fan-out (one message per install); M1 asserts the count and logs a warning above 300.

Confirmed by the Task 1 spike: `DISPATCHER.get(names(id).script).scheduled({ cron: "17 3 * * *", scheduledTime: now })` for every `active` install, 10 at a time, 25 s timeout each. The server's existing `scheduled` handler runs unchanged.

The signed `POST /__oa/nightly` route is **not** part of M1 (it was plan B's fallback); Backend's contract for it stays parked for M2, where per-install crons or bindings may return.

- [ ] **Step 1: Write the failing tests**
  - `runs every active install and skips creating, upgrading and deleting ones`.
  - `one install throwing or timing out doesn't stop the others; it's reported in failed`.
  - `respects the concurrency limit` (max in flight observed ≤ 10).
  - `zero installs is a no-op`.
  - `more than 300 active installs logs the scale warning`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(scheduler): nightly jobs for hosted installs`.

### Task 7b: Platform inventory Worker (for P5's prod check)

P5 must prove no prod install has test hooks without putting an account-wide D1 token in CI (D1 read can read every customer's database).

**Files:**
- Create: `apps/inventory/package.json`, `wrangler.jsonc` (bindings: `PLATFORM_DB` only; secret `INVENTORY_KEY`; `workers_dev: true`, no custom route, so no DNS change), `src/index.ts`
- Test: `apps/inventory/test/inventory.test.ts`

**Interfaces:**
- Produces: `GET /installs` with `Authorization: Bearer <INVENTORY_KEY>` → `{ installs: [{ id, appHost, contentHost, state, testHooks }] }`. Any other path or method, or a wrong or missing key (constant-time compare), → 404. Reads only the `installs` table, selecting only those columns.
- CI's prod probe holds two credentials: the inventory key, and a token with only Workers Scripts Read (plus Workers for Platforms Read if namespace script settings need it, confirmed in Task 1). That's enough to list each prod script's secret names and settings, and it can't read any customer data.

- [ ] **Step 1: Write the failing tests**: `wrong or missing key → 404`; `returns only the listed columns` (a fixture row with extra columns doesn't leak them); `other paths → 404`; `the Worker has no binding except PLATFORM_DB` (parse `wrangler.jsonc`).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `feat(inventory): read-only install list for the prod probe`.

### Task 8: `SetupProvisioner` and the `oa:hosted` CLI

**Files:**
- Create: `packages/provision/src/setup-adapter.ts`, `scripts/hosted/src/cli.ts`, `scripts/hosted/package.json`
- Modify: root `package.json` (script `oa:hosted`)
- Test: `packages/provision/test/setup-adapter.test.ts`, `scripts/hosted/test/cli.test.ts`

**Interfaces:**
- Consumes: `@oa/setup`'s `run(argv, deps, root)` and `rollbackCommand(argv, deps, root)`.
- Produces:
  - `new SetupProvisioner({ deps, root })`: `create` → `run(["--json","--yes","--solo","--name",…])`; `upgrade` → `run(["--upgrade","--json","--name",…])`; `rollback` → `rollbackCommand`; `delete` → throws `NotInM1` (self-hosters delete in their own dashboard; ruling: no destructive self-hosted path in M1); `export`/`import` → `NotInM1`. Maps setup's JSON lines to `Install`/`UpgradeResult`.
  - CLI: `pnpm oa:hosted <create|upgrade|rollback|delete|status|publish-release> --env <staging|prod> [--install <id>] [--slug <s>] [--owner <email>] [--to <version>] [--confirm <id>] [--test-hooks]`. `--test-hooks` is refused with `--env prod`. Token from the macOS keychain (`security find-generic-password -w -s oa-hosted-<env>`, read through stdin-free `execFile`, never a file or argv); CI (staging only) reads it from a 0600 file written from a secret. Every command writes `hosted_audit` rows before and after it acts (actor = `git config user.email` or the CI run URL). Prints one JSON line per step; never prints secrets or the PAT. `--env prod` refuses a staging token file and vice versa (namespace names `oa-staging` and `oa-prod` are fixed per env).
- [ ] **Step 1: Write the failing tests**
  - `setup adapter maps a successful run to Install and a failed upgrade to ok:false`.
  - `DOMAINS[env] equals the decided suffixes`, and `a token whose zones include the other env's domains is refused before any write`.
  - `the CLI refuses prod with the staging token`; `prod reads only from the keychain, never a file`.
  - `every command writes a before and after hosted_audit row, and the table refuses UPDATE and DELETE`.
  - `--test-hooks with --env prod exits 1 before any call`.
  - `delete without --confirm, or with a different id, exits 1 before any call`.
  - `no secret or PAT value appears in stdout` (run create against fake-cf, scan output for the generated values).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `feat(hosted): oa:hosted CLI and the self-hosted provisioner adapter`.

### Task 9: E2E in both modes in CI

**Files:**
- Modify: `apps/server/test/smoke/*.ts` and `apps/server/vitest.smoke.config.ts` (targets from `OA_SMOKE_TARGETS`, a JSON list of `{ name, url, contentUrl, patFile }`; the old `STAGING_URL` and `STAGING_OWNER_PAT` keep working as a one-item list)
- Create: `.github/workflows/hosted-staging.yml`
- Modify: `scripts/ci/check-ci.test.ts` (or the existing workflow invariant tests) for the new workflow

Workflow: on push to main (paths `apps/server/**`, `packages/**`, `apps/dispatch/**`, `apps/scheduler/**`) and dispatch; concurrency `hosted-staging`; `permissions: contents: read`; builds once, `oa:hosted publish-release --env staging`, deploys `apps/dispatch` and `apps/scheduler` to staging, `oa:hosted upgrade` for the two staging installs `stg-a` and `stg-b` (created once by hand at the gate), writes their PAT files from secrets `HOSTED_STG_A_PAT`/`HOSTED_STG_B_PAT` with umask 077, then runs smoke against both. P5's release gate uses its own pair `rl-a`/`rl-b` and its own concurrency group `redline`, so this workflow can never cancel or overwrite a pending red-line run. Four staging installs are created at the gate: `stg-a` and `stg-b` (no test hooks; smoke uses owner PATs only), and `rl-a` and `rl-b` (`--test-hooks`, the only installs with hooks). The existing `deploy-staging.yml` keeps running smoke against self-hosted staging, so both modes run on every main push.

- [ ] **Step 1:** Write the failing tests: `smoke reads OA_SMOKE_TARGETS and runs every suite per target`; workflow invariants (`concurrency`, `permissions`, secrets only via files, no `echo` of secrets).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `ci: run smoke against hosted and self-hosted staging`.

### Task 10: FinQore, hand-provisioned (gated)

**Files:**
- Modify: `docs/ops/hosted.md` (runbook: create, check, upgrade, rollback, logs per install via the Observability API filtered by script name; and: if a pending red-line run was replaced or cancelled for a release, rerun it from the Actions tab before that release deploys anywhere, since deploy-prod waits on its success)

- [ ] **Step 1:** Ask the Manager for the explicit go on: wildcard DNS records and dispatch Worker routes on `open-artifacts.app` and `open-artifacts.page` (and the staging pair for Task 9), the per-install mail subdomain records, the four `_psl` TXT records and the PSL PR, and go-ahead to create `finqore`. Stop until all are confirmed. File all four domains for the PSL private section (one PR, with Backend); they must be published before a second prod tenant goes live.
- [ ] **Step 1b:** FinQore's go-live is also gated on P5's sign-in cases being `proven` live (real test Workspace tenants), not just against the fixture.
- [ ] **Step 2:** `pnpm oa:hosted create --env prod --slug finqore --owner <FinQore admin email from the Manager>`; check `/healthz`, the Welcome artifact, a nightly run in the scheduler logs the next day.
- [ ] **Step 3:** Record the install ID (not the PAT) in the runbook and the Platform status page; hand the PAT file to the user with the hidden-save convention, never in chat.
- [ ] **Step 4:** Commit the runbook.

---

## Dependencies on other plans

- P2 (Backend, direct sign-in) changes the server's sign-in config vars. Task 3's drift test will fail until those vars are mapped; that's intended.
- P5 uses `stg-a`/`stg-b`, `oa:hosted`, and the PAT-file convention from this plan.
- Task 7's fallback route, if needed, is Backend's.
