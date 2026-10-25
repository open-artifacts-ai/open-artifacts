# Hosted M1 · P2 Direct sign-in Implementation Plan (rev 4, after security review)

> **Contract:** every shared name in this plan comes from **PR #359** (`be/hosted-contract` at `ed1105c`): `packages/shared/HOSTED_CONTRACT.md` and `packages/shared/src/hosted/{auth,core,test-hooks}.ts`, plus `AUTH`, `R.memberIdentity` and `SIGN_IN_PAGE` in `routes.ts` and the hosted `ERROR_CODES`. P2 implements those schemas; it does not redefine them. The six changes P2 asked for are applied in `ed1105c` (listed at the end).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign people in without Cloudflare Access: Google (locked to the install's verified domains by the `hd` claim, verified by the install itself) and emailed one-time codes (invited guests, read-only; domain members only during a trial with no Google), selectable by setup, with Access staying the default.

**Architecture:** A provider interface (`access`, `google`) behind the existing state-cookie and session code in `apps/server/src/auth`. Every install verifies Google ID tokens itself with one shared function (`packages/auth-core`). Hosted installs never hold the shared Google client secret: a stateless auth broker does the code exchange and returns Google's **raw** ID token; installs authenticate to it with their own Ed25519 key, and the broker's registry holds public keys only. Codes are D1-backed, keyed per request, with an atomic attempt counter. Sessions gain a per-user epoch and the tenant they were issued for.

**Tech Stack:** Cloudflare Workers, Hono, D1 (drizzle migrations), `jose`, WebCrypto (HKDF, Ed25519, `timingSafeEqual`), Workers Rate Limiting, Cloudflare Email Service, Turnstile, vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md` (branch `docs/hosted-design`) §3, §4.1, §4.2, §4.7. Roadmap `axtJ4ieni2LsKfTk` (P2). Broker shape from `5X6JAvUDGEkwsjkn` §8, changed per review C1. Code display from Design `G68RE4oKC9pH3cgr`.

**Baseline:** `origin/main` at `e5d970d` (0.17.0):
- `auth/oidc.ts`: per-attempt `__Host-oa_oidc_<k>` HMAC state cookie {state, nonce, verifier, next, exp, retry}; Access-only issuer.
- `auth/session.ts`: stateless HMAC cookie `{uid, exp}`, 7 days; `signSession(env, uid, now)` has 11 call sites (2 in src, 9 in tests). `session()` loads the user row per request.
- `services/users.ts` `upsertOnLogin`: email-keyed; new rows only for `OWNER_EMAIL` or an email with a share (`guest`).
- Guests already cannot create PATs, use MCP or get OAuth grants.
- `email/send.ts`: D1 `counters` caps 20 per sender, 100 per instance (`email:*`), 5 per recipient (`email:to:<plaintext>`).
- `util/crypto.ts`: `hmacSign(key: string, data)`, `hmacVerify` (constant time via `crypto.subtle.verify`).

## Global Constraints

- Anti-goal: no sign-in to another customer's install. Every task carries its cross-tenant negative tests.
- **`HOSTED=1` only tightens or reports.** It may add a fail-closed requirement (broker transport, Turnstile for codes, a named host) or report itself (`Me.instance.hosted`), never enable a feature or loosen a check. Every `HOSTED` read in `apps/server/src` is listed with its reason in `test/node/hosted-lint.test.ts`.
- Tenant binding is the `hd` claim of a Google ID token **verified by the install**: signature from Google's JWKS, `alg` RS256 only, `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud` = the client id (single value), `azp` = the client id when present, `exp`/`iat` with 60 s skew, `nonce` = this browser's state-cookie nonce (constant time), PKCE S256, `email_verified === true`, `hd` exact member of `AUTH_DOMAINS`. Never the email domain.
- No secret shared across installs (spec §4.7). The Google client secret lives only in the broker. The broker holds no install secrets.
- Codes are invite-only and at most read-only outside the verified domains (spec §4.2). Domain codes exist only for a trial with no Google sign-in.
- **The SPA owns every sign-in form** (chooser, email, code). P2 is JSON plus redirects only and renders no HTML. Every refusal of a redirect flow lands on `/sign-in?error=<SignInError>` (an enum in the shared contract); JSON endpoints return the error envelope.
- **`identities(provider, subject)` is the only link** between a person and an IdP account. No `users.directory_id`. For Google, `subject` = the OIDC `sub`, which is the same value as the Directory API user id, so P3's sync and P2's sign-in meet on one row.
- **Every user insert goes through one helper** (`insertUserStmts`, Task 5) as the single app path. The personal space (space id = user id) is created by P3's D1 `AFTER INSERT ON users` trigger in 0009, so it can't be bypassed even by a path that skips the helper.
- Removed or suspended users are never admitted and never linked by email.
- Access stays the default: `AUTH_PROVIDERS` unset means `access`; `oidc.test.ts` passes unmodified.
- Free plan: 10 ms CPU per request; zero KV writes on sign-in paths (only exception: the test-hook OTP copy while `TEST_HOOKS` is on, Task 14).
- Logs never contain emails, codes, tokens, state, nonces, keys; counter keys never contain plaintext emails.
- Rate-limit keys always include the install: `${INSTALL_ID ?? APP_HOST}:…`.
- Copy: no em dashes; say "any AI agent".
- Fail closed on incomplete config.

## Decisions (open questions answered by the manager)

| # | Question | Decision |
|---|---|---|
| D1 | Guest writes to live data | No. Guests can't write data or storage. |
| D2 | Turnstile | Yes, in M1, required on code requests whenever domain codes are on. |
| D3 | Email drift | Update `users.email` to the new verified address when no other user has it. |
| D4 | Broker transport | Service binding allowed; request signing stays (Ed25519). |
| D5 | Directory API scope | Separate Google client for P3; the sign-in client keeps basic scopes. |
| D6 | Guest session length | 24 h, with `session_epoch` for revocation. |
| D7 | Email pools | Separate per-install pool for codes. |

## Spec gaps stated

- **Codes narrowed (H3):** the spec allows codes "for the trial before the identity provider is connected". This plan allows domain codes only while Google is not enabled, only for users with no Google link, and only with Turnstile. Outside the domains, codes are guest-only.
- **Suspension revocation is deferred to P3.** A suspended Workspace user keeps a session until P3's directory sync deletes or demotes the row (which bumps `session_epoch`). P2 provides the epoch.
- **Expiring outside shares** (spec §4.2) are M4. In P2 a guest's access ends when the share is removed; the guest row is deleted with its last share.
- **Gate:** an independent security review of P2 (code path, broker, test hooks) must pass before FinQore goes live.

## Review Focus

1. **Workspace alias domains:** `hd` is the primary domain while the email is `bob@alias.com`. Sign-in succeeds; the email domain is never consulted. Task 4.
2. **Recycled account** (new `sub`, same email): refused with `identity_conflict`; the code path can't bypass it (codes refused for linked users and for domain users when Google is on). Tasks 5, 7.
3. **Victim lockout by a stranger:** someone requests codes for a victim and guesses wrong. The victim's pending code still works. Task 7.
4. **MCP connector popup sign-in** through `/sign-in` keeps `window.opener` for Google and codes. Tasks 6, 8.
5. **Switching an existing Access install to direct:** users keep accounts (linked by email on first Google sign-in), old session cookies keep working through the key-derivation window. Tasks 2, 5, 6.

## Threat table

| Threat | Result without mitigation | Mitigation | Residual |
|---|---|---|---|
| **Broker compromise** (code exec or secret theft) | Before rev 4: every install taken over | Broker returns raw Google ID tokens; installs verify signature, `aud`, their own nonce and `hd`; registry holds Ed25519 public keys only; no install secret in the broker | Attacker holds the Google client secret and the callback: can obtain ID tokens only for victims who click a crafted sign-in link, and only for an install whose state cookie the attacker controls in their own browser. Detect by alerting on redeem volume; rotate the client secret. |
| Install compromise | That install's data | Per-install secrets; Ed25519 key only signs that install's redeems (broker checks `install` = key owner) | Same install only |
| D1 dump | Code brute force offline | Codes stored as HMAC under an HKDF key from `SESSION_SECRET` | None without the secret |
| Code guessing | Account access | 8 digits, 5 tries per request (atomic), per-IP failure cap, per-email request cap, 10 min TTL | ≤ 150 guesses per email per hour (30 requests × 5), each emailing the victim |
| Victim lockout | Victim can't sign in | Rows per request; failures per request and per IP; per-email cap is an alert at 10 and a ceiling at 30 per hour | A distributed attacker can hit the per-email ceiling; alert fires |
| Email quota exhaustion | Nobody gets codes | Separate code pool, per-IP daily cap, Turnstile for domain codes | Guest-only requests without Turnstile still cost per-IP quota |
| Login CSRF | Victim signed in as attacker | `__Host-` Lax pending cookie, `X-OA-Request`, `Sec-Fetch-Site: same-origin` or exact `Origin` | None known |
| Provider mix-up | Token for one flow accepted by another | State cookie carries the provider; nonce per attempt | None known |
| Recycled or spoofed identity | Takeover of old account | Key by `(google, sub)`; `identity_conflict`; codes refused for linked users | Admin reset needed |
| Test hooks on in production | Arbitrary sessions | Off unless var and 32+ char key; 404 otherwise; prod selftest asserts `testHooks: false` | Operator error on a staging install |
| Cookie tossing from a sibling host | Session fixation | `__Host-` cookies; hosted and content domains on the Public Suffix List | Until PSL inclusion ships in browsers |

---

## Data model

Migration `apps/server/migrations/0008_direct_signin.sql`. P2 owns 0008; P3 takes 0009 (agreed with Platform). P2 adds `users.status` because admission needs it first; P3 owns its transitions (suspend, remove, transfer) and the `spaces` table.

```sql
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,                -- 'google'
  subject     TEXT NOT NULL,                -- Google sub
  tenant      TEXT NOT NULL,                -- hd at link time
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS identities_user_provider ON identities(user_id, provider);

