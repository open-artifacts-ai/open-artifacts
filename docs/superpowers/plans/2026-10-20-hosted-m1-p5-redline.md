# Hosted M1 · P5: Red-line proof and import validation (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, on every release and against two real hosted installs, that nothing from tenant A works against tenant B, and block the release when it doesn't; and prove the migration skill imports a real Claude export into spaces correctly and idempotently.

**Architecture:** A vitest suite in `tests/redline/` runs over HTTP against two staging installs (`rl-a`, `rl-b`, from P1) with identities obtained through Backend-owned test hooks that exist only on installs provisioned with them. A job in `release-please.yml` deploys the tagged build to both installs and runs the suite before `deploy-prod`, so a failure stops the release from reaching anyone. A separate harness in `tests/import/` checks an install after an agent ran the migration skill.

**Tech Stack:** TypeScript, vitest (node), `@modelcontextprotocol/sdk` client, `ws`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` (anti-goal; 4.1 sign-in; 4.2 guests; 4.6 import; 4.7). Depends on P1 (installs, `oa:hosted`), P2 (sign-in) and P3 (spaces) from Backend.

## Global Constraints

- The anti-goal: data leaking between customers, or one customer signing in to another's artifacts, is a failure even if everything else works.
- The suite runs only against installs provisioned with test hooks (`rl-a`, `rl-b`; `stg-a`/`stg-b` have none); it refuses any target whose `/healthz` doesn't report `testHooks: true`.
- Test hooks must not exist on any other install, and the release bundle never enables them: `__OA_TEST_HOOKS_ALLOWED__` is `"true"` only in the redline bundle that rl-a and rl-b get, `"false"` in the release bundle every other install gets (P1 Task 4 refuses a hooks-enabled bundle outside a staging test-hooks install). Backend's `check-no-test-hooks` (Miniflare, every `/__test/*` answers 404) runs in the provision bundle step and in deploy-prod. Because hooks fail closed (a wrong key and "hooks off" both return 404), a 404 proves nothing on its own. The prod check is positive (Task 2): for every row in prod's `installs` table, `/healthz` reports `testHooks: false` **and** the script's secret list and settings (read with a read-only prod token) contain neither `TEST_HOOK_KEY` nor `TEST_HOOKS`. P1's provisioner refuses `testHooks` in the `oa-prod` namespace whatever the CLI flags.
- Every assertion is about B refusing A's credential: the expected result is a 401, 403 or 404 with no B data in the body, never "anything but 200". Each refusal is meaningful only next to two successes on the same request: B's own credential succeeds at B, and A's credential succeeds at A (`crossCheck`, Task 2). A broken B that refuses everything fails the run.
- Credentials (PATs, hook keys, session cookies) live in 0600 files or GitHub secrets, never in argv, logs or test names; failure messages print status and a body hash, not the body.
- Real user exports never enter the repo, CI or a log. The import harness reads them from a local path the user gives.
- Tests: `env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run`; never print env.
- Human gates: a real claude.ai export from the user (they run the export; it stays on their machine); the security review is the Manager's, independent of this suite.

## Review Focus

1. **A check that passes because B is broken** (B answers 401 to everything, while its static `/healthz` still says ok): every case goes through `crossCheck`, which first proves B's own credential succeeds on the same request. Pinned in Task 2.
2. **A redirect counted as refusal**: fetches use `redirect: "manual"`; a 3xx to B's sign-in is a refusal only when it carries no session cookie and no B data. Pinned in Task 2.
3. **Hooks leaking to prod**: the positive prod check in Task 2 (healthz `testHooks: false` plus no hook secret or var on any prod script) fails the run otherwise.
4. **A release that skips the suite** (the red-line job failed, skipped or cancelled, or the deploy was dispatched by tag): `deploy-prod` and `deploy-demo` both use `always()`/`!cancelled()`, so `needs:` alone doesn't stop them. Their `if:` must also require `needs.redline.result == 'success'`, and red-line's trigger must match deploy-prod's, dispatch included. Pinned in Task 7.
5. **An import rerun that duplicates** (new artifacts or new versions on the second run): pinned in Task 8.

---

### Task 1: Test-hook contract with Backend

**Files:**
- Create: `docs/superpowers/specs/2026-10-20-redline-test-hooks.md` (the contract; Backend implements the server side under their plan)

**Interfaces:**
- Produces the contract both sides code against:
  - Server var `TEST_HOOKS` (`"1"` or unset) and secret `TEST_HOOK_KEY` (≥ 32 chars). Only `oa:hosted create --test-hooks` sets them; P1's `userWorkerMetadata` gains `testHooks: boolean`, default false, and its drift test lists both names.
  - `/healthz` adds `testHooks: boolean`.
  - With hooks on, every request to `/__test/*` needs `Authorization: Bearer <TEST_HOOK_KEY>`; with hooks off, `/__test/*` is 404 before any auth.
  - `POST /__test/session {email, role: "owner"|"admin"|"member"|"guest"}` → `{ cookie }` (a real `__Host-oa_session` for that user, created if missing).
  - `POST /__test/otp/latest {email}` → `{ code }` (after P2: the last one-time code sent to that address on this install).
  - `POST /__test/oauth-client` → `{ clientId, accessToken }` (a completed MCP OAuth grant for the owner, through the real provider).
- Agreed with Backend on 2026-10-21, with their amendments:
  - Fail closed: hooks are live only when `TEST_HOOKS="1"` **and** `TEST_HOOK_KEY` is at least 32 chars; otherwise `/__test/*` returns 404 and `/healthz` reports `testHooks: false`.
  - The bearer compare is constant-time. A wrong key gets the same 404, never a 401. Hooks exist on the app host only, never the content host.
  - Hooks are rate-limited (an `RL_ANON` bucket prefixed `test:`) and every call writes an audit event `test_hook.*`.
  - `otp/latest`: codes stay hashed. Only while hooks are on, the send path also writes the plaintext to the install's KV under `test:otp:<install>:<email>` with a 10-minute TTL.
  - `session` takes `spaces?: [{id, role}]` once P3 lands.
- Build-time guard (Backend #393): hooks also need `__OA_TEST_HOOKS_ALLOWED__` compiled `true`, so `rl-a`/`rl-b` run P1's `redline` bundle; every other install runs `release`. P1 pins that the two differ only in that literal, and CI proves the release bundle 404s every `/__test/*` even with `TEST_HOOKS=1` and a key.
- [ ] **Step 1:** Write the contract doc with the amendments above. The suite adds three checks: a wrong key gets a 404, hooks on the content host get a 404, and a hook call shows up in `audit_events`.
- [ ] **Step 2:** Commit `docs: red-line test-hook contract`.

### Task 2: Suite harness

**Files:**
- Create: `tests/redline/package.json` (`@oa/redline`), `vitest.config.ts`, `src/targets.ts`, `src/http.ts`, `src/refused.ts`
- Test: `tests/redline/test/harness.test.ts` (unit tests of the helpers against a local fake server)

**Interfaces:**
- Produces:
  - `loadTargets(): { a: Target; b: Target; prod: ProdProbe }` from `REDLINE_TARGETS` (JSON) with `Target = { name; installId: string; app: string; content: string; patFile: string; hookKeyFile: string }` and `ProdProbe = { inventoryUrl: string; inventoryKeyFile: string; scriptsTokenFile: string; accountId: string }` (P1 Task 7b's inventory Worker for ids and hosts, and a token with only Workers Scripts Read for secret names and settings; no D1 token in CI); reads secrets from the files.
  - `crossCheck(req: (cred: Cred, host: Target) => Request, o: { a: Target; b: Target; credA: Cred; credB: Cred; ok?: (r: Response) => boolean }): Promise<void>`: asserts `ok(fetch(req(credB, b)))` and `ok(fetch(req(credA, a)))` (default `ok` is 2xx or 101), then `expectRefused(fetch(req(credA, b)), b)`. Every cross-tenant case in Tasks 4–6 uses it.
  - `prodClean(p: ProdProbe): Promise<void>`: for every install the prod inventory Worker returns (`testHooks` must be false there too), `/healthz.testHooks !== true` (the field is absent unless hooks are on), `/healthz.installId === row.id`, and the script's secret list and settings contain neither `TEST_HOOK_KEY` nor `TEST_HOOKS`.
  - `hook(t: Target, path: string, body): Promise<unknown>`.
  - `asA/asB` helpers that build `fetch` init with a credential and `redirect: "manual"`.
  - `expectRefused(res: Response, b: Target): Promise<void>`: status in 401, 403, 404, or a 3xx without `set-cookie` whose `location` is B's own sign-in; body (when present) contains none of the marker strings seeded into B (Task 2 seeds a private artifact on each install whose title and content include `REDLINE-<install>-<random>`).
  - `beforeAll` guard: both targets report `testHooks: true`, `ok: true` and their own `installId`; `prodClean` passes.
- [ ] **Step 1: Write the failing tests**: `expectRefused rejects a 200`, `rejects a 302 that sets a cookie`, `rejects a 403 whose body contains B's marker`, `accepts a bare 401`; `crossCheck fails when B's own credential is refused` (a fake B that 401s everything); `crossCheck fails when A's credential is refused at A`; `prodClean fails on a prod script that lists TEST_HOOK_KEY` and `on healthz testHooks: true`; `loadTargets refuses a target without testHooks`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `test(redline): harness and refusal assertions`.

### Task 3: (dropped) test identity provider

Backend's ruling (2026-10-21): P5 runs P2's `SIGNIN_NEGATIVE_CASES` catalog and its fake-Google fixture live, instead of a separate issuer. Real-tenant cases are added once the user creates the two test Workspace tenants (P2's user item 6).

**Test tenants (fixtures, 2026-10-24; tenant B moved to `oa-redline-c.fyi` on 2026-10-25, replacing the stuck `oa-redline-b.fyi`).** Two Cloud Identity Free tenants on domains the user bought in the same Cloudflare account. Real-tenant cases use exactly these names:

| | Tenant A | Tenant B |
|---|---|---|
| Domain (`hd`) | `oa-redline-a.fyi` | `oa-redline-c.fyi` |
| Super admin | `admin@oa-redline-a.fyi` | `admin@oa-redline-c.fyi` |
| Users | `alice@`, `bob@`, `carol@oa-redline-a.fyi` | `dave@`, `erin@`, `frank@oa-redline-c.fyi` |
| Groups | `eng@` (alice, bob), `restricted@` (carol) | `eng@` (dave, erin), `restricted@` (frank) |

Mail for both domains is routed (Cloudflare Email Routing catch-all) to the user's inbox, which is the readable inbox for code sign-in. These domains are never under `open-artifacts-staging.app`. Credentials for these users stay in the user's password manager; CI reads them only from the 0600 files the xt suite already requires.

### Task 3b: Reuse Backend's surface probes

P3 ships `apps/server/test/authz/surfaces.ts` (every HTTP surface as a probe) and `scripts/authz-probe.ts`. Tasks 4 and 5 drive those probes with A's credentials against B and expect `expectRefused` on every surface, so a surface Backend adds is covered without a P5 change. A test fails if the probe list is shorter than the server's `ROUTE_POLICY` manifest.

### Task 4: Credential cases (available now)

**Files:**
- Create: `tests/redline/test/credentials.test.ts`

Every case goes through `crossCheck` (B's credential succeeds at B, A's at A, then A's is refused at B).
- [ ] **Step 1: Write the tests**
  - `A's owner PAT at B: /api/v1/me, /api/v1/artifacts, /mcp (tools/list)`.
  - `A's session cookie at B`: the cookie value replayed on B's host (also under the alternate cookie name) is refused, because the two installs sign sessions with different `SESSION_SECRET`s, so B cannot verify A's signature. B's content host ignores cookies, A's included: this is an invariant, not a crossCheck, since the content host reads no cookie and so has no same-request B baseline. **Dropped (2026-10-26):** a tampered cookie signed with a guessed key; covered by "A's real session cookie replayed at B" (B refuses any session not signed with its own key, and A's key is such a key). The mechanism is pinned where it can be read: P1 Task 4 asserts that two creates generate different `SESSION_SECRET`s (secrets are write-only, so P5 proves the effect, not the value).
  - `A's MCP OAuth access token at B /mcp`; `A's OAuth client_id in B's /authorize` (B must not know it: a 400 (401/403/404 also ok) with no consent form, never a redirect with a code. A consent page would mean B resolved A's client, so it fails).
  - `A's signed content URL path (/c/<exp>.<sig>/<A artifact>/v1/) at B's content host`, and `A's signature with B's artifact id`.
  - **Dropped (2026-10-26):** `A's capture token (X-OA-Capture) at B's content host`. No route issues one (only the Worker's own thumbnail capture mints it), so it can't cross installs; covered by the server's content tests.
  - `A's signed upload URL at B`.
  - `B's private artifact id fetched with A's credentials at A` (404: ids don't cross installs).
  - `A's OAuth refresh token and an unredeemed A authorization code at B's /token` → `invalid_grant`, no token issued.
  - `A's invite link and share email link opened at B` (signed in to B as a B member) → no membership or share created on B. Both links carry no secret (the invite links to `/sign-in`, the share to `/a/<id>`), so these cases prove only that A's ids and members don't resolve at B and that B's members and shares are unchanged.
- [ ] **Step 2:** Run against `rl-a`/`rl-b`; expect PASS. Any FAIL is a red-line bug: stop, file it with the Manager as a blocker, don't weaken the test.
- [ ] **Step 3:** Commit `test(redline): tokens, sessions, OAuth and signed URLs don't cross installs`.

### Task 5: Live data and transport cases (available now)

**Files:**
- Create: `tests/redline/test/live.test.ts`, `tests/redline/test/edge.test.ts`

- [ ] **Step 1: Write the tests**
  - `WebSocket data-subscribe and events at B with A's session or PAT` → upgrade refused (no 101).
  - `WebSocket at B with Origin = A's app or content origin, using B's own valid session` → refused (Origin check).
  - `data API (GET/PUT/PATCH/DELETE data/:col/:doc, POST query, PUT data reset, storage/:key) at B with A's PAT`.
  - `anonymous writes`: a public artifact on B with anonymous writes allowed accepts an anonymous write, and A's PAT sent along doesn't change the actor to A's user (the stored doc has no A identity).
  - Mapping integrity (replaces the Host-to-IP case, which proves nothing behind one anycast edge): A's app and content hosts both resolve in the platform `HOSTS` to A's `installs.id`, and so do B's; each host's `/healthz.installId` equals that id; no host maps to two ids. `X-Forwarded-Host: <B>` on A is ignored; an unmapped host → generic 404; a host that is neither the install's `APP_HOST` nor `CONTENT_HOST` (reached through a test mapping on stg only) → 404 from the server itself.
  - Unmapped host, no fallthrough (the dispatch Worker answers, never a default install): for a typo of A's host, A's host in the other case, with a trailing dot, with `:443`, the bare `<env>.app` and `<env>.page` apexes, `www.<env>.app`, an arbitrary `deadbeef.<env>.app`, and the old host of a deleted install (deleted first, then requested) the response is a **generic 404** (no `Location`, no `Set-Cookie`, no install header, and a body containing no marker string from any install), never a 5xx. `Host`/`X-Forwarded-Host` set to B on A's unmapped name still gives that 404. Both tenant zones per env are exercised.
  - `content host never serves app routes and ignores cookies`: `/api/v1/me` on A's content host with A's session → not 200; a `Cookie` header on content requests doesn't change the response.
  - `cross-site cookies`: on staging (`open-artifacts-staging.app` / `.page`) and in the prod probe (`open-artifacts.app` / `.page`): the app and content domains are different registrable domains, **and** `rl-a.<app>` and `rl-b.<app>` (and their content hosts) are different sites per the PSL snapshot `tldts` ships. Until all four PSL entries are published (P1 Task 10), this case reports `unproven` and blocks only a second prod tenant's go-live.
  - Scheduler: `/__oa/nightly` (only if P1 Task 7 took the fallback): a signature made for A's host replayed at B → refused; a 6-minute-old signature → refused; the same signature replayed a second time at A → refused (nonce, once per day).
- [ ] **Step 2:** Run; expect PASS (same stop rule as Task 4).
- [ ] **Step 3:** Commit `test(redline): live data, sockets and the dispatch edge`.

### Task 6: Sign-in cases (after P2 lands)

**Files:**
- Create: `tests/redline/test/signin.test.ts`

Installs are configured (by Backend's P2 settings) with `rl-a` and `rl-b` bound to different domains. The cases come from P2's `SIGNIN_NEGATIVE_CASES`, run live against both installs and against the staging auth broker (`auth.<staging-hosted>`), whose cases are the riskiest.
- [ ] **Step 1: Write the tests** (drive P2's catalog live)
  - `an ID token with hd=a… at B's callback` → no session.
  - **Dropped (2026-10-26):** `an ID token with B's email domain but hd=a…` → no session (domain from the token, not the email). Google can't issue it even for real tenants (`oa-redline-c.fyi` is verified to tenant B, so no tenant-A account carries a B address); covered by `apps/server/test/xt-google.local.test.ts` ("an ID token with a B email domain but hd of A").
  - **Dropped (2026-10-26):** `an ID token with no hd claim and a B-domain email` → no session. No consumer (no `hd`) Google account can use a Workspace-verified domain; covered by `apps/server/test/xt-google.local.test.ts` ("an ID token with no hd and a B email").
  - `A's code and broker state at B` → no session (was `an ID token minted for A's client (aud) replayed at B`). Hosted installs share one Google client through the broker, so A's and B's tokens carry the same `aud` by design; the per-install binding is the broker state (it names the install and binds H(nonce || challenge)) and the install-derived nonce. The real-tenant case proves B won't redeem A's real code and broker state (`error=failed`, never `tenant`), and the same capture still signs in at A. A distinct `aud` (direct transport) is covered by `apps/server/test/xt-google.local.test.ts`.
  - `A's OIDC state/nonce replayed at B` → no session.
  - Broker: `a tampered install id at the broker callback` → refused (staging only: a real broker state from a sign-in start, its install id swapped, signature kept). **Dropped (2026-10-26):** `A's BROKER_SIGNING_KEY (its kid derived from A's public key) redeeming as B` and `B's assertion at A`. The redeem assertion is Ed25519-signed by the install server-side and never leaves the install-broker channel, so there is no real value to replay, and signing one would be forging; covered by `apps/auth-broker/test/broker.test.ts` ("A's key signing a redeem for install B is refused, with no Google call", "redeem verifies the broker state's flow hash") and, with real values, by the real-tenant case `A's code and broker state at B`.
  - One-time codes: `a code issued by A for x@b.redline.test, entered at B` → refused; `a code requested at B for an address not invited to B` → no code sent (hook shows none) and a generic response; `a guest of A who is invited to B gets read-only on B only` (guest can't publish via MCP or data API on B).
- [ ] **Step 2:** Run; expect PASS (same stop rule).
- [ ] **Step 3:** Mark proof levels. Until the user creates the two real test Workspace tenants, a *validly signed* Google token with the wrong `hd` or `aud` can't be produced live; those cases run only against P2's fake-Google fixture. The suite reports them as `unproven-live`, the Platform status page shows them so, and FinQore's go-live is gated on them turning `proven`.
- [ ] **Step 4:** Commit `test(redline): sign-in and one-time codes are bound to their install`.

### Task 7: Release gate

**Files:**
- Modify: `.github/workflows/release-please.yml` (new job `redline`; `deploy-prod.needs` and `deploy-demo.needs` add `redline`)
- Create: `.github/workflows/redline-nightly.yml` (main, `0 5 * * *`, plus dispatch; opens or updates a `Red line failing` issue on failure)
- Modify: the workflow invariant tests (`scripts/ci/*.test.ts`)

Job `redline`:
- `needs: release-please`.
- `if:` is exactly deploy-prod's trigger, workflow_dispatch included: `always() && github.ref == 'refs/heads/main' && (needs.release-please.outputs.release_created == 'true' || (github.event_name == 'workflow_dispatch' && inputs.tag != ''))`. A dispatched deploy by tag runs the suite too.
- **Its own install pair `rl-a` and `rl-b`** and its own concurrency group `redline` (`cancel-in-progress: false`). P1's push-to-main smoke keeps `stg-a`/`stg-b` and group `hosted-staging`, so neither workflow can cancel or overwrite the other's deploy mid-run.
- Checks out the tag, `oa:hosted publish-release` + `upgrade` for `rl-a` and `rl-b` to the tag, writes PAT and hook-key files from secrets with umask 077, runs `pnpm --filter @oa/redline test`, and on failure runs the existing `release-cadence.ts blocker` with the failing case names.

`deploy-prod.if` and `deploy-demo.if` each gain `&& needs.redline.result == 'success'`, and both list `redline` in `needs`. Today both start with `always()`/`!cancelled()`, so `needs:` alone would let them run after a failed, skipped or cancelled red-line.

- [ ] **Step 1: Write the failing invariant tests**
  - `deploy-prod and deploy-demo need redline` **and** `their if: contains needs.redline.result == 'success'`.
  - `redline's trigger condition equals deploy-prod's minus the redline clause` (parsed and normalized, so the workflow_dispatch tag branch can't be dropped from one of them).
  - `redline uses concurrency group redline with cancel-in-progress false, and its targets are rl-a/rl-b, never stg-a/stg-b`.
  - `redline has no continue-on-error and no timeout under 20 minutes`.
  - `secrets reach redline only through files written under umask 077`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `ci: the red-line suite gates every release`.

Runbook (P1 `docs/ops/hosted.md`): a red-line run replaced or cancelled for a release is rerun from the Actions tab; prod waits on its success.

### Task 8: Import validation harness

**Files:**
- Create: `tests/import/package.json` (`@oa/import-check`), `src/check.ts`, `fixtures/synthetic-export/` (a small, invented export with the real claude.ai layout: `conversations.json` with artifact-bearing messages, including duplicates, a re-edited artifact, an unsupported type and a very large one)
- Test: `tests/import/test/check.test.ts`

The migration skill itself is Backend's scope C and isn't on main yet. This task builds the checker and the synthetic fixture so the skill can be validated the day it lands.

**Interfaces:**
- Produces: `checkImport(o: { target: Target; exportDir: string; owner: string; spaceMap: Record<string, string>; before: Snapshot }): Promise<Report>` where `Report = { expected: number; imported: number; skipped: { ref: string; reason: string }[]; wrongSpace: string[]; wrongOwner: string[]; duplicates: string[]; extraVersions: string[] }`; `snapshot(target): Promise<Snapshot>` (artifact ids, versions, spaces, owners).
- `expected` comes from parsing the export independently of the skill. The identity is Backend's contract (2026-10-21): `importKey = "<source>:<conversationUuid>:<artifactId>"` (`source` is `claude` or `chatgpt`), stored on the artifact with a unique index on (owner, importKey). Republishing the same content returns the artifact unchanged; changed content adds one version, reported as updated.
- [ ] **Step 1: Write the failing tests** against a fake install: `a correct import reports zero problems`; `a second run with no new artifacts reports zero new artifacts and zero new versions`; `an artifact published to the wrong space or with the wrong owner is reported`; `skipped items must carry a reason`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `test(import): checker for agent-run imports into spaces`.

### Task 9: Real-export validation (gated, after P3 and the skill)

- [ ] **Step 1:** Ask the Manager to get the user to export their claude.ai data to a local folder and give the path. The export never leaves their machine.
- [ ] **Step 2:** On `rl-a` (spaces from P3 created: `Engineering`, `Personal`), have an agent run the migration skill as the user, then run `checkImport` twice (after the first run and after a rerun).
- [ ] **Step 3:** Record counts and problems (no titles or content) in `docs/ops/hosted.md` and on the status page; file each problem with Backend.
- [ ] **Step 4:** Delete the imported artifacts from `rl-a` with the owner's PAT.

---

## Dependencies and order

Tasks 1–5 and 7–8 can start once P1's `rl-a`/`rl-b` exist (P1 Task 9) and, for the prod check, P1 Task 7b's inventory Worker. Task 6 waits on P2; Task 9 on P3 and Backend's migration skill. Until Task 6 lands, the release gate runs Tasks 4–5 only, and the status page says so.