CREATE TABLE IF NOT EXISTS login_codes (
  email_key   TEXT NOT NULL,                -- b64url HMAC(K_codes, normEmail)
  request_id  TEXT NOT NULL,                -- 16 random bytes b64url, also in __Host-oa_code
  code_hash   TEXT NOT NULL,                -- b64url HMAC(K_codes, email_key ':' request_id ':' code)
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (email_key, request_id)
) WITHOUT ROWID;

ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- 'active' | 'suspended' | 'removed'; P3's sync writes it; P2 reads it
```

## Keys (M2)

`deriveKey(env, info)` = base64url(HKDF-SHA256(ikm = UTF-8 `SESSION_SECRET`, salt = UTF-8 `"open-artifacts/hkdf/v1"`, info = UTF-8 label, length 32 bytes)), cached per isolate by (secret, label). The result is passed as the `key` string to the existing `hmacSign`/`hmacVerify`.

| Label | Used for |
|---|---|
| `oa:session` | session cookie |
| `oa:oidc-state` | OIDC state cookies |
| `oa:code-cookie` | `__Host-oa_code` |
| `oa:login-codes` | `email_key`, `code_hash` (K_codes) |

Transition: `readSession` and `readOidcState` also accept the legacy raw-`SESSION_SECRET` signature until `LEGACY_KEY_UNTIL` (release date + 8 days, a constant), then a follow-up PR removes the fallback. New cookies are always signed with derived keys.

## Session (M1)

Payload `{ uid, exp, iat, p, t?, e }` (P3 reads `iat` and `p`): `iat` issue time (ms); `p` provider (`access` | `google` | `code`, plus `dev` and `test` for those paths; absent reads as `access`); `t` tenant, a **string**: the verified `hd` for Google sessions, the email domain for domain-code sessions, absent otherwise (`SessionPayload.t?: string` in #359); `e` the user's `session_epoch` at issue (absent reads as 0). In `session()` the user load selects `session_epoch`; the session is rejected when `(e ?? 0) !== user.sessionEpoch`, when `t` is set and `!inDomains(cfg.domains, t)`, or when `p === "code" && t` and `google` is enabled (N4 belt; setup also bumps every epoch when Google is turned on). A code session with no `t` (outside the domains) is always read-capped, whatever `FEATURES` says (H3). Epoch bumps (`session_epoch = session_epoch + 1`): role change, admin identity reset, guest demotion, guest row deletion is a delete. Guests via code: 24 h; everything else 7 days.

## Config contract

| Name | Kind | Values | Default |
|---|---|---|---|
| `AUTH_PROVIDERS` | var | comma list of `access`, `google`, `email` | unset = `access` |
| `AUTH_DOMAINS` | var | comma list of verified domains (IDNA A-labels, `xn--` allowed) | empty |
| `AUTH_DOMAIN_JOIN` | var | `member` or `invite` | `invite`. Hosted is always `invite` in M1: provision renders it and refuses `member`, and the server refuses anything else under `HOSTED=1` (#572) |
| `EMAIL_CODE_DOMAIN` | var | `on` or `off`; honored only while `google` is not enabled | `off` |
| `FEATURES` | var | #359 `parseFeatures` (snake_case: `spaces`, `sync_google`, `sync_frozen`, `guests_read_only`, `content_revocation`, `usage_off`) | empty. **`FEATURES` does not set the guest cap.** The cap is `authConfig.guestsReadOnly`, computed true whenever `google` or `email` is in `AUTH_PROVIDERS` (so `access,email` is capped), false on access-only installs (unchanged), and not configurable. P2 only *reports* it as `guests_read_only` in `Me.instance.features`; a `guests_read_only` entry in the `FEATURES` var is ignored. Code sessions outside the domains are capped regardless. There is no `GUEST_ACCESS` var. |
| `GOOGLE_CLIENT_ID` | var | Google client id | none |
| `GOOGLE_CLIENT_SECRET` | secret | direct transport only | none |
| `AUTH_BROKER_URL`, `INSTALL_ID` | var | presence of the URL selects the broker transport | none |
| `BROKER_SIGNING_KEY` | secret | Ed25519 private key, PKCS#8 DER, base64url (confirmed with Platform) | none |
| `TURNSTILE_SITE_KEY` | var | required when domain codes are on | none |
| `TURNSTILE_SECRET` | secret | same | none |
| `CODE_EMAILS_PER_DAY` | var | 1..10000 | 200 (code pool) |
| `EMAIL_DAILY_CAP` | var | 1..100000; set per install by Platform | 100. Replaces the hard-coded `MAX_EMAILS_PER_DAY` in `email/send.ts`: the daily cap of the invite and share pool (`email:*`). Codes use their own pool (`CODE_EMAILS_PER_DAY`, `code:*`), so invites can't starve sign-in (D7). |
| `HOSTED` | var | `1` on hosted installs | unset |
| `TEST_HOOKS`, `TEST_HOOK_KEY` | var, secret | `"1"` and 32+ chars | off; stg-a and stg-b only (Task 14) |
| `RL_AUTH` | ratelimit binding | 10 per 60 s | `ratelimits` entry in `wrangler.template.jsonc`; namespace id is a placeholder filled per install by setup or P1; never a literal in code. RL_ANON's literal `1001` moves to the template the same way (Platform). |

**P1 spike dependency (H5):** confirm Rate Limiting bindings work in Workers for Platforms user Workers, and whether their namespace is per account. Keys include the install either way.

## API contract for P4 (Frontend), per #359

The SPA (Frontend, P4) owns the sign-in chooser and the email and code forms at `SIGN_IN_PAGE` (`/sign-in`). P2 is JSON-only plus redirects and renders no sign-in HTML. Every refusal in a redirect flow lands on `SIGN_IN_PAGE?error=<SignInError>&next=…` (`no_access` included; never `PAGES.noAccess` in direct mode, per #359's ground rules). Errors use the existing envelope with the codes #359 adds (`turnstile_required`, `turnstile_failed`).

| Route (#359 name) | Status | P2 behavior |
|---|---|---|
| `GET AUTH.providers` | **new** | `AuthProvidersSchema`; public, `no-store`, no session, no D1. |
| `GET AUTH.login` | **changed** (direct) | Access: as today. Direct: 302 to `SIGN_IN_PAGE?next=<safeNext>`. |
| `GET AUTH.loginGoogle?next=` | **new** | 302 to Google or the broker; 404 when Google is off. |
| `GET AUTH.callbackGoogle` | **new** | 302 to `next` with the session, else `SIGN_IN_PAGE?error=<SignInErrorSchema>&next=…`. `Referrer-Policy: no-referrer`. |
| `GET AUTH.callback` | **changed** | Access only; 404 when `access` is not in `AUTH_PROVIDERS`; `no-referrer`; non-Access state refused. |
| `POST AUTH.codeRequest` | **new** | `CodeRequestSchema` → 202 `CodeRequestedSchema`. |
| `POST AUTH.codeVerify` | **new** | `CodeVerifySchema` → 200 `CodeVerifiedSchema`. |
| `POST AUTH.logout` | unchanged | 204. |
| `GET R.me` | **changed shape** | `Me.auth` (`MeAuthSchema`), `Me.instance.{hosted, signIn, features}`. |
| `DELETE R.memberIdentity(id, "google")` | **new** | 204; owner or admin; 404 for others, for no link, and for the owner's own link. Bumps the epoch. |

`SIGN_IN_PAGE`, `AUTH.loginGoogle`, `AUTH.callbackGoogle` join `COOP_EXEMPT`.

How P2 fills the #359 shapes:

| Schema | P2 rule |
|---|---|
| `AuthProvidersSchema` | Only fully configured providers. Email entry: `domainCodes` = `cfg.domainCodes`; `guests` = true whenever `email` is enabled; `turnstileSiteKey` present whenever Turnstile is configured. |
| `SignInErrorSchema` | `tenant` (hd missing or outside), `identity_conflict`, `removed` (removed or suspended, or a removed row owns the email), `no_access` (join `invite`, no row), `expired` (state cookie, second failure), `failed`. |
| `CODE_POLICY` | `length` 8, `ttlSec` 600, `resendAfterSec` 60, `maxAttempts` 5: P2 imports these; server-only limits live in `CODE_LIMITS` (Task 7). |
| `CodeRequestSchema` / `CodeRequestedSchema` | 202 for every well-formed address, eligible or not, and when the pool is full. **Turnstile is required on every request whenever it is configured** (400 `turnstile_required` with `TurnstileRequiredDetailsSchema`; rejected token 403 `turnstile_failed`). Hosted always configures it, which covers the manager's N1 and H1 step-ups; domain codes can't be enabled without it. |
| `CodeRateLimitedDetailsSchema` | 429 `rate_limited`, `Retry-After`, `scope: "ip"` (RL_AUTH, per-IP day) or `"email"` (per address per hour, and per (address, IP) per 10 min, reported as `"email"`). Never for the pool. |
| `normalizeCode` | P2 imports it, then requires `^[0-9]{8}$`. |
| `CodeVerifiedSchema` | `readOnly` = the caller's read cap (guest cap or code session outside the domains). |
| `CodeVerifyFailureDetailsSchema` | 401 `invalid_code{attemptsLeft}` / `expired` / `no_pending`, derived from the pending cookie (Task 7 step 7). 429 when the per-IP failure cap is hit, `scope: "ip"` (contract comment fix requested). |
| `MeAuthSchema` | `method` ∈ `AuthMethodSchema` (`access`, `google`, `code`, `pat`, `oauth`, `dev`, `test`); `readOnly`; `cap` = `"guest"` when P2's cap applies (P3 sets `"restricted"`), else null; `expiresAt` null for PAT and OAuth bearers. |
| `InstanceSignInSchema` | `{ mode, providers }` from `authConfig`. |
| `SessionPayload` | `{ uid, exp, iat, p, t?, e }`, `t` a string (see above). |

Existing tests touched:

| Test | Change |
|---|---|
| `apps/server/test/oidc.test.ts` | none (must pass unmodified) |
| `session.test.ts`, `devlogin.test.ts`, `host-session.test.ts` | `iat`, `p`, `t`, `e`; derived key; legacy cookies valid in the window |
| `json-shapes.snapshot.test.ts` | Me gains `auth`, `instance.hosted`, `instance.signIn` |
| `csrf.test.ts` | code POSTs need `X-OA-Request` with no cookie, and same-origin |
| `mcp.auth.test.ts` | popup via `/sign-in` keeps no COOP |
| `email.test.ts`, `invite-email.test.ts` | recipient counter key is `email:to:<sha256 hex>` |
| `skeleton.test.ts`, `smoke/healthz.ts`, `scripts/ci/staging-smoke.test.ts` | `/healthz` gains `testHooks` |
| `smoke/auth.ts` | when staging goes direct: first test becomes "302 to `/sign-in`" plus a `/auth/providers` smoke |
| dashboard `e2e/real/anonymous.spec.ts`, `full-screen.spec.ts`, `fixtures.ts` | none |
| dashboard `m1-a11y.spec.ts`, `m2-a11y.spec.ts`, `e2e/real/consent.spec.ts` | P4 adds `/sign-in` states and a direct-mode consent variant |

## Admission and linking rules

| Existing state | Sign-in | Result |
|---|---|---|
| no user | Google, `hd` ∈ domains, join `member` | create `member`, link `(google, sub)` |
| no user | Google, join `invite` | `no_access` |
| user X, no Google link | Google, same normalized email, `hd` ∈ domains | link to X; a `guest` X is promoted to `member` (because `hd` ∈ domains) |
| X linked to S1 | Google S2, same email | `identity_conflict` |
| S linked to X | Google S, new email | sign in as X; set `users.email` to the new email if free, else keep and log `email_drift` |
| any | `hd` missing or ∉ domains | `tenant` |
| `OWNER_EMAIL` | Google with `hd` ∈ domains | `owner` |
| `(google, sub)` linked to X, X `suspended` or `removed` | Google | `removed` |
| no link; a `suspended` or `removed` row has this email | Google | `removed`; never linked, never re-created (recycled-email takeover) |
| P3-synced X with `identities('google', <Directory user id>)` | Google `sub` = that id | sign in as X (same row) |
| P3-synced X linked to Directory id D1 | Google `sub` D2, same email | `identity_conflict` |

Every row created on this path goes through `insertUserStmts`; P3's insert trigger creates its personal space. After a successful admission the callback calls P3's `onGoogleSignIn(env, user)` (the `groups.list` diff for that user), then issues the session.

**Code eligibility (H3), checked at request and again at verify:**

| Address | Condition | Result |
|---|---|---|
| any user with an `identities` row | | ineligible |
| a `suspended` or `removed` row has this email | | ineligible |
| domain ∈ `AUTH_DOMAINS` | `google` enabled | ineligible |
| domain ∈ `AUTH_DOMAINS` | Google off, `EMAIL_CODE_DOMAIN=on`, Turnstile passed, existing row (any role, owner included) | eligible, keeps role, `t` = domain |
| domain ∈ `AUTH_DOMAINS` | same, no row, join `member` | eligible, created `member` at verify |
| outside domains | row with role `guest`, or no row and ≥ 1 share | eligible, session as `guest`, readOnly, 24 h |
| outside domains | row with role `owner`, `admin` or `member` | ineligible (no code by email outside the domain) |
| outside domains | no row, no share | ineligible |

Ineligible requests get the same 202 and no email.

## Domain verification (M6)

- **Self-hosted:** the operator sets `AUTH_DOMAINS`; recommend an "Internal" Google client.
- **Hosted, every claim:** admin proof by DNS: a TXT record `_oa-verify.<domain>` = `oa-verify=<token>` (token per install and domain), checked over DNS-over-HTTPS by the control plane, **plus** a Google sign-in through the broker whose `hd` equals the domain. A domain binds to one install. Consumer domains refused.
- **Hosted join (M1, Manager ruling 2026-10-24):** `AUTH_DOMAIN_JOIN` is forced to `invite` until a domain's ownership is proven, by the TXT check above or by a confirmed directory connection (super-admin consent with `hd` pinned and `customerId` bound). Follow-up: #572.
- **FinQore (M1):** FinQore's IT admin adds the TXT record (**needs user**: arrange with FinQore); we verify by hand and set the vars.

## Budgets

| Path | CPU target | D1 rows written | KV writes |
|---|---|---|---|
| `GET /auth/providers` | < 1 ms | 0 (no read) | 0 |
| Google callback, direct or broker | < 3 ms (one RS256 verify; broker adds one Ed25519 sign) | first sign-in: user 1 + identity 1 (+1 index); later: user `last_seen_at` 1 | 0 |
| Code request | < 2 ms | in the request: counters 3 (`code:ip`, `code:e`, `code:eip`) plus one pool read; in `waitUntil`, only for a real send: `code:sent` 1, `code:*` 1, `login_codes` 1. Turnstile is a subrequest | 0 |
| Code verify, success | < 2 ms | fail-slot reserve 1, attempts update 1, delete 1, refund 1, user upsert 1 | 0 |
| Code verify, failure | < 2 ms | fail-slot reserve 1, attempts update 1 (when a row matched) | 0 |

---

## Test helpers (created in Task 1, extended in Tasks 4 and 7)

`apps/server/test/auth-helpers.ts`:

```ts
export const CID = "cid.apps.googleusercontent.com";
export function direct(over: Partial<Env> = {}): Env;   // {...env, AUTH_PROVIDERS:"google,email", AUTH_DOMAINS:"a.com", AUTH_DOMAIN_JOIN:"member",
                                                         //  GOOGLE_CLIENT_ID:CID, GOOGLE_CLIENT_SECRET:"s", INSTALL_ID:"inst-a", ...over}
export function post(e: Env, path: string, body: unknown, o?: { cookie?: string; ip?: string; headers?: Record<string,string> }): Promise<Response>;
                                                         // JSON, X-OA-Request: 1, Sec-Fetch-Site: same-origin, CF-Connecting-IP: o.ip ?? "203.0.113.1"
export function get(e: Env, path: string, o?: { cookie?: string }): Promise<Response>;
export function setCookie(res: Response, name: string): string | null; // value of a Set-Cookie
export function seedUser(e: Env, email: string, role: Role, o?: { googleSub?: string; tenant?: string }): Promise<string>; // user id
export function seedShare(e: Env, email: string, role?: "viewer" | "editor"): Promise<string>; // artifact id
export const mail: { sent: { to: string; text: string }[]; codeFor(to: string): string; reset(): void }; // fake EMAIL binding
```

---

### Task 1: Auth config and key derivation

**Files:**
- Create: `packages/auth-core/src/domains.ts` (`parseDomains`, `inDomains`), `packages/auth-core/package.json`
- Create: `apps/server/src/auth/config.ts`, `apps/server/src/auth/keys.ts`
- Modify: `apps/server/src/env.ts` (all vars and secrets above; `ACCESS_*` optional)
- Create: `apps/server/test/auth-helpers.ts`
- Test: `packages/auth-core/test/domains.test.ts`, `apps/server/test/auth-config.test.ts`, `apps/server/test/keys.test.ts`

**Interfaces:**
- `type ProviderId = "access" | "google"`.
- `parseDomains(raw: string): { domains: string[]; invalid: string[] }`; `inDomains(domains: readonly string[], d: unknown): boolean` (exact, case-sensitive against the lowercase list).
- `type AuthConfig = { providers: ReadonlySet<ProviderId | "email">; domains: readonly string[]; domainJoin: "member" | "invite"; domainCodes: boolean; guestsReadOnly: boolean; features: FeatureFlag[]; google: { clientId: string; transport: { kind: "direct"; secret: string } | { kind: "broker"; url: string; installId: string; signingKey: string } } | null; turnstile: { siteKey: string; secret: string } | null; codeEmailsPerDay: number; installKey: string; problems: string[] }`; `authConfig(env: Env): AuthConfig` (memoized in a `WeakMap<Env, AuthConfig>`). `installKey = INSTALL_ID ?? APP_HOST`. `features = parseFeatures(env.FEATURES)` (#359; it already drops `guests_read_only`, so only `ENV_FEATURE_FLAGS` can be set). `guestsReadOnly = providers.has("google") || providers.has("email")` (not configurable; `FEATURES` can't set it). `Me.instance.features` = `features`, plus `guests_read_only` when `guestsReadOnly` (reported only). `domainCodes` is true only if `EMAIL_CODE_DOMAIN === "on"`, `google` is not enabled, `turnstile` is configured and domains are non-empty.
- `deriveKey(env: Pick<Env, "SESSION_SECRET">, label: "oa:session" | "oa:oidc-state" | "oa:code-cookie" | "oa:login-codes"): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/auth-core/test/domains.test.ts
test("parses, lowercases, dedupes, accepts IDNA", () => {
  expect(parseDomains(" A.com ,a.com,xn--bcher-kva.example,shop.xn--p1ai,bad domain,b.co.")).toEqual({
    domains: ["a.com", "xn--bcher-kva.example", "shop.xn--p1ai"], invalid: ["bad domain", "b.co."] });
});
test("inDomains is exact", () => {
  for (const d of ["evil.a.com", "a.com.", "A.COM", "xa.com", "", undefined, 1]) expect(inDomains(["a.com"], d)).toBe(false);
  expect(inDomains(["a.com"], "a.com")).toBe(true);
});

// apps/server/test/auth-config.test.ts
test("unset is access only, guests share", () => {
  const c = authConfig({ ...env, AUTH_PROVIDERS: undefined } as Env);
  expect([...c.providers]).toEqual(["access"]); expect(c.guestsReadOnly).toBe(false); expect(c.domainJoin).toBe("invite");
});
test("FEATURES can't set the guest cap; direct sign-in always does", () => {
  expect(authConfig({ ...env, AUTH_PROVIDERS: undefined, FEATURES: "guests_read_only" } as Env).guestsReadOnly).toBe(false);
  expect(authConfig(direct({ FEATURES: "" })).guestsReadOnly).toBe(true);
});
test("google without domains is disabled", () => {
  const c = authConfig(direct({ AUTH_DOMAINS: "" }));
  expect(c.google).toBeNull(); expect(c.problems).toContain("google: AUTH_DOMAINS is empty");
});
test("domain codes are off whenever google is on", () =>
  expect(authConfig(direct({ EMAIL_CODE_DOMAIN: "on", TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" })).domainCodes).toBe(false));
test("domain codes need turnstile", () => {
  const e = direct({ AUTH_PROVIDERS: "email", EMAIL_CODE_DOMAIN: "on" });
  expect(authConfig(e).domainCodes).toBe(false);
  expect(authConfig({ ...e, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }).domainCodes).toBe(true);
});
test("broker transport needs INSTALL_ID and a PKCS8 Ed25519 key", () => {
  expect(authConfig(direct({ AUTH_BROKER_URL: "https://auth.h.test", BROKER_SIGNING_KEY: "not-a-key" })).google).toBeNull();
});
test("installKey falls back to APP_HOST", () =>
  expect(authConfig(direct({ INSTALL_ID: undefined })).installKey).toBe(env.APP_HOST));

// apps/server/test/keys.test.ts
test("derived keys are pinned (HKDF-SHA256, salt open-artifacts/hkdf/v1)", async () => {
  expect(await deriveKey({ SESSION_SECRET: "x".repeat(32) }, "oa:session")).toBe(KNOWN_SESSION_KEY); // vector computed once in Step 3 with WebCrypto and frozen
  const labels = ["oa:session", "oa:oidc-state", "oa:code-cookie", "oa:login-codes"] as const;
  const ks = await Promise.all(labels.map((l) => deriveKey({ SESSION_SECRET: "x".repeat(32) }, l)));
  expect(new Set(ks).size).toBe(4);
});
```

- [ ] **Step 2: Run** `pnpm -C packages/auth-core vitest run && pnpm -C apps/server vitest run test/auth-config.test.ts test/keys.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Domain label regex per label: `^(?!-)[a-z0-9-]{1,63}(?<!-)$`; TLD: `^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`; total ≤ 253; at least two labels. `deriveKey`: `crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveBits"])`, then `deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("open-artifacts/hkdf/v1"), info: utf8(label) }, key, 256)`, base64url.
- [ ] **Step 4: Run.** Expected: PASS; `pnpm -C apps/server typecheck`.
- [ ] **Step 5: Commit** `feat(auth): config contract, domain parsing, HKDF keys`.

### Task 2: Provider interface, derived-key cookies, session epoch and tenant

**Files:**
- Create: `apps/server/src/auth/providers/types.ts`, `apps/server/src/auth/providers/access.ts`
- Modify: `apps/server/src/auth/oidc.ts` (state `p`; `buildAuthorizeRedirect(env, provider, next, opts)`; `handleCallback(env, provider, req): Promise<VerifiedIdentity & { next: string }>`; state signed with `deriveKey("oa:oidc-state")`, legacy accepted until `LEGACY_KEY_UNTIL`)
- Modify: `apps/server/src/auth/session.ts`: `signSession(env, uid, now = Date.now(), opts: { provider?: SessionProvider; tenant?: string; epoch?: number; maxAgeS?: number } = {})` (positional `now` kept: the 11 call sites are unchanged); `readSession(env, value, now)` returns `{ uid, exp, iat, p, t?, e }`; `sessionCookie(value, env, maxAgeS = MAX_AGE_S)`
- Modify: `apps/server/src/http/middleware.ts` (`session()` checks `e` against `users.session_epoch` and `t` against `cfg.domains`; sets `c.var.authMethod`, `c.var.sessionExp`), `apps/server/src/services/users.ts` (`USER_BY_ID` selects `session_epoch as sessionEpoch`; `getUser` returns it on an internal type, `Member` unchanged)
- Modify: `apps/server/src/routes/auth.ts` (`/auth/callback` 404 when `access` ∉ providers; `Referrer-Policy: no-referrer`)
- Test: `apps/server/test/oidc.test.ts` (unchanged), `apps/server/test/oidc-provider.test.ts`, `apps/server/test/session.test.ts`

**Interfaces:**
```ts
type VerifiedIdentity = { provider: ProviderId; subject: string; email: string; name: string | null; tenant: string | null };
interface OidcProvider {
  id: ProviderId;
  callbackPath: string;
  authorizeUrl(env: Env, a: { state: string; nonce: string; challenge: string }): Promise<string>;
  redeem(env: Env, a: { code: string; verifier: string; nonce: string }): Promise<VerifiedIdentity>; // throws ApiError("unauthorized") after logOidcFail(stage)
}
type SessionProvider = "access" | "google" | "code" | "dev" | "test";
```

- [ ] **Step 1: Write the failing tests**

```ts
// oidc-provider.test.ts (fake Access issuer reused from oidc.test.ts via an exported fixture)
test("a google state cookie is refused at the Access callback with no token call", async () => {
  const { cookie, state } = await stateCookieFor(env, "google");
  const r = await get(env, `/auth/callback?state=${state}&code=x`, { cookie });
  expect(r.status).toBe(302); expect(r.headers.get("location")).toContain("retry=1");
  expect(tokenCalls).toHaveLength(0);
});
test("state cookies without p read as access", async () => { /* sign legacy payload without p; full Access round trip succeeds */ });
test("/auth/callback is 404 when access is not enabled", async () =>
  expect((await get(direct(), "/auth/callback?state=s&code=c")).status).toBe(404));
test("callback responses carry Referrer-Policy: no-referrer", async () => {
  const r = await get(env, "/auth/callback?state=s&code=c");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
});

// session.test.ts
test("new sessions use the derived key; legacy raw-secret cookies still read until LEGACY_KEY_UNTIL", async () => {
  const legacy = await legacySign(env, uid);               // old format, raw SESSION_SECRET
  expect(await readSession(env, legacy, LEGACY_KEY_UNTIL - 1)).not.toBeNull();
  expect(await readSession(env, legacy, LEGACY_KEY_UNTIL + 1)).toBeNull();
});
test("signSession keeps positional now and defaults", async () => {
  const v = await signSession(env, uid, 1_000);
  expect(await readSession(env, v, 1_001)).toEqual({ uid, exp: 1_000 + 7 * 86400_000, iat: 1_000, p: "access", e: 0 });
});
test("N2: an epoch-1 user with an epoch-1 session is accepted; epoch-0 session is rejected", async () => {
  const { userId } = await login("bob@a.com");
  await env.DB.prepare("update users set session_epoch = 1 where id = ?").bind(userId).run();
  const ok = `${sessionCookieName(env)}=${await signSession(env, userId, Date.now(), { epoch: 1 })}`;
  const stale = `${sessionCookieName(env)}=${await signSession(env, userId, Date.now(), { epoch: 0 })}`;
  expect((await api(app, "/api/v1/me", ok)).status).toBe(200);
  expect((await api(app, "/api/v1/me", stale)).status).toBe(401);
});
test("N4: a domain code session ends when google is enabled", async () => {
  const id = await seedUser(trial(), "own@a.com", "owner");
  const c = `${sessionCookieName(env)}=${await signSession(env, id, Date.now(), { provider: "code", tenant: "a.com" })}`;
  expect((await api(app, "/api/v1/me", c, {}, trial())).status).toBe(200);
  expect((await api(app, "/api/v1/me", c, {}, direct())).status).toBe(401);
});
test("epoch bump revokes", async () => {
  const { cookie, userId } = await login("bob@a.com");
  await env.DB.prepare("update users set session_epoch = session_epoch + 1 where id = ?").bind(userId).run();
  expect((await api(app, "/api/v1/me", cookie)).status).toBe(401);
});
test("a session whose tenant left AUTH_DOMAINS is rejected", async () => {
  const id = await seedUser(direct(), "bob@a.com", "member");
  const c = `${sessionCookieName(env)}=${await signSession(env, id, Date.now(), { provider: "google", tenant: "a.com" })}`;
  expect((await api(app, "/api/v1/me", c, {}, direct({ AUTH_DOMAINS: "b.com" }))).status).toBe(401);
});
test("sessionCookie Max-Age is a parameter", () =>
  expect(sessionCookie("v", env, 86400)).toContain("Max-Age=86400"));
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/oidc-provider.test.ts test/oidc.test.ts test/session.test.ts`. Expected: new tests FAIL; `oidc.test.ts` passes.
- [ ] **Step 3: Implement.** `handleCallback` compares `st.p ?? "access"` with the route's provider before any upstream call.
- [ ] **Step 4: Run** the three files plus `test/host-session.test.ts test/devlogin.test.ts`; `git diff --exit-code apps/server/test/oidc.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(auth): provider interface, derived keys, session epoch and tenant`.

### Task 3: Migration 0008 and lifecycle hooks

**Files:**
- Create: `apps/server/migrations/0008_direct_signin.sql` (+ `meta/0008_snapshot.json`, `_journal.json`)
- Modify: `apps/server/src/db/schema.ts` (`identities`, `loginCodes`, `users.sessionEpoch`)
- Modify: `apps/server/src/services/members.ts` (`removeMember` deletes identities in its batch; `patchMember` bumps `session_epoch`)
- Modify: `apps/server/src/services/shares.ts` (`deleteShare`: when the share's email belongs to a `guest` row with no remaining shares, delete that user in the same batch)
- Modify: `apps/server/src/cron.ts` (delete `login_codes` with `expires_at < now`)
- Test: `apps/server/test/db.test.ts`, `apps/server/test/members.test.ts`, `apps/server/test/shares.test.ts`, `apps/server/test/cron.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// db.test.ts
test("0008 creates identities, login_codes and users.session_epoch", async () => {
  const cols = await env.DB.prepare("select name from pragma_table_info('users')").all<{ name: string }>();
  expect(cols.results.map((c) => c.name)).toContain("session_epoch");
  const pk = await env.DB.prepare("select name from pragma_table_info('login_codes') where pk > 0 order by pk").all<{ name: string }>();
  expect(pk.results.map((c) => c.name)).toEqual(["email_key", "request_id"]);
});
// members.test.ts
test("removeMember deletes the member's identities", async () => {
  const id = await seedUser(env, "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" });
  await removeMember(env, id);
  expect((await env.DB.prepare("select count(*) n from identities").first<{ n: number }>())?.n).toBe(0);
});
test("role change bumps session_epoch", async () => {
  const id = await seedUser(env, "bob@a.com", "member");
  await patchMember(env, id, { role: "admin" });
  expect((await env.DB.prepare("select session_epoch e from users where id=?").bind(id).first<{ e: number }>())?.e).toBe(1);
});
// shares.test.ts
test("deleting a guest's last share deletes the guest; a remaining share keeps them", async () => {
  const a1 = await seedShare(env, "g@x.com"); const a2 = await seedShare(env, "g@x.com");
  const gid = await seedUser(env, "g@x.com", "guest");
  await deleteShare(env, owner, a1, "g@x.com"); expect(await userExists(gid)).toBe(true);
  await deleteShare(env, owner, a2, "g@x.com"); expect(await userExists(gid)).toBe(false);
});
// cron.test.ts
test("cron sweeps expired login codes only", async () => {
  await insertCode({ requestId: "old", expiresAt: Date.now() - 1 }); await insertCode({ requestId: "live", expiresAt: Date.now() + 60_000 });
  await runCron(env);
  expect(await codeIds()).toEqual(["live"]);
});
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/db.test.ts test/members.test.ts test/shares.test.ts test/cron.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `pnpm -C apps/server drizzle-kit generate`, rename to `0008_direct_signin.sql`, hand-add `IF NOT EXISTS` like 0007 (the `ALTER TABLE` stays plain; drizzle's journal guards reruns).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): identities, login_codes, session_epoch (0008)`.

### Task 4: Shared Google ID token verification and the direct transport

**Files:**
- Create: `packages/auth-core/src/google.ts`, `packages/auth-core/test/google.test.ts`
- Create: `apps/server/src/auth/providers/google.ts`
- Create: `apps/server/test/fixtures/fake-google.ts` (exported for P5 and the broker tests)
- Test: `apps/server/test/google.test.ts`

**Interfaces:**
```ts
// packages/auth-core (no Env, no AuthConfig)
type GoogleIdentity = { sub: string; email: string; name: string | null; hd: string };
function verifyGoogleIdToken(
  opts: { clientId: string; domains: readonly string[]; jwks?: JWTVerifyGetKey; now?: number },
  idToken: string,
  nonce: string,
): Promise<GoogleIdentity>; // throws GoogleTokenError { stage: "jwt_verify" | "aud" | "azp" | "nonce" | "email_unverified" | "tenant" | "claims" }
// fixture
fakeGoogle(): { mint(claims: Partial<JWTPayload>, o?: { alg?: string; key?: CryptoKey; kid?: string }): Promise<string>;
                issueCode(claims: Partial<JWTPayload>, challenge: string): string; tokenCalls: URLSearchParams[]; restore(): void };
```

Pinned check order inside `verifyGoogleIdToken`: (1) `jwtVerify(idToken, jwks, { algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId, clockTolerance: 60, requiredClaims: ["sub", "exp", "iat", "nonce", "email"], currentDate })`; (2) `aud` must be the string `clientId` or a one-element array of it; (3) `azp`, when present, `=== clientId`; (4) nonce via constant-time compare of SHA-256 digests (`crypto.subtle.timingSafeEqual`); (5) `email_verified === true`; (6) `typeof hd === "string" && inDomains(domains, hd)`. JWKS default: `createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))`, cached at module scope.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/auth-core/test/google.test.ts  (local JWKS from a generated RS256 key)
const base = { iss: "https://accounts.google.com", aud: CID, azp: CID, sub: "S1", email: "bob@a.com",
               email_verified: true, hd: "a.com", nonce: "n1" };
const v = (claims: object, o: { nonce?: string; alg?: string; key?: CryptoKey } = {}) =>
  mintLocal({ ...base, ...claims }, o).then((t) => verifyGoogleIdToken({ clientId: CID, domains: ["a.com"], jwks }, t, o.nonce ?? "n1"));
test("accepts the baseline", async () => expect(await v({})).toEqual({ sub: "S1", email: "bob@a.com", name: null, hd: "a.com" }));
test("accepts an alias email when hd matches", async () => expect((await v({ email: "bob@alias.com" })).hd).toBe("a.com"));
test.each([
  [{ hd: undefined }, "tenant"], [{ hd: "b.com" }, "tenant"], [{ hd: "A.com" }, "tenant"], [{ hd: "a.com." }, "tenant"], [{ hd: "x.a.com" }, "tenant"],
  [{ email_verified: undefined }, "email_unverified"], [{ email_verified: "true" }, "email_unverified"],
  [{ aud: "other" }, "jwt_verify"], [{ aud: [CID, "other"] }, "aud"], [{ azp: "other" }, "azp"],
  [{ iss: "https://evil" }, "jwt_verify"], [{ exp: now() - 120 }, "jwt_verify"], [{ sub: undefined }, "jwt_verify"],
])("rejects %o with %s", async (claims, stage) => await expect(v(claims)).rejects.toMatchObject({ stage }));
test("a validly signed token carrying another flow's nonce is refused", async () =>
  await expect(v({ nonce: "other-flow" })).rejects.toMatchObject({ stage: "nonce" }));
test.each(["HS256", "none", "ES256", "PS256"])("wrong alg %s is refused", async (alg) =>
  await expect(v({}, { alg })).rejects.toMatchObject({ stage: "jwt_verify" }));
test("unknown signing key is refused", async () =>
  await expect(v({}, { key: (await generateKeyPair("RS256")).privateKey })).rejects.toMatchObject({ stage: "jwt_verify" }));

// apps/server/test/google.test.ts (fake Google behind the fetch spy)
test("direct round trip: PKCE verifier matches, session p=google t=a.com, redirect to next", async () => {
  const start = await get(direct(), "/auth/login/google?next=/a/x");
  const loc = new URL(start.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(Object.fromEntries(loc.searchParams)).toMatchObject({ client_id: CID, response_type: "code", scope: "openid email profile",
    prompt: "select_account", hd: "a.com", code_challenge_method: "S256" });
  const code = g.issueCode({ ...base, nonce: loc.searchParams.get("nonce")! }, loc.searchParams.get("code_challenge")!);
  const cb = await get(direct(), `/auth/callback/google?code=${code}&state=${loc.searchParams.get("state")}`, { cookie: stateCookieOf(start) });
  expect(cb.headers.get("location")).toBe("/a/x");
  expect(await readSession(env, setCookie(cb, sessionCookieName(env))!)).toMatchObject({ p: "google", t: "a.com" });
});
test("tenant B's token at install A → /sign-in?error=tenant, no session", async () => { /* same flow with hd: "b.com" */ });
```

- [ ] **Step 2: Run** `pnpm -C packages/auth-core vitest run && pnpm -C apps/server vitest run test/google.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `googleProvider.redeem` for the direct transport: POST `https://oauth2.googleapis.com/token` (`grant_type=authorization_code`, `code`, `redirect_uri=${appOrigin}/auth/callback/google`, `client_id`, `client_secret`, `code_verifier`), then `verifyGoogleIdToken({ clientId, domains: cfg.domains }, id_token, st.nonce)`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): Google ID token verification and direct sign-in`.

### Task 5: Admission and linking

**Files:**
- Create: `apps/server/src/services/identity.ts`
- Test: `apps/server/test/identity.test.ts`

**Interfaces:**
- `admit(env: Env, cfg: AuthConfig, id: VerifiedIdentity): Promise<{ ok: true; user: Member } | { ok: false; reason: "tenant" | "identity_conflict" | "removed" | "no_access" }>`
- `insertUserStmts(env: Env, u: { id: string; email: string; name: string; role: Role; now: number }): D1PreparedStatement[]` in `services/users.ts`: the **only** way to insert a user. It returns only the `users` insert; the personal space comes from P3's D1 trigger, not from this helper. P2 moves every existing insert site onto it: `upsert` (Access sign-in, dev-login), `inviteMember`, guest creation, code verify, `/__test/session`.
- `codeEligibility(env: Env, cfg: AuthConfig, email: string): Promise<{ kind: "member"; userId: string | null; role: Role } | { kind: "guest"; userId: string | null } | { kind: "none" }>` (no writes)
- `resetIdentity(env: Env, actor: Member, userId: string): Promise<void>` (404 when the target is the owner or has no link; bumps the epoch)

Pinned write for first Google sign-in (one `db.batch`, race-safe):

```sql
-- insertUserStmts(…) expands to (P3's AFTER INSERT trigger adds the personal space):
INSERT INTO users (id, email, name, role, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
  ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at WHERE users.status = 'active';
-- link only an active row (never a removed or suspended one):
INSERT INTO identities (provider, subject, tenant, user_id, created_at)
  SELECT 'google', ?6, ?7, id, ?5 FROM users WHERE email = ?2 AND status = 'active'
  ON CONFLICT(provider, subject) DO NOTHING;
SELECT u.id, u.email, u.name, u.display_name, u.role, u.last_seen_at, u.status, i.subject
  FROM users u LEFT JOIN identities i ON i.user_id = u.id AND i.provider = 'google' WHERE u.email = ?2;
```

The final row decides: `status <> 'active'` → `removed`; `subject = ?6` → ok; another subject → `identity_conflict` (the `identities_user_provider` unique index makes a second link for the same user fail inside `DO NOTHING`'s sibling path, so the check is on the read). Guest promotion to `member` happens only when `inDomains(cfg.domains, id.tenant)` (the `hd`), never from the email domain.

- [ ] **Step 1: Write the failing tests**

```ts
const g = (o: Partial<VerifiedIdentity> = {}): VerifiedIdentity =>
  ({ provider: "google", subject: "S1", email: "bob@a.com", name: "Bob", tenant: "a.com", ...o });
test("no user, join member → creates member and link", async () => {
  const r = await admit(env, authConfig(direct()), g());
  expect(r).toMatchObject({ ok: true, user: { email: "bob@a.com", role: "member" } });
  expect(await subjectOf("bob@a.com")).toBe("S1");
});
test("no user, join invite → no_access", async () =>
  expect(await admit(env, authConfig(direct({ AUTH_DOMAIN_JOIN: "invite" })), g())).toEqual({ ok: false, reason: "no_access" }));
test("existing Access user keeps id and artifacts", async () => {
  const id = await seedUser(env, "bob@a.com", "member"); const art = await seedArtifact(id);
  const r = await admit(env, authConfig(direct()), g()); expect(r.ok && r.user.id).toBe(id); expect(await ownerOf(art)).toBe(id);
});
test("different sub, same email → identity_conflict", async () => {
  await seedUser(env, "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" });
  expect(await admit(env, authConfig(direct()), g({ subject: "S2" }))).toEqual({ ok: false, reason: "identity_conflict" });
});
test("email drift updates users.email when free", async () => {
  const id = await seedUser(env, "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" });
  await admit(env, authConfig(direct()), g({ email: "robert@a.com" })); expect(await emailOf(id)).toBe("robert@a.com");
});
test("email drift keeps the old email when the new one is taken", async () => {
  const id = await seedUser(env, "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" }); await seedUser(env, "robert@a.com", "member");
  await admit(env, authConfig(direct()), g({ email: "robert@a.com" })); expect(await emailOf(id)).toBe("bob@a.com");
});
test("guest row promoted only by hd", async () => {
  await seedUser(env, "g@alias.com", "guest");
  const r = await admit(env, authConfig(direct()), g({ email: "g@alias.com", subject: "S9" }));
  expect(r.ok && r.user.role).toBe("member");
});
test("tenant outside domains → tenant", async () =>
  expect(await admit(env, authConfig(direct()), g({ tenant: "b.com" }))).toEqual({ ok: false, reason: "tenant" }));
test("concurrent first sign-in creates one user and one identity", async () => {
  await Promise.all([admit(env, authConfig(direct()), g()), admit(env, authConfig(direct()), g())]);
  expect(await count("users where email='bob@a.com'")).toBe(1); expect(await count("identities")).toBe(1);
});
test.each([
  ["linked user", async () => seedUser(env, "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" }), "bob@a.com", direct({ AUTH_PROVIDERS: "email" }), "none"],
  ["domain user, google on", async () => seedUser(env, "bob@a.com", "member"), "bob@a.com", direct(), "none"],
  ["outside-domain owner", async () => seedUser(env, "boss@x.com", "owner"), "boss@x.com", direct(), "none"],
  ["outside-domain member", async () => seedUser(env, "m@x.com", "member"), "m@x.com", direct(), "none"],
  ["invited guest", async () => seedUser(env, "g@x.com", "guest"), "g@x.com", direct(), "guest"],
  ["shared, no row", async () => seedShare(env, "s@x.com"), "s@x.com", direct(), "guest"],
  ["uninvited", async () => undefined, "u@x.com", direct(), "none"],
  ["trial domain owner", async () => seedUser(env, "own@a.com", "owner"), "own@a.com", trial(), "member"],
])("codeEligibility: %s", async (_n, seed, email, e, kind) => {
  await seed(); expect((await codeEligibility(env, authConfig(e), email)).kind).toBe(kind);
});
test("admin can't reset the owner's link; member can't reset anyone", async () => { /* 404s */ });
test("linked user who is suspended or removed → removed", async () => {
  for (const status of ["suspended", "removed"]) {
    const id = await seedUser(env, `${status}@a.com`, "member", { googleSub: `S-${status}`, tenant: "a.com" });
    await setStatus(id, status);
    expect(await admit(env, authConfig(direct()), g({ email: `${status}@a.com`, subject: `S-${status}` }))).toEqual({ ok: false, reason: "removed" });
  }
});
test("recycled email: a removed row is never linked by email or re-created", async () => {
  const old = await seedUser(env, "bob@a.com", "member"); await setStatus(old, "removed");
  expect(await admit(env, authConfig(direct()), g({ subject: "NEW" }))).toEqual({ ok: false, reason: "removed" });
  expect(await count("identities")).toBe(0); expect(await count("users where email='bob@a.com'")).toBe(1);
});
test("P3-synced identity: Google sub equal to the Directory user id signs in as that row", async () => {
  const id = await seedUser(env, "bob@a.com", "member", { googleSub: "112233445566", tenant: "a.com" }); // as P3's sync writes it
  const r = await admit(env, authConfig(direct()), g({ subject: "112233445566" })); expect(r.ok && r.user.id).toBe(id);
  expect(await admit(env, authConfig(direct()), g({ subject: "999" }))).toEqual({ ok: false, reason: "identity_conflict" });
});
test("codes: removed row's email is ineligible", async () => {
  const id = await seedUser(env, "g@x.com", "guest"); await setStatus(id, "removed");
  expect((await codeEligibility(env, authConfig(direct()), "g@x.com")).kind).toBe("none");
});
test("every user insert goes through insertUserStmts", async () => {
  // structural: no `insert(users)` / "insert into users" outside services/users.ts insertUserStmts
  const offenders = await grepSrc(/insert\(users\)|insert into users/i, { except: "src/services/users.ts" });
  expect(offenders).toEqual([]);
});
test("insertUserStmts is used by Google admit, code verify, invite, Access sign-in, dev-login and the session hook", async () => {
  const spy = vi.spyOn(usersMod, "insertUserStmts");
  await runEachInsertPath();                 // helper drives the six paths once each
  expect(spy).toHaveBeenCalledTimes(6);
});
```

(`trial()` = `direct({ AUTH_PROVIDERS: "email", EMAIL_CODE_DOMAIN: "on", TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" })`, added to the helpers.)

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/identity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Lookup first by `(google, sub)` (one prepared statement joined to `users`, selecting `status`; not active → `removed`), then the batch above. `tenant` re-checked against `cfg` on every sign-in. Move every user insert onto `insertUserStmts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): admission, linking and code eligibility`.

### Task 6: Providers endpoint, Google routes, Me

**Files:**
- Create: `apps/server/src/services/directory.ts` stub `export async function onGoogleSignIn(env: Env, user: Member): Promise<void> {}` (P3 owns the body: the `groups.list` diff for that user)
- Modify: `apps/server/src/routes/auth.ts` (after `admit` ok: `await onGoogleSignIn(env, user)` in a try/catch that logs `directory_sync_failed` and continues; then the session), `apps/server/src/routes/me.ts`, `apps/server/src/routes/members.ts`, `apps/server/src/http/middleware.ts` (`COOP_EXEMPT`), `packages/shared/src/routes.ts`, `packages/shared/src/schemas.ts`
- Test: `apps/server/test/auth-routes.test.ts`, `apps/server/test/json-shapes.snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("access-only: /auth/providers and /auth/login unchanged", async () => {
  expect(await (await get(env, "/auth/providers")).json()).toEqual({ mode: "access", providers: [{ id: "access", start: "/auth/login" }] });
  expect(new URL((await get(env, "/auth/login?next=/")).headers.get("location")!).hostname).toMatch(/cloudflareaccess|access/);
});
test("direct: /auth/login → /sign-in with safeNext", async () => {
  expect((await get(direct(), "/auth/login?next=//evil.com")).headers.get("location")).toBe("/sign-in?next=%2F");
});
test("providers lists only configured ones and does no D1", async () => {
  const spy = vi.spyOn(env.DB, "prepare");
  const body = await (await get(direct({ GOOGLE_CLIENT_SECRET: "" }), "/auth/providers")).json();
  expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["email"]); expect(spy).not.toHaveBeenCalled();
});
test("no COOP on /sign-in and the Google routes", async () => {
  for (const p of ["/sign-in", "/auth/login/google", "/auth/callback/google"])
    expect((await get(direct(), p)).headers.get("cross-origin-opener-policy")).toBeNull();
});
test.each(["tenant", "identity_conflict", "removed", "no_access", "failed"])(
  "refusal %s lands on /sign-in?error=%s with next kept, no session, no /no-access", async (reason) => { /* drive each via fakeGoogle */ });
test("direct mode serves no HTML from /auth/*", async () => {
  for (const p of ["/auth/login", "/auth/login/google", "/auth/callback/google", "/auth/providers"])
    expect((await get(direct(), p)).headers.get("content-type") ?? "").not.toContain("text/html");
});
test("MCP popup: /oauth/authorize → /auth/login → /sign-in → google → consent page", async () => { /* mcp-helpers */ });
test("me.auth for session, PAT and dev", async () => {
  const { cookie } = await login("bob@a.com");
  expect((await (await api(app, "/api/v1/me", cookie)).json()).auth).toMatchObject({ method: "access", readOnly: false });
  const pat = await createPat(env, uid, "t");
  expect((await (await api(app, "/api/v1/me", pat.token)).json()).auth).toEqual({ method: "pat", readOnly: false, cap: null, expiresAt: null });
});
test("admin resets a link (epoch bumped); owner's link is 404", async () => { /* DELETE /api/v1/members/:id/identities/google */ });
test("onGoogleSignIn is called once after a successful admission, before the session, never on refusal", async () => {
  const spy = vi.spyOn(directory, "onGoogleSignIn").mockResolvedValue();
  await googleRoundTrip(direct()); expect(spy).toHaveBeenCalledTimes(1);
  await googleRoundTrip(direct(), { hd: "b.com" }); expect(spy).toHaveBeenCalledTimes(1);
});
test("an onGoogleSignIn failure is logged and does not block sign-in", async () => { /* mockRejectedValue → still 302 to next */ });
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/auth-routes.test.ts test/json-shapes.snapshot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the contract; update the Me snapshot.
- [ ] **Step 4: Run** plus `test/oidc.test.ts test/csrf.test.ts test/mcp.auth.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): providers endpoint, Google routes, Me sign-in fields`.

### Task 7: One-time code service

**Files:**
- Create: `apps/server/src/auth/codes.ts`, `apps/server/src/auth/turnstile.ts`
- Modify: `apps/server/src/email/send.ts` (`EmailKind` += `"code"`; code sends use only the code pool; the existing recipient key becomes `email:to:<sha256 hex>`; `MAX_EMAILS_PER_DAY` is replaced by `emailDailyCap(env: Env): number` = `EMAIL_DAILY_CAP` parsed as an integer 1..100000, else 100), `apps/server/src/email/templates.ts` (`loginCodeEmail`)
- Test: `apps/server/test/codes.test.ts`, `apps/server/test/email.templates.test.ts`, `apps/server/test/email.test.ts`

**Interfaces:**
```ts
// CODE_POLICY (length, ttlSec, resendAfterSec, maxAttempts) comes from #359.
const CODE_LIMITS = { perEmailIpPer10Min: 3, perEmailPerHourAlert: 10, perEmailPerHour: 30,
  sendsPerEmailPerHour: 5, perIpPerDay: 50, failsPerIpPerHour: 30 } as const;
emailKey(env: Env, email: string): Promise<string>;                       // HMAC(K_codes, normEmail)
ipKey(env: Env, ip: string): Promise<string>;                             // HMAC(K_codes, "ip:" + ip), first 22 chars
takeRequestSlot(env: Env, cfg: AuthConfig, ek: string, ik: string, now?: number):
  Promise<{ ok: true } | { ok: false; retryAfter: number; scope: "ip" | "email" }>;
  // per-request counters only (every well-formed address); (address, IP) refusals report scope "email" per #359
createCode(env: Env, ek: string, now?: number): Promise<{ requestId: string; code: string }>; // inserts the row
deliverCode(env: Env, cfg: AuthConfig, email: string, ek: string, now?: number): Promise<{ requestId: string } | null>;
  // eligibility → createCode → sendEmail; on send failure deletes the row; returns the requestId or null (ineligible / failed)
verifyCode(env: Env, cfg: AuthConfig, p: { email: string; requestId: string; input: string; ip: string; now?: number }):
  Promise<{ ok: true } | { ok: false } | { ok: false; ipLocked: number /* retryAfter s */ }>;
  // deliberately no reason: whether a row existed must not shape the answer (enumeration); the route derives the message from the cookie
verifyTurnstile(cfg: AuthConfig, token: string | undefined, ip: string): Promise<boolean>; // siteverify subrequest
```

The request route needs the `requestId` in the cookie before the work runs in `waitUntil`: the route generates `requestId` itself, sets the cookie, and `deliverCode` uses it (so the signature passes it in: `deliverCode(env, cfg, email, ek, requestId, now?)`). For ineligible addresses no row is written, and verify ends in `invalid_code`.

**Pinned verify algorithm** (same statements whether or not a row exists):

1. `norm = input.replace(/[\s-]/g, "")`; `wellFormed = /^[0-9]{8}$/.test(norm)`.
2. Per-IP failure slot, atomic: `INSERT INTO counters (key, n, day) VALUES ('code:fail:<ik>', 1, ?hour) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN day = excluded.day THEN n + 1 ELSE 1 END, day = excluded.day WHERE day <> excluded.day OR n < ?cap RETURNING n`. No row → `ip_locked` (no further statements). The slot is reserved before the guess, so parallel requests can't overshoot the cap.
3. `UPDATE login_codes SET attempts = attempts + 1 WHERE email_key = ?1 AND request_id = ?2 AND attempts < 5 AND expires_at > ?3 RETURNING code_hash, attempts` (atomic in D1; at most 5 callers ever get a row).
4. `candidate = HMAC(K_codes, ek + ":" + requestId + ":" + (wellFormed ? norm : "x"))`; `stored = row?.code_hash ?? DUMMY_HASH`; `match = row !== null && wellFormed && timingSafeEqual(b64urlDecode(candidate), b64urlDecode(stored))`. The HMAC and compare always run.
5. One batch, always: `DELETE FROM login_codes WHERE email_key=?1 AND request_id=?2 AND code_hash=?4 RETURNING 1` with `?4 = match ? stored : "!"`, and `UPDATE counters SET n = n - 1 WHERE key = 'code:fail:<ik>' AND ?5` with `?5 = match` (a success refunds the reserved slot; the statement runs either way).
6. Result: `ok` only when `match` and the DELETE returned a row (a concurrent success that already consumed it → not ok). Everything else is `{ ok: false }`.
7. The route maps the answer to the contract using only the signed pending cookie, which carries `f` (failed tries so far) and `exp`: `now > exp` → `expired`; otherwise `f' = f + 1`, re-set the cookie, `attemptsLeft = max(0, 5 - f')`, and `attemptsLeft === 0` → `expired` (cookie cleared), else `invalid_code`. An ineligible address (no row ever) therefore gets exactly the same sequence of answers as a wrong guess; the server-side limit is still the row's `attempts`.

SQL equality in step 5 is only a consumption guard on a value the Worker already compared in constant time; user input never meets `code_hash` in SQL.

Turnstile: verified first on every request whenever configured (#359); missing → 400 `turnstile_required`, rejected → 403 `turnstile_failed`, both before any counter.

Request throttles, in the request (count **every** well-formed address, for enumeration resistance): `code:ip:<ik>` per day (50), `code:e:<ek>` per hour (`code_abuse` logged at 10, refuse at 30), `code:eip:<ek>:<ik>` per 10 min (3; also the 60 s resend floor). RL_AUTH key `${cfg.installKey}:${ip}` runs first.

Send limits, in `waitUntil` **after eligibility, only for a real send (N1)**: `code:sent:<ek>` per hour (5 actual sends per address) and the pool `code:*` per day (`CODE_EMAILS_PER_DAY`). Both are atomic conditional upserts (`… WHERE n < cap RETURNING n`); no row means no send, logged as `code_send_capped`, and the response was already the same 202. The pool never produces a 429, and random addresses can't drain it because ineligible addresses never take a pool slot.

Invites and shares keep `email:*`, capped by `EMAIL_DAILY_CAP` (default 100) instead of the `MAX_EMAILS_PER_DAY` constant.

- [ ] **Step 1: Write the failing tests**

```ts
const E = "g@x.com";
test("code is 8 digits and uniform", async () => {
  const counts = Array.from({ length: 8 }, () => new Array(10).fill(0));
  for (let i = 0; i < 10_000; i++) [...(await createCode(env, "ek", 0)).code].forEach((d, p) => counts[p][+d]++);
  for (const pos of counts) for (const n of pos) expect(Math.abs(n - 1000)).toBeLessThan(5 * Math.sqrt(900));
});
test("stored row has no plaintext email or code", async () => {
  await seedUser(env, E, "guest"); const ek = await emailKey(env, E);
  const { code } = await createCode(env, ek);
  const row = JSON.stringify(await env.DB.prepare("select * from login_codes").first());
  expect(row).not.toContain(E); expect(row).not.toContain(code);
});
test.each(["1234 5678", "1234-5678", " 12345678 ", "1234\t5678"])("normalizes %j", async (input) => {
  const { requestId } = await fixedCode(env, E, "12345678");
  expect(await verifyCode(env, cfg, { email: E, requestId, input, ip: "1.1.1.1" })).toEqual({ ok: true });
});
test("malformed input uses an attempt", async () => {
  const { requestId } = await fixedCode(env, E, "12345678");
  expect(await verifyCode(env, cfg, { email: E, requestId, input: "1234 567", ip })).toEqual({ ok: false });
  expect(await verifyCode(env, cfg, { email: E, requestId, input: "1234a5678", ip })).toEqual({ ok: false });
  expect(await attemptsOf(requestId)).toBe(2);
});
test("H2: 50 concurrent wrong guesses, then the right code is refused", async () => {
  const { requestId } = await fixedCode(env, E, "12345678");
  const rs = await Promise.all(Array.from({ length: 50 }, () => verifyCode(env, cfg, { email: E, requestId, input: "00000000", ip: rndIp() })));
  expect(rs.every((r) => !r.ok)).toBe(true);
  expect(await attemptsOf(requestId)).toBe(5);                      // the atomic UPDATE let exactly 5 through
  expect(await verifyCode(env, cfg, { email: E, requestId, input: "12345678", ip })).toEqual({ ok: false });
});
test("single use", async () => {
  const { requestId } = await fixedCode(env, E, "12345678");
  expect((await verifyCode(env, cfg, { email: E, requestId, input: "12345678", ip })).ok).toBe(true);
  expect(await verifyCode(env, cfg, { email: E, requestId, input: "12345678", ip })).toEqual({ ok: false });
});
test("expired at ttl + 1 ms", async () => {
  const { requestId } = await fixedCode(env, E, "12345678", 0);
  expect(await verifyCode(env, cfg, { email: E, requestId, input: "12345678", ip, now: CODE_POLICY.ttlSec * 1000 + 1 })).toEqual({ ok: false });
});
test("H1: an attacker's request and wrong guesses don't kill the victim's pending code", async () => {
  await seedUser(env, E, "guest");
  const victim = await fixedCode(env, E, "12345678");
  const attacker = await fixedCode(env, E, "87654321");              // second request for the same email
  for (let i = 0; i < 5; i++) await verifyCode(env, cfg, { email: E, requestId: attacker.requestId, input: "00000000", ip: "9.9.9.9" });
  expect(await verifyCode(env, cfg, { email: E, requestId: victim.requestId, input: "12345678", ip: "1.1.1.1" })).toEqual({ ok: true });
});
test("per-IP failure cap locks that IP only", async () => { /* 30 failures from 9.9.9.9 → { ok: false, ipLocked: n }; 1.1.1.1 still verifies */ });
test("same statement sequence with and without a row", async () => {
  const seq = async (rid: string) => { const log = spyD1Sql(env); await verifyCode(env, cfg, { email: E, requestId: rid, input: "00000000", ip }); return log(); };
  const { requestId } = await fixedCode(env, E, "12345678");
  expect(await seq("no-such-request")).toEqual(await seq(requestId));
});
test("request throttles count ineligible addresses too and never use plaintext keys", async () => {
  for (let i = 0; i < 3; i++) expect((await takeRequestSlot(env, cfg, await emailKey(env, "nobody@x.com"), "ik")).ok).toBe(true);
  expect(await takeRequestSlot(env, cfg, await emailKey(env, "nobody@x.com"), "ik")).toMatchObject({ ok: false, scope: "email" });
  const keys = (await env.DB.prepare("select key from counters").all<{ key: string }>()).results.map((r) => r.key);
  expect(keys.some((k) => k.includes("@"))).toBe(false);
});
test("per-email: code_abuse logged at 10 requests per hour, refusal at 30, across IPs", async () => {
  const ek = await emailKey(env, "g@x.com"); const logs = captureLogs();
  for (let i = 0; i < 30; i++) expect(await takeRequestSlot(env, cfg, ek, `ik${i}`)).toEqual({ ok: true });
  expect(logs().filter((l) => l.evt === "code_abuse")).toHaveLength(1);
  expect(await takeRequestSlot(env, cfg, ek, "ik30")).toMatchObject({ ok: false, scope: "email" });
});
test("H1: at most 5 real sends per address per hour", async () => {
  await seedUser(env, E, "guest"); const ek = await emailKey(env, E);
  for (let i = 0; i < 5; i++) expect(await deliverCode(env, cfg, E, ek, `r${i}`)).not.toBeNull();
  expect(await deliverCode(env, cfg, E, ek, "r5")).toBeNull(); expect(mail.sent).toHaveLength(5);
});
test("N1: random ineligible addresses never take a pool slot", async () => {
  for (let i = 0; i < 200; i++) await deliverCode(env, cfg, `rnd${i}@x.com`, await emailKey(env, `rnd${i}@x.com`), `r${i}`);
  expect(await counter("code:*")).toBe(0);
  await seedUser(env, E, "guest"); expect(await deliverCode(env, cfg, E, await emailKey(env, E), "real")).not.toBeNull();
});
test("N1: a full pool sends nothing", async () => {
  const e = direct({ CODE_EMAILS_PER_DAY: "4" }); await seedUser(e, E, "guest");
  await fillCounter("code:*", 4);
  expect(await deliverCode(e, authConfig(e), E, await emailKey(e, E), "r")).toBeNull();
});
test("H2: parallel failures from one IP never exceed the fail cap", async () => {
  const rs = await Promise.all(Array.from({ length: 60 }, () => verifyCode(env, cfg, { email: E, requestId: "none", input: "00000000", ip: "9.9.9.9" })));
  expect(rs.filter((r) => "ipLocked" in r)).toHaveLength(30); expect(await counter("code:fail:" + (await ipKey(env, "9.9.9.9")))).toBe(30);
});
test("EMAIL_DAILY_CAP replaces MAX_EMAILS_PER_DAY for invites and shares", async () => {
  const e = { ...env, EMAIL_DAILY_CAP: "3" } as Env;
  for (let i = 0; i < 3; i++) expect((await inviteMember(e, admin, { email: `n${i}@a.com`, role: "member" })).emailed).toBe(true);
  expect((await inviteMember(e, admin, { email: "n3@a.com", role: "member" })).emailed).toBe(false);
});
test("EMAIL_DAILY_CAP unset or invalid falls back to 100", async () => {
  for (const v of [undefined, "", "0", "abc"]) expect(emailDailyCap({ ...env, EMAIL_DAILY_CAP: v } as Env)).toBe(100);
});
test("a full invite pool does not block codes", async () => {
  const e = direct({ EMAIL_DAILY_CAP: "1" }); await fillCounter("email:*", 1); await seedUser(e, E, "guest");
  expect(await deliverCode(e, authConfig(e), E, await emailKey(e, E), "rid")).not.toBeNull();
});
test("code pool is separate from the invite pool", async () => {
  await fillCounter("email:*", 100);
  await seedUser(env, E, "guest"); expect(await deliverCode(env, cfg, E, await emailKey(env, E), "rid")).not.toBeNull();
});
test("code from install A does not verify on install B", async () => {
  const { requestId, row } = await fixedCode(env, E, "12345678");
  const envB = { ...env, SESSION_SECRET: "y".repeat(32) };
  await copyRowTo(envB, row);
  expect((await verifyCode(envB, authConfig(envB), { email: E, requestId, input: "12345678", ip })).ok).toBe(false);
});
test("send failure deletes the row", async () => { /* EMAIL.send rejects → no login_codes rows */ });
test("logs never contain the email or the code", async () => { /* console spies over a full deliver + verify */ });
test("template: code shown as 1234 5678, expiry, no link with the code, no em dash", () => {
  const m = loginCodeEmail({ code: "12345678", instance: "Acme", appHost: "a.test", minutes: 10 });
  expect(m.text).toContain("1234 5678"); expect(m.text).toContain("10 minutes");
  expect(m.html).not.toMatch(/href="[^"]*12345678/); expect(m.text + m.html).not.toContain("\u2014");
});
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/codes.test.ts test/email.templates.test.ts test/email.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the pinned algorithm. Digit generation: `crypto.getRandomValues(new Uint32Array(1))`, reject values ≥ 4_200_000_000 (largest multiple of 10^8 below 2^32), then `% 10^8`, zero-padded.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): emailed one-time codes`.

### Task 8: Code routes

**Files:**
- Modify: `apps/server/src/routes/auth.ts`, `apps/server/src/app.ts` (`loginPostGuard()`: requires `X-OA-Request: 1`, `content-type: application/json`, and `Sec-Fetch-Site: same-origin`, or, when that header is absent, `Origin` exactly equal to the app origin), `apps/server/wrangler.template.jsonc`, `wrangler.test.jsonc`, `wrangler.staging.jsonc` (`RL_AUTH` `ratelimits` entries with placeholder ids), `apps/server/src/env.ts`
- Test: `apps/server/test/code-routes.test.ts`, `apps/server/test/csrf.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const req = (e: Env, email: string, o: { ip?: string; token?: string } = {}) =>
  post(e, "/auth/code/request", { email, next: "/a/x", turnstileToken: o.token }, { ip: o.ip });
test("202 is byte-identical for eligible, ineligible and email-off addresses", async () => {
  await seedUser(direct(), "g@x.com", "guest");
  const [a, b] = [await req(direct(), "g@x.com"), await req(direct(), "nobody@x.com", { ip: "203.0.113.2" })];
  const c = await req(direct({ EMAIL_FROM: "" }), "g@x.com", { ip: "203.0.113.3" });
  const aBody = await a.text();
  for (const r of [b, c]) { expect(r.status).toBe(a.status); expect(await r.text()).toBe(aBody); }
});
test("delivery runs in waitUntil", async () => { /* EMAIL.send held on a deferred; response resolves first */ });
test("resend within the window is 429 scope email, for eligible and ineligible alike", async () => { /* 4th request in 10 min from one IP */ });
test("RL_AUTH keys on install and IP", async () => {
  const seen: string[] = []; const e = direct({ RL_AUTH: { limit: async ({ key }) => (seen.push(key), { success: true }) } as RateLimit });
  await req(e, "g@x.com", { ip: "203.0.113.9" }); expect(seen).toEqual(["inst-a:203.0.113.9"]);
});
test("round trip: guest gets readOnly and 24 h; trial member gets 7 days", async () => {
  await seedUser(direct(), "g@x.com", "guest");
  const r1 = await req(direct(), "g@x.com"); const cookie = `__Host-oa_code=${setCookie(r1, "__Host-oa_code")}`;
  const v = await post(direct(), "/auth/code/verify", { code: mail.codeFor("g@x.com") }, { cookie });
  expect(await v.json()).toMatchObject({ next: "/a/x", user: { role: "guest" }, readOnly: true });
  expect(v.headers.get("set-cookie")).toContain("Max-Age=86400");
});
test("Turnstile configured: no token → 400 turnstile_required with TurnstileRequiredDetails; bad token → 403 turnstile_failed; both before any counter", async () => {
  const e = direct({ TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" });
  const r1 = await req(e, "g@x.com"); expect(r1.status).toBe(400);
  expect(await errOf(r1)).toMatchObject({ code: "turnstile_required", details: { field: "turnstile", required: true } });
  stubSiteverify(false); const r2 = await req(e, "g@x.com", { token: "bad" }); expect(r2.status).toBe(403);
  expect((await errOf(r2)).code).toBe("turnstile_failed"); expect(await counterRows()).toBe(0);
});
test("responses parse with the #359 schemas", async () => { /* CodeRequestedSchema, CodeVerifiedSchema, CodeVerifyFailureDetailsSchema, CodeRateLimitedDetailsSchema .parse() on each */ });
test("full code pool: still 202, no email, no 429", async () => {
  const e = direct({ CODE_EMAILS_PER_DAY: "1" }); await seedUser(e, "g@x.com", "guest"); await fillCounter("code:*", 1);
  const r = await req(e, "g@x.com", { token: "ok" }); expect(r.status).toBe(202); expect(mail.sent).toHaveLength(0);
});
test("code sign-in for a Google-linked user is refused (no email sent)", async () => {
  await seedUser(direct(), "bob@a.com", "member", { googleSub: "S1", tenant: "a.com" });
  await req(trial(), "bob@a.com", { token: "ok" }); expect(mail.sent).toHaveLength(0);
});
test("outside-domain owner can't sign in by code", async () => {
  await seedUser(direct(), "boss@x.com", "owner"); await req(direct(), "boss@x.com"); expect(mail.sent).toHaveLength(0);
});
test("verify reasons from the cookie: invalid_code 4,3,2,1 then expired; no cookie → no_pending; ip cap → 429 scope ip", async () => { /* … */ });
test("an ineligible address gets the same verify answers as a wrong guess", async () => {
  const seqFor = async (email: string) => { const c = await requestCookie(direct(), email); const out = [];
    for (let i = 0; i < 5; i++) out.push(await (await post(direct(), "/auth/code/verify", { code: "00000000" }, { cookie: c.next() })).json());
    return out; };
  await seedUser(direct(), "g@x.com", "guest");
  expect(await seqFor("nobody@x.com")).toEqual(await seqFor("g@x.com"));
});
test("\"1234 567\" and \"1234a5678\" are invalid_code and each uses an attempt", async () => { /* attemptsLeft 4 then 3 */ });
test("next is safeNext'd", async () => { /* next: "//evil.com" → verify returns "/" */ });
test("cross-site or missing X-OA-Request → 403 csrf", async () => {
  expect((await post(direct(), "/auth/code/request", { email: "g@x.com" }, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await post(direct(), "/auth/code/request", { email: "g@x.com" }, { headers: { "x-oa-request": "" } })).status).toBe(403);
});
test("codes off → 404 on both", async () => { /* AUTH_PROVIDERS: "google" */ });
test("MCP popup via code: member reaches consent; guest gets members-only", async () => { /* mcp-helpers */ });
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/code-routes.test.ts test/csrf.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `__Host-oa_code` = `deriveKey("oa:code-cookie")`-signed `{ ek, email, rid, next: safeNext(next), exp }`, 600 s; cleared on success and on `expired`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): code sign-in routes`.

### Task 9: Guests are read-only

**Files:**
- Modify: `apps/server/src/http/middleware.ts` (`c.var.readOnly = (p === "code" && !t) || (user.role === "guest" && cfg.guestsReadOnly)`), `apps/server/src/auth/authz.ts` (`Caller` gains `readOnly: boolean`; export `capForGuest(caller: Caller, level: AccessLevel): AccessLevel` = `caller.readOnly ? "viewer" : level` for any level above viewer (`editor`, `manager`, `owner`; #359's `AccessLevelSchema` adds `manager`); `cap` in `MeAuth` is `"guest"` here, and P3's restriction sets `"restricted"` through the same `Caller.readOnly`; `accessLevel` applies it), `apps/server/src/services/artifacts.ts` and `apps/server/src/routes/artifacts.ts` (create by a capped caller: 403 `space_forbidden`, per #359; upload: 404), `apps/server/src/runtime/routes.ts` (data and storage writes refused for guests in read mode, D1), `apps/server/src/routes/shares.ts` (an outside-domain share with role `editor` is stored as `viewer` in read mode; response `downgraded: true`)
- Test: `apps/server/test/guest-readonly.test.ts`, `apps/server/test/authz.matrix.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const setup = async (e: Env) => {
  const ownerC = await login("own@a.com"); const art = await publishHtml(ownerC.cookie);
  await api(app, `/api/v1/artifacts/${art}/shares`, ownerC.cookie, { method: "PUT", body: { email: "g@x.com", role: "editor" } }, e);
  const g = await loginAs(e, "g@x.com", "guest"); return { art, g };
};
test("read mode: guest can read but every write is refused", async () => {
  const { art, g } = await setup(direct());
  expect((await api(app, `/api/v1/artifacts/${art}`, g, {}, direct())).status).toBe(200);
  for (const [method, path, body] of [
    ["POST", `/api/v1/artifacts/${art}/versions`, html()], ["PATCH", `/api/v1/artifacts/${art}`, { title: "x" }],
    ["DELETE", `/api/v1/artifacts/${art}`, undefined], ["PUT", `/api/v1/artifacts/${art}/shares`, { email: "z@x.com", role: "viewer" }],
    ["POST", "/api/v1/uploads", { path: "a", size: 1 }],
  ] as const) expect((await api(app, path, g, { method, body }, direct())).status).toBe(404);
  const create = await api(app, "/api/v1/artifacts", g, { method: "POST", body: html() }, direct());
  expect(create.status).toBe(403); expect((await errOf(create)).code).toBe("space_forbidden");
  expect(await dataSet(direct(), art, g, "c", "d", { v: 1 })).toMatchObject({ code: "not_found" });
  expect(await storageSet(direct(), art, g, "k", 1)).toMatchObject({ code: "not_found" });
});
test("H3: with AUTH_PROVIDERS=access,email a code guest holding an editor share is read-only", async () => {
  const e = { ...env, AUTH_PROVIDERS: "access,email", FEATURES: "" } as Env;
  expect(authConfig(e).guestsReadOnly).toBe(true);
  const { art } = await setup(e); const g = await codeSessionFor(e, "g@x.com");
  expect((await api(app, `/api/v1/artifacts/${art}`, g, { method: "PATCH", body: { title: "x" } }, e)).status).toBe(404);
});
test("H3: a code session outside the domains is read-capped whatever FEATURES says", async () => {
  const e = { ...direct(), FEATURES: "spaces" } as Env;
  const { art } = await setup(e); const g = await codeSessionFor(e, "g@x.com");
  expect((await api(app, `/api/v1/artifacts/${art}`, g, { method: "PATCH", body: { title: "x" } }, e)).status).toBe(404);
});
test("share mode keeps today's editor rights (Access installs)", async () => {
  const { art, g } = await setup(env);
  expect((await api(app, `/api/v1/artifacts/${art}`, g, { method: "PATCH", body: { title: "x" } })).status).toBe(200);
});
test("editor share to an outside address is stored as viewer in read mode", async () => { /* downgraded: true */ });
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/guest-readonly.test.ts test/authz.matrix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** P3 calls `capForGuest` from its space-role checks.
- [ ] **Step 4: Run** plus `test/shares.test.ts test/runtime.routes.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(authz): guests are read-only under direct sign-in`.

### Task 10: Auth events and CPU budgets

**Files:**
- Create: `apps/server/src/auth/audit.ts`
- Modify: Tasks 6, 8, 14 call sites; `apps/server/test/cpu-budget/structural.test.ts`, `budgets.bench.ts`
- Test: `apps/server/test/auth-audit.test.ts`

**Interfaces:** `type AuthEvent = { evt: "auth" | "code_abuse" | "code_send_capped" | "directory_sync_failed" | "test_hook.session" | "test_hook.otp" | "test_hook.oauth_client" | "test_hook.denied"; provider?: SessionProvider; outcome: "ok" | "refused" | "error"; stage?: string; uid?: string; tenant?: string }`; `logAuth(e: AuthEvent): void`.

- [ ] **Step 1: Write the failing tests**

```ts
test("every sign-in outcome logs exactly one auth event and none contain @ or digits runs of 8", async () => {
  const lines = captureLogs(); await runAllSignInOutcomes();       // helper drives: google ok, tenant, conflict, code ok, invalid, expired
  const evts = lines().filter((l) => l.evt === "auth");
  expect(evts).toHaveLength(6);
  for (const l of lines()) { const s = JSON.stringify(l); expect(s).not.toContain("@"); expect(s).not.toMatch(/\d{8}/); }
});
// structural.test.ts rows (Free settings): /auth/providers < 1 ms; /auth/callback/google < 3 ms; code request < 2 ms; code verify < 2 ms
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/auth-audit.test.ts && pnpm -C apps/server test:cpu`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): sign-in events and CPU budgets`.

### Task 11: Auth broker (hosted Google transport)

**Files:**
- Create: `apps/auth-broker/` (`src/index.ts`, `src/registry.ts`, `wrangler.jsonc`, `test/broker.test.ts`); Platform deploys it to `auth.<hosted>`
- Modify: `apps/server/src/auth/providers/google.ts` (broker transport), `packages/auth-core/src/ed25519.ts` (`signRedeem`, `verifyRedeem`)
- Test: `apps/auth-broker/test/broker.test.ts`, `apps/server/test/google-broker.test.ts`

**Interfaces:**
- Registry (KV `BROKER_REGISTRY`, written by P1 provisioning; read-only here): `{ installId: string; origin: string; keys: { kid: string; x: string /* raw 32-byte Ed25519 public key, base64url (confirmed with Platform) */ }[] /* kid = keyId(x) */ /* at most 2 active */; disabled?: boolean }`. No secrets. Broker secrets: `GOOGLE_CLIENT_SECRET`, `BROKER_STATE_KEY`.
- `GET /google/authorize?install&state&nonce&code_challenge`: registry lookup; 302 to Google with `redirect_uri=https://auth.<hosted>/google/callback`, `state = bstate` (HMAC(`BROKER_STATE_KEY`) over `{ install, s: state, exp: now + 900 }`), the install's `nonce` and `code_challenge`, `prompt=select_account`.
- `GET /google/callback?code&state`: verify `bstate`; 302 to `<registry origin>/auth/callback/google?code&state=<s>`. Origin only from the registry.
- `POST /google/redeem`: headers `X-OA-Kid`, `X-OA-Sig` = base64url(Ed25519 over the exact body bytes); body `{ install, code, verifier, ts }`. Checks: install exists and is enabled; `kid` ∈ its keys; signature; `|now - ts| ≤ 60 s`. Then exchanges the code with Google and returns `{ id_token }` **unmodified**. Google errors → 400 `{ error: "exchange_failed" }`. The broker never verifies on the install's behalf, never signs assertions, and never logs code, verifier, email or token.
- Install side: `redeem` POSTs (service binding `BROKER` when bound, else `fetch(AUTH_BROKER_URL)`), then runs the same `verifyGoogleIdToken({ clientId: GOOGLE_CLIENT_ID, domains }, id_token, st.nonce)` as the direct transport.
- Key id (N3): `keyId(x) = base64url(SHA-256(raw public key bytes)).slice(0, 16)` in `packages/auth-core`. The install derives `x` from its private key (import PKCS#8 as extractable, export JWK, read `x`) and sends `X-OA-Kid: keyId(x)`; the broker recomputes `keyId` for each registry key and refuses entries whose stored `kid` doesn't match. There is no `BROKER_KID` var, so it can't drift on rotation.
- Rotation (M3): P1 adds the new public key to the registry, swaps the install's `BROKER_SIGNING_KEY`, then removes the old key.

- [ ] **Step 1: Write the failing tests**

```ts
// broker.test.ts
test("redeem returns Google's id_token unchanged", async () => {
  const r = await redeem(A, { code: g.issueCode(base, ch), verifier: v });
  expect((await r.json()).id_token).toBe(g.lastIdToken());
});
test("A's key signing a redeem for install B is refused", async () =>
  expect((await redeem(A, { install: "inst-b", code: "c", verifier: "v" })).status).toBe(401));
test("unknown kid, bad signature, stale ts (61 s), disabled install → 401, no Google call", async () => {
  for (const r of [await redeem(A, {}, { kid: "nope" }), await redeem(A, {}, { tamper: true }),
                   await redeem(A, { ts: now() - 61_000 }), await redeem(DISABLED, {})]) expect(r.status).toBe(401);
  expect(g.tokenCalls).toHaveLength(0);
});
test("second active key works during rotation; removed key fails", async () => { /* registry with k1,k2 */ });
test("N3: kid is the SHA-256 prefix of x; a registry entry with a mismatched kid is refused", async () => {
  expect(await keyId(X_A)).toBe(b64url(await sha256(rawOf(X_A))).slice(0, 16));
  await putRegistry({ ...entryA, keys: [{ kid: "wrong", x: X_A }] });
  expect((await redeem(A, {})).status).toBe(401);
});
test("callback redirects only to the registry origin; swapped install in bstate fails HMAC", async () => { /* … */ });
test("registry holds no secret material", async () =>
  expect(Object.keys(await registryEntry("inst-a")).sort()).toEqual(["installId", "keys", "origin"]));
test("broker logs contain no code, verifier, token or email", async () => { /* spies */ });

// google-broker.test.ts (install side; broker stubbed)
test("install verifies the raw token: hd of B refused at A even if the broker returns it", async () => {
  stubBroker({ id_token: await g.mint({ ...base, hd: "b.com", nonce }) });
  expect((await callbackA()).headers.get("location")).toContain("error=tenant");
});
test("token minted for another flow's nonce is refused", async () => { /* stub returns a valid token with nonce "other" → error=failed */ });
test("expired token from the broker is refused", async () => { /* exp past → error=failed */ });
test("replayed redeem result: the same id_token on a second callback fails (state cookie single use, nonce differs)", async () => {
  const t = await completeFlowCapturingIdToken(); stubBroker({ id_token: t });
  expect((await callbackWithFreshState()).headers.get("location")).toContain("error=failed");
});
test("a forged token signed by an attacker key is refused", async () => { /* local key, not in Google JWKS */ });
```

- [ ] **Step 2: Run** `pnpm -C apps/auth-broker vitest run && pnpm -C apps/server vitest run test/google-broker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Ed25519 via `crypto.subtle.importKey("pkcs8", …, { name: "Ed25519" }, false, ["sign"])` on the install and `"raw"` public import in the broker.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth-broker): stateless Google broker returning raw ID tokens`.

FinQore can go live on the direct transport with a dedicated client if this slips; the broker is required before a second hosted install.

### Task 12: Setup contract (Platform builds it; Backend reviews)

**Files (Platform):** `scripts/setup/src/index.ts`, `steps/access.ts`, `steps/secrets.ts`, `tunables.ts`, `steps/selftest.ts`, `state.ts`, `apps/server/wrangler.template.jsonc` (`RL_AUTH` and `RL_ANON` placeholders)
- Test: `scripts/setup/test/auth-mode.test.ts`

**Contract:**
- Default `--auth access`; upgrades keep the persisted mode.
- N4: when a run turns `google` on for an install that didn't have it, setup runs `UPDATE users SET session_epoch = session_epoch + 1` once (ends every session, including domain code sessions); the server also rejects `p=code` sessions with `t` once Google is on.
- `--auth direct --google-client-id <id> --auth-domains a.com[,b.com] [--email-codes guests|trial|off] [--domain-join invite|member]` (default join `invite`). `trial` requires Turnstile keys (`--turnstile-site-key`, secret via hidden prompt or `OA_TURNSTILE_SECRET`) and no Google.
- Secrets via stdin only. Codes need the email step.
- Prints the redirect URI `https://<appHost>/auth/callback/google`; recommends an "Internal" client.
- Ratelimit namespace ids are written into the generated wrangler config from state, never hard-coded.
- Selftest: `/auth/providers` matches the mode; `/auth/login` 302s to `/sign-in` in direct mode; production asserts `/healthz` `testHooks: false`.
- Hosted provisioning (P1): input `{ installId, origin, domains, brokerPublicKey: { x } }` (kid computed as `keyId(x)`); generates the Ed25519 pair locally, puts the private key as the install secret, writes only the public key to the registry; sets `HOSTED=1`, `AUTH_DOMAIN_JOIN=member`; supports a second key for rotation.

- [ ] **Step 1: Write the failing tests**

```ts
test("default run keeps access and writes no AUTH_ vars", async () => {
  const s = await runSetup([]); expect(s.vars.AUTH_PROVIDERS).toBeUndefined(); expect(s.steps).toContain("access");
});
test("direct writes vars, skips access, never deletes the Access app", async () => {
  const s = await runSetup(["--auth", "direct", "--google-client-id", "cid", "--auth-domains", "a.com"], { secret: "s" });
  expect(s.vars).toMatchObject({ AUTH_PROVIDERS: "google,email", AUTH_DOMAINS: "a.com", AUTH_DOMAIN_JOIN: "invite" });
  expect(s.cfCalls.filter((c) => c.method === "DELETE")).toHaveLength(0);
});
test("trial without Turnstile is refused; trial with google is refused", async () => { /* exits with messages */ });
test("upgrade keeps the persisted mode", async () => { /* state auth=direct → --upgrade keeps it */ });
test("N4: enabling google bumps every session_epoch once", async () => {
  const s = await runSetup(["--auth", "direct", "--google-client-id", "cid", "--auth-domains", "a.com"], { prior: { providers: "email" } });
  expect(s.d1Exec).toContain("UPDATE users SET session_epoch = session_epoch + 1");
  const again = await runSetup(["--auth", "direct", "--google-client-id", "cid", "--auth-domains", "a.com"], { prior: { providers: "google,email" } });
  expect(again.d1Exec).not.toContain("session_epoch");
});
test("secrets never appear in argv or logs", async () => { /* spawn spy + log capture */ });
test("ratelimit namespace ids come from state, not literals", async () => { /* generated config contains state ids */ });
```

- [ ] **Step 2: Run** `pnpm -C scripts/setup vitest run test/auth-mode.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus the whole setup suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): direct sign-in option`.

### Task 13: Sign-in negative catalog and docs

**Files:**
- Create: `apps/server/test/xt/signin-negative.ts` (`SIGNIN_NEGATIVE_CASES: { name: string; run(a: LiveInstall, b: LiveInstall): Promise<void> }[]`, `LiveInstall = { origin: string; hookKey: string }`), `apps/server/test/xt.local.test.ts`, `apps/server/vitest.xt.config.ts`
- Create: `docs/self-hosting/direct-sign-in.md`; Modify: `docs/security/security.md` (threat table above, broker, code path, hooks)

P5 runs the catalog **live against stg-a and stg-b on every release**, broker cases included (both on the broker transport), and blocks the release on failure.

- [ ] **Step 1: Write the failing test**

```ts
// xt.local.test.ts: two app instances (different SESSION_SECRET, domains a.com / b.com, broker keys), hooks on
test.each(SIGNIN_NEGATIVE_CASES.map((c) => [c.name, c]))("%s", async (_n, c) => c.run(localA, localB));
```

Cases (each asserts the refusal):
1. A's session cookie (hook) at B `/api/v1/me` → 401.
2. A's code (OTP hook) verified at B with a B pending cookie → 401 `invalid_code`.
3. A's PAT and A's OAuth token (hook) at B `/api/v1/me` and `/mcp` → 401.
4. Forged Google ID token (attacker key) at A's callback → `error=failed`.
5. Broker: A's key signing a redeem for B → 401; stale ts → 401; bstate with install swapped → refused; callback never leaves the registry origin.
6. Token for tenant B returned by the broker to A → `error=tenant`.
7. Real second-tenant Google account at A → `error=tenant` (manual until the test Workspaces exist; **needs user**).

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/xt.local.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the cases using Task 14's hooks for credentials.
- [ ] **Step 4: Run.** Expected: PASS. Then `pnpm -C apps/server xt:live` with `XT_A`, `XT_B`, `XT_A_KEY`, `XT_B_KEY` against stg-a and stg-b.
- [ ] **Step 5: Commit** `test(xt): sign-in negative cases for the cross-tenant suite`.

### Task 14: Test hooks for P5 (agreed with Platform)

**Files:**
- Create: `apps/server/src/test-hooks/index.ts` (`mountTestHooks(app)`, `testHooksOn(env)`); uses `TEST_HOOKS_ALLOWED`, `TEST_HOOKS` paths and the `TestSessionInputSchema`, `OtpLatestInputSchema`, `OAuthClientHookResultSchema`, `HealthzSchema` types from `@oa/shared` (#359 `hosted/test-hooks.ts`)
- Modify: `apps/server/vitest.config.ts` (and the cpu/smoke vitest configs) `define: { __OA_TEST_HOOKS_ALLOWED__: "true" }`; `wrangler.staging.jsonc` and `wrangler.test.jsonc` `define` the same. `wrangler.template.jsonc` (the release build) defines it as `false` explicitly (#359); prod is built separately and the staging bundle is never promoted. `scripts/ci/` release job (check below)
- Modify: `apps/server/src/app.ts` (mount before `session()`; `__test` in `WORKER_PREFIX`; `/healthz` adds `testHooks`), `apps/server/src/env.ts`, `apps/server/src/auth/codes.ts` (plaintext copy only while hooks are on), `apps/server/src/auth/audit.ts`
- Test: `apps/server/test/test-hooks.test.ts`, `apps/server/test/skeleton.test.ts`

**Interfaces:**
- **Build-time guard:** `mountTestHooks` registers nothing unless `TEST_HOOKS_ALLOWED` (#359: true only when the bundler defines `__OA_TEST_HOOKS_ALLOWED__` as true). Release CI builds the release bundle (`wrangler deploy --dry-run --outdir dist`), runs it under Miniflare with `TEST_HOOKS=1` and a 32-char key, and fails unless every `TEST_HOOKS` path is 404. (A string grep isn't reliable: the `typeof` check over an undefined global isn't constant-folded, and `TEST_HOOKS` path strings live in `@oa/shared`.) Only stg-a and stg-b deploy a build with the define.
- `testHooksOn(env)` ⇔ `TEST_HOOKS_ALLOWED` and `TEST_HOOKS === "1"` and `TEST_HOOK_KEY` is a string of ≥ 32 chars. Otherwise every method on `/__test/*` → the standard 404 before any auth, D1 or KV access.
- Auth: `Authorization: Bearer <key>` compared with `timingSafeEqual` over SHA-256 digests; wrong or missing → the identical 404. App host only.
- RL_ANON key `test:${installKey}:${ip}`; over → 404. One `test_hook.*` event per call; never the key, code, cookie or token.
- `POST TEST_HOOKS.session` `TestSessionInputSchema` `{ email, role, spaces? }` → `TestSessionResultSchema` `{ cookie }` (`spaces` is forwarded to P3's `applyTestSpaceRoles(env, userId, spaces)`; P2 lands a stub that 400s when `spaces` is sent before P3 exists): real `__Host-oa_session` (`p: "test"`), user created or updated (`upsertWithRole`).
- `POST TEST_HOOKS.otpLatest` `OtpLatestInputSchema` → `OtpLatestResultSchema` or 404. While hooks are on, `deliverCode` also puts the plaintext in `OAUTH_KV` at `test:otp:<installKey>:<emailKey>` (`expirationTtl: 600`; the email part is the HMAC key, not plaintext); successful verify deletes it. No new namespace; only get, put with TTL, delete and prefix list.
- `POST TEST_HOOKS.oauthClient` → `OAuthClientHookResultSchema` through the real MCP OAuth provider (`mcp/oauth-api.ts` helpers).

- [ ] **Step 1: Write the failing tests**

```ts
const H = { TEST_HOOKS: "1", TEST_HOOK_KEY: "k".repeat(32) };
const hook = (e: Env, path: string, body: unknown, key?: string, host = "app.localhost") =>
  fetchAndWait(app, new Request(`http://${host}/__test/${path}`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } }), e);
const off404 = async () => hook(env, "session", {}, undefined);
test("off: every method and path is the standard 404", async () => {
  for (const m of ["GET", "POST", "PUT", "DELETE"]) for (const p of ["session", "otp/latest", "oauth-client", "x"]) {
    const r = await fetchAndWait(app, new Request(`http://app.localhost/__test/${p}`, { method: m }));
    expect(r.status).toBe(404); expect(await errOf(r)).toEqual({ code: "not_found", message: "Not found" });
  }
});
test("on with a 31-char key is still off", async () =>
  expect((await hook({ ...env, TEST_HOOKS: "1", TEST_HOOK_KEY: "k".repeat(31) } as Env, "session", {}, "k".repeat(31))).status).toBe(404));
test("wrong and missing key give the identical 404", async () => {
  const ref = await off404(); const e = { ...env, ...H } as Env;
  for (const r of [await hook(e, "session", {}, "x".repeat(32)), await hook(e, "session", {})]) {
    expect(r.status).toBe(ref.status); expect([...r.headers]).toEqual([...ref.headers]); expect(await r.text()).toBe(await ref.clone().text());
  }
});
test("content host is 404 even with the key", async () =>
  expect((await hook({ ...env, ...H } as Env, "session", { email: "a@a.com", role: "member" }, H.TEST_HOOK_KEY, "content.localhost")).status).toBe(404));
test("off: no D1 or KV access", async () => {
  const d = vi.spyOn(env.DB, "prepare"); const k = vi.spyOn(env.OAUTH_KV, "get"); await off404();
  expect(d).not.toHaveBeenCalled(); expect(k).not.toHaveBeenCalled();
});
test("session hook cookie authenticates as that role; me.auth.method is test", async () => {
  const { cookie } = await (await hook({ ...env, ...H } as Env, "session", { email: "a@a.com", role: "admin" }, H.TEST_HOOK_KEY)).json();
  const me = await (await api(app, "/api/v1/me", `${sessionCookieName(env)}=${cookie}`)).json();
  expect(me.user.role).toBe("admin"); expect(me.auth.method).toBe("test");
});
test("otp hook returns the code just sent; it verifies; then the hook 404s", async () => { /* direct env + H */ });
test("off: a full code flow writes no plaintext anywhere", async () => {
  const puts = vi.spyOn(env.OAUTH_KV, "put"); const binds = spyAllD1Binds(env);
  await fullCodeFlow(direct(), "g@x.com");
  const code = mail.codeFor("g@x.com");
  expect(puts).not.toHaveBeenCalled(); expect(binds().join("|")).not.toContain(code); expect(binds().join("|")).not.toContain("g@x.com");
});
test("oauth-client token works on /mcp and is revocable", async () => { /* revokeAllGrants → 401 */ });
test("build guard: with TEST_HOOKS_ALLOWED false, env var and key do nothing", async () => {
  vi.doMock("@oa/shared", async (orig) => ({ ...(await orig<object>()), TEST_HOOKS_ALLOWED: false }));
  const { createApp: mk } = await import("../src/app.js");
  const r = await fetchAndWait(mk(), new Request("http://app.localhost/__test/session", { method: "POST",
    headers: { authorization: `Bearer ${H.TEST_HOOK_KEY}` } }), { ...env, ...H } as Env);
  expect(r.status).toBe(404);
});
test("release bundle: hooks are 404 even with TEST_HOOKS=1 and a key", async () => { /* scripts/ci/check-no-test-hooks.test.ts: build without the define, run under Miniflare, hit every TEST_HOOKS path */ });
test("/healthz includes testHooks", async () =>
  expect(await (await fetchAndWait(app, new Request("http://app.localhost/healthz"))).json()).toMatchObject({ testHooks: false }));
```

- [ ] **Step 2: Run** `pnpm -C apps/server vitest run test/test-hooks.test.ts test/skeleton.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus `test/codes.test.ts test/code-routes.test.ts test/mcp.auth.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(test-hooks): gated hooks for the cross-tenant suite`.

---

## Rollout and migration

1. **Dark ship** Tasks 1 to 10 and 14 (hooks off): `AUTH_PROVIDERS` unset everywhere; 0008 is additive; derived-key cookies start, legacy cookies accepted until `LEGACY_KEY_UNTIL`.
2. **P1 spike** confirms Rate Limiting bindings in WfP user Workers (H5).
3. **Staging** stg-a and stg-b: direct, broker transport, hooks on; e2e plus the negative catalog live.
4. **artifacts.leourbina.com** switches to direct; users link by email on first Google sign-in; Access app kept one release (**needs user**).
5. **Independent security review** of P2 (codes, broker, hooks) passes. **Gate for FinQore.**
6. **FinQore**: domain proven by DNS TXT and Google sign-in; broker transport; `AUTH_DOMAIN_JOIN=member`; codes for guests only; guests read-only (automatic with direct sign-in).
7. **Self-hosters**: release notes; default stays Access; direct defaults to `invite`.
8. **Follow-up PR** after `LEGACY_KEY_UNTIL`: remove the legacy-key fallback.

Rollback: `oa:setup --auth access` (vars only).

## Needs user

1. Pick the hosted domain.
2. Create **two Google Cloud projects, staging and prod** (not one project with a staging client). In each, a multi-tenant sign-in client with basic scopes. Redirects: staging `https://auth.open-artifacts-staging.app/google/callback`, prod `https://auth.open-artifacts.app/google/callback`.
3. Consent screen per project. **Staging** stays in Testing mode with the test users listed, so it needs no verification. **Prod** gets brand verification (name, logo, homepage, privacy and terms URLs; domain proven in Search Console).
4. In each project, a **separate Directory API client** for P3's scopes, so sign-in stays on basic scopes (D5).
5. DNS: `auth.<hosted>`, the Search Console TXT record, Email Service SPF/DKIM/DMARC.
6. **Turnstile widget** for the hosted domain (site key and secret) for domain codes (D2).
7. **Public Suffix List submission** for the hosted domain and the content domain (M4).
8. FinQore: their domain list, their IT admin adding the `_oa-verify` TXT record, and allowing third-party apps with basic scopes.
9. Two test Google Workspace or Cloud Identity tenants and a readable inbox for the cross-tenant suite.
10. Switch artifacts.leourbina.com to direct; later delete its Access app.

## Open questions

None blocking. Decisions D1 to D7 are recorded above.

## Contract changes (applied in #359 at `ed1105c`)

1. `SessionPayload.t?: string`: the verified Google `hd`, or the email domain of a domain-code session.
2. `TestSessionResultSchema`: a real session with `p: "test"`.
3. Verify lock 429 is `{ retryAfter, scope: "ip" }`.
4. Guest cap: one source, `authConfig.guestsReadOnly`, true whenever `google` or `email` is enabled; `guests_read_only` is reported only, and `parseFeatures` drops it from `FEATURES`.
5. Every refused redirect sign-in, `no_access` included, lands on `SIGN_IN_PAGE?error=…`, never `PAGES.noAccess`.
6. The release template defines `__OA_TEST_HOOKS_ALLOWED__` as `false` explicitly; the release check stays behavioural.
