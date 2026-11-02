# Track B — Backend (owner: OpenArtifacts Backend)

Read `00-overview.md` (Global Constraints, Review Focus) and `01-foundation.md` (the contract) first.

All server code lives in `apps/server/src/`, and tests live in `apps/server/test/`. The commands are:
- Run the tests: `pnpm --filter @oa/server vitest run <file>`
These steps repeat in every task and aren't restated: run the failing test, then run it again to see it pass.

**Shipping:** every task ships through its own PR and the full *Delivery* flow in the overview: branch, PR, CI, squash-merge, staging deploy, staging smoke. Where a task says "Commit with `<msg>`", that `<msg>` is the PR title, with ` (<task id>)` appended. A task is done only once its change is live on staging.

**Staging smoke tests.** Each task adds the smoke checks its feature needs to `apps/server/test/smoke/`. They run against staging after every deploy, unauthenticated at first, then with a PAT for the staging owner (secret `STAGING_OWNER_PAT`) once B3 lands. Examples:
- B4 asserts that `/auth/login` redirects to the staging team domain.
- B6 publishes and reads back.
- B10 fetches a signed content URL and checks the CSP header.
- B14 runs MCP `tools/list`.

**Server module map:** decide responsibilities once, here.

```
src/
  index.ts              # Worker entry: host dispatch → content app | PAT-MCP | OAuthProvider(app)
  env.ts                # Env interface (bindings + vars + secrets)
  app.ts                # Hono app for the app host: middleware, route mounting, SPA fallback
  http/errors.ts        # ApiError class, toResponse(), D1-quota detection
  http/middleware.ts    # securityHeaders, csrf, session → c.var.user, rateLimitAnon
  db/schema.ts          # Drizzle tables
  db/client.ts          # getDb(env)
  auth/session.ts       # signSession / readSession (HMAC cookie)
  auth/oidc.ts          # Access OIDC login: authorize URL, PKCE, callback, id_token verify
  auth/pat.ts           # createPat, verifyPat
  auth/authz.ts         # accessLevel(), requireAccess()
  services/artifacts.ts # publish, list, get, patch, delete, undelete, restoreVersion, purge
  services/manifest.ts  # validateFiles, writeInlineFiles, resolveUploads
  services/uploads.ts   # createUpload, putUpload, sweepUploads
  services/search.ts    # extractText, indexVersion, search
  services/shares.ts    # list/put/delete shares
  services/members.ts   # list/invite/patch/remove members, settings
  services/usage.ts     # GraphQL analytics fetch + cache
  routes/*.ts           # one file per R.* group
  content/app.ts        # content-host Hono app
  content/signing.ts    # signContentPath / verifyContentPath
  content/inject.ts     # HTMLRewriter: runtime <script> injection
  runtime/do.ts         # ArtifactRuntime Durable Object
  runtime/routes.ts     # /data, /storage, /data-subscribe → DO
  mcp/server.ts         # createServer(ctx) → McpServer with tools
  mcp/tools/*.ts        # one file per tool group
  mcp/oauth.ts          # OAuthProvider config + /oauth/authorize consent handler
  cron.ts               # scheduled(): purge deleted, sweep uploads
```

---

### Task B1: Worker skeleton, env, errors, security headers

**Files:** Create `src/index.ts`, `src/env.ts`, `src/app.ts`, `src/http/errors.ts`, and `src/http/middleware.ts` (securityHeaders only), plus `apps/server/wrangler.template.jsonc`. Tests: `test/skeleton.test.ts` and `test/errors.test.ts`.

**Interfaces:**
- Produces:
```ts
// env.ts
export interface Env {
  DB: D1Database; FILES: R2Bucket; OAUTH_KV: KVNamespace; ARTIFACT_RUNTIME: DurableObjectNamespace<ArtifactRuntime>;
  ASSETS: Fetcher; RL_ANON: RateLimit;
  APP_HOST: string; CONTENT_HOST: string; OWNER_EMAIL: string; ENVIRONMENT: "dev" | "production";
  ACCESS_TEAM_DOMAIN: string; ACCESS_CLIENT_ID: string;            // vars
  ACCESS_CLIENT_SECRET: string; SESSION_SECRET: string; CONTENT_SIGNING_KEY: string; ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID: string; // secrets
}
// http/errors.ts
export class ApiError extends Error { constructor(public code: ErrorCode, message: string, public details?: unknown) }
export function toErrorResponse(e: unknown): Response;   // ApiError → STATUS_FOR[code] JSON; D1 quota error → 503 quota_exceeded QUOTA_MESSAGE; else 500 internal (no stack in body)
export function isD1QuotaError(e: unknown): boolean;     // message includes "exceeded D1's free tier daily"
export function appOrigin(env: Env): string;             // "https://" + APP_HOST, or "http://" + APP_HOST when ENVIRONMENT === "dev"
```
- `index.ts` default export is `{ fetch, scheduled }`. `fetch` dispatches on `new URL(req.url).host`:
  - `CONTENT_HOST` goes to `contentApp`, a stub that returns 404 until B10.
  - Anything else goes to the app handler.
- `wrangler.template.jsonc` contains the bindings above, with `"compatibility_flags": ["nodejs_compat"]`, assets `{ directory: "../dashboard/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true }`, `ratelimits: [{ name: "RL_ANON", namespace_id: "1001", simple: { limit: 30, period: 60 } }]`, `triggers.crons: ["17 3 * * *"]`, and `durable_objects` plus `migrations: [{ tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] }]`. Placeholders look like `{{D1_ID}}` and are filled in by setup in B16.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `skeleton.test.ts`:
    - `GET /healthz` on the app host → 200 `{ ok: true }`.
    - `GET /robots.txt` on both hosts → `User-agent: *\nDisallow: /`.
    - Every response has `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.
    - App-host HTML responses have `X-Frame-Options: DENY`.
  - `errors.test.ts`, which covers **Review Focus #4**:
    - A route that throws `new Error("Your account has exceeded D1's free tier daily row read limit…")` → 503, `{ error: { code: "quota_exceeded", message: QUOTA_MESSAGE } }`.
    - Throwing `new ApiError("not_found","x")` → 404.
    - A generic `Error` → 500 with `code: "internal"`, and the body doesn't contain the stack.
- [ ] **Step 2: Implement.**
  - The Hono app uses `onError(toErrorResponse)`.
  - `securityHeaders` middleware is applied to both apps.

---

### Task B2: D1 schema and migrations

**Files:** Create `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, and `migrations/0001_init.sql` (generated, then FTS hand-appended). Test: `test/db.test.ts`.

**Interfaces:**
- Produces these Drizzle tables. Timestamps are integer milliseconds, and JSON lives in text columns.
```
users(id pk, email text unique not null collate nocase, name, role text not null check in roles, created_at, last_seen_at)
artifacts(id pk, owner_id → users, title, description, format, visibility, current_version int not null default 0,
          capabilities text json not null default '{"db":false,"viewer":false,"storage":false}', allow_anonymous_writes int default 0,
          has_thumbnail int default 0, last_agent_name, last_agent_version, created_at, updated_at, deleted_at null)
          index(owner_id, updated_at), index(visibility, updated_at), index(deleted_at)
versions(artifact_id → artifacts, version int, entry, manifest text json not null /* [{path,key,size,contentType}] */, language,
         message, agent_name, agent_version, created_by → users, created_at, text_indexed int default 0, primary key(artifact_id, version))
shares(artifact_id, email collate nocase, role, created_by, created_at, primary key(artifact_id, email)) index(email)
tokens(id pk, user_id, label, token_hash unique, created_at, last_used_at, revoked_at)
uploads(id pk, artifact_id, user_id, r2_key, size, content_type, path, created_at, consumed int default 0)
reserved_artifacts(id pk, user_id, created_at)     -- ids handed out by create_upload before the first publish
settings(key pk, value text)                       -- "name", "default_visibility"
-- hand-appended:
CREATE VIRTUAL TABLE artifact_search USING fts5(artifact_id UNINDEXED, title, description, body, tokenize='porter unicode61');
```
- `getDb(env): DrizzleD1Database<typeof schema>`

**Steps:**

- [ ] **Step 1: Write the failing test.** In `db.test.ts`:
  - After the migrations run, insert a user and an artifact.
  - Inserting a duplicate email in different case (`A@x.com` and `a@x.com`) throws a UNIQUE error.
  - `artifact_search MATCH 'hello'` finds a row inserted with body "hello world".
- [ ] **Step 2: Implement and generate the migration.**
  - Run `pnpm --filter @oa/server drizzle-kit generate`, then append the FTS statement.

---

### Task B3: Crypto utilities, sessions, PATs

**Files:** Create `src/auth/session.ts`, `src/auth/pat.ts`, and `src/util/crypto.ts`. Tests: `test/session.test.ts` and `test/pat.test.ts`.

**Interfaces:**
```ts
// util/crypto.ts
export async function hmacSign(key: string, data: string): Promise<string>;      // base64url HMAC-SHA256
export async function hmacVerify(key: string, data: string, sig: string): Promise<boolean>; // constant-time
export async function sha256Hex(s: string): Promise<string>;
// auth/session.ts
export type Session = { uid: string; exp: number };
export async function signSession(env: Env, uid: string, now?: number): Promise<string>;   // cookie value "<b64url(json)>.<sig>", exp = now + 7d
export async function readSession(env: Env, cookieValue: string | undefined, now?: number): Promise<Session | null>;
export function sessionCookieName(env: Env): string;   // "__Host-oa_session" (plain "oa_session" when ENVIRONMENT=dev)
export function sessionCookie(value: string, env: Env): string;   // "__Host-oa_session=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800", no Domain (dev: "oa_session=…", Secure omitted)
// auth/pat.ts
export async function createPat(env: Env, userId: string, label: string): Promise<{ id: string; token: string }>;
export async function verifyPat(env: Env, token: string): Promise<{ userId: string; tokenId: string; label: string } | null>; // rejects revoked; updates last_used_at at most once per hour (via waitUntil)
```

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - A session round-trips.
  - A session is rejected when it's expired, when one byte of the payload is tampered with, or when it was signed with a different secret.
  - The cookie string matches the exact format above.
  - `createPat` stores only the hash: no column in the DB row equals the token.
  - `verifyPat` returns `null` after revoke and for a malformed token.
- [ ] **Step 2: Implement.**
  - Use `crypto.subtle` only, with no Node crypto.

---

### Task B4: Access OIDC login, dev login, users

**Files:** Create `src/auth/oidc.ts`, `src/routes/auth.ts`, `src/http/middleware.ts` (add `session`), and `src/services/users.ts`. Tests: `test/oidc.test.ts` and `test/devlogin.test.ts`. Also replace the stub in `test/helpers.ts` with the real `login()`.

**Interfaces:**
```ts
// auth/oidc.ts
export function accessIssuer(env: Env): string;   // `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${ACCESS_CLIENT_ID}`
export async function buildAuthorizeRedirect(env: Env, next: string): Promise<{ location: string; stateCookie: string }>; // PKCE S256, state+nonce+verifier in a signed 10-min "oa_oidc" cookie
export async function handleCallback(env: Env, req: Request): Promise<{ email: string; name: string | null }>; // exchange code at /token, verify id_token with jose createRemoteJWKSet(issuer + "/jwks"), check iss/aud/nonce
// services/users.ts
export async function upsertOnLogin(env: Env, email: string, name: string | null): Promise<Member | null>;
//   email === OWNER_EMAIL (case-insensitive) → role owner (create or promote)
//   existing user row (invited member/admin) → update name, last_seen_at
//   no row but ≥1 share for this email → create role guest
//   otherwise → null (caller renders no-access page; no row created)
export async function getUser(env: Env, id: string): Promise<Member | null>;
```
- **Routes:**
  - `GET /auth/login?next=/path` → 302 to the Access authorize endpoint. `next` must be a same-origin path, otherwise it's replaced with `/`.
  - `GET /auth/callback` → sets `__Host-oa_session` (plain `oa_session` in dev), then 302 to `next`. If `upsertOnLogin` returns `null`, it responds 302 `/no-access` instead.
  - `POST /auth/logout` clears the cookie.
  - `GET /auth/dev-login?email=&role=` works **only** when `ENVIRONMENT === "dev"`. Otherwise it returns 404. It upserts the user with the given role and sets the session.
- **Middleware:** `session` sets `c.var.user: Member | null`. It reads the cookie and loads the user; deleted users count as `null`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `oidc.test.ts` uses a local fake OIDC issuer, a Hono app served through `fetchMock`, and an RSA key generated with jose.
    - A valid code flow logs in `owner@x.com` as owner when `OWNER_EMAIL` is that address.
    - A wrong `nonce` is rejected (401). So are a wrong `aud`, an expired token, and a missing or forged state cookie.
    - `next=https://evil.com` redirects to `/`.
    - An unknown email with no shares → `/no-access`, and no user row exists.
    - An unknown email with a share → a guest row is created.
  - `devlogin.test.ts`: with `ENVIRONMENT="production"`, `/auth/dev-login` → 404. With `"dev"`, it → 302 and sets the cookie.
- [ ] **Step 2: Implement.**

---

**B4 staging step (owner: OpenArtifacts Platform; Backend asks for it before merging B4):**
- Create the staging Access for SaaS OIDC app. It uses the same API calls as B16's `access` step, run from `docs/ops/staging.md`, with the redirect `https://staging.open-artifacts.com/auth/callback`.
- Set the staging secrets with `wrangler secret put --env staging`: `ACCESS_CLIENT_SECRET`, `SESSION_SECRET`, and `CONTENT_SIGNING_KEY`.
- Set the staging vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_CLIENT_ID`, and `OWNER_EMAIL=<the owner's address>`.
- Record the ids (never the secrets) in `docs/ops/staging.md`.

---

### Task B5: Authorization, members, settings, CSRF

**Files:** Create `src/auth/authz.ts`, `src/services/members.ts`, `src/routes/me.ts`, `src/routes/members.ts`, and `src/routes/settings.ts`, and add `csrf` to `src/http/middleware.ts`. Tests: `test/authz.matrix.test.ts`, `test/members.test.ts`, and `test/csrf.test.ts`.

**Interfaces:**
```ts
// auth/authz.ts
export type Caller = { kind: "user"; user: Member } | { kind: "anonymous" };
export async function accessLevel(env: Env, caller: Caller, artifactId: string): Promise<{ level: AccessLevel; artifact: ArtifactRow } | null>;
export async function requireAccess(env: Env, caller: Caller, artifactId: string, min: "viewer" | "editor" | "owner"): Promise<ArtifactRow>; // throws ApiError("not_found") — never forbidden
export function listFilterSql(caller: Caller, scope: ListQuery["scope"]): SQL;  // Drizzle SQL fragment used by list and search
```
- **Rules (spec §6.5, revision 2), checked in this order:**
  1. A deleted artifact → `null`, unless the caller is the creator **and** the call is undelete or list with `includeDeleted`.
  2. The creator → `owner`.
  3. A share for the caller's email → `share.role`.
  4. A `team` artifact with a caller whose role is owner, admin, or member → `viewer`.
  5. A `public` artifact → `viewer`, for any caller including anonymous.
  6. Otherwise → `null`.
- **Admins** get no implicit access to private artifacts.
- **Members API** (owner and admin only; others get 404 on these routes):
  - `GET` lists members.
  - `POST {email, role: "admin"|"member"}` pre-creates the user row.
  - `PATCH {role}`. The owner can't be demoted, and an admin can't promote anyone to owner.
  - `DELETE` removes the user row. Their artifacts are reassigned to the owner and their shares are kept.
- **`GET /api/v1/me`** returns `Me`, or 401 for anonymous callers.
- **Settings:** `GET` is open to any member. `PATCH` is owner and admin only.
- **CSRF middleware:** a non-GET `/api/v1/*` request with a session cookie and without `X-OA-Request: 1` → 403 `csrf`. Bearer-PAT requests are exempt.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `authz.matrix.test.ts` is a table-driven test that covers **Review Focus #3**.
    - Callers: owner, admin, member, guest-with-share, guest-without-share, and anonymous.
    - Artifacts: private, team, public, private-shared-viewer, private-shared-editor, and deleted.
    - Each cell asserts the exact level or `null`.
    - It also checks: after unsharing, the guest gets `null`. After a member is removed, their next request is anonymous. Email matching ignores case.
  - `members.test.ts`:
    - A member calling `GET /members` → 404.
    - An admin demoting the owner → 400.
    - Deleting a member reassigns their artifacts to the owner.
  - `csrf.test.ts`:
    - A cookie POST without the header → 403 `csrf`.
    - With the header → it passes.
    - A PAT POST without the header → it passes.
- [ ] **Step 2: Implement.**

---

### Task B6: Manifest, inline files, uploads, and publish

**Files:** Create `src/services/manifest.ts`, `src/services/uploads.ts`, `src/services/artifacts.ts` (the `publish` part), and `src/routes/uploads.ts`. Tests: `test/publish.test.ts`, `test/publish.paths.test.ts`, `test/publish.concurrency.test.ts`, and `test/uploads.test.ts`.

**Interfaces:**
```ts
// services/manifest.ts
export type ManifestEntry = { path: string; key: string; size: number; contentType: string };
export function planFiles(input: PublishInput): { files: Array<{ path: string; source: { text: string } | { base64: string } | { uploadId: string } }>; entry: string; format: Format; language: string | null };
//   content → single file at entry ?? defaultEntry(format) ("index.html" | "README.md" | "document.pdf" | `main.${ext(language)}`)
//   normalizes every path (normalizePath), rejects case collisions, entry ∉ files, > LIMITS.filesPerVersion files, inline bytes > LIMITS.inlineBytes → ApiError("bad_request"|"too_large", message naming the path)
export async function materialize(env: Env, artifactId: string, userId: string, plan: ReturnType<typeof planFiles>, prev: ManifestEntry[] | null): Promise<ManifestEntry[]>;
//   inline → R2 put at files/{artifactId}/{newId()}; uploadId → must belong to (artifactId, userId), unconsumed, path match → reuse its r2_key, mark consumed
// services/uploads.ts
export async function createUpload(env: Env, user: Member, input: UploadCreateInput): Promise<UploadCreated>;
//   artifactId absent → reserve newId() in reserved_artifacts; present → requireAccess(editor); size ≤ LIMITS.fileBytes
//   url = `${appOrigin}/api/v1/uploads/${uploadId}?exp=…&sig=hmac(CONTENT_SIGNING_KEY, uploadId:exp)` , exp = now + 1h
export async function putUpload(env: Env, uploadId: string, exp: string, sig: string, req: Request): Promise<void>;
//   verify sig/exp; Content-Length must equal declared size; FILES.put(key, req.body) streaming (no buffering)
export async function sweepUploads(env: Env, now: number): Promise<number>;   // delete unconsumed uploads older than 24h (row + R2 object) and reserved ids older than 24h without an artifact
// services/artifacts.ts
export async function publish(env: Env, user: Member, input: PublishInput, agent: AgentRef | null): Promise<PublishResult>;
```
- **How `publish` works:**
  - **Create:** `id` is absent, or is a reserved id belonging to this user. It inserts the artifact row with visibility `input.visibility ?? settings.default_visibility`.
  - **Update:** `requireAccess(editor)`. Only the owner may change `visibility`, `capabilities`, or `allowAnonymousWrites`. An editor attempting it gets `bad_request "only the owner can change sharing"`.
  - **Version allocation is race-safe** (**Review Focus #5**). It uses a single D1 batch:
    ```sql
    UPDATE artifacts SET current_version = current_version + 1, updated_at=?, last_agent_name=?, last_agent_version=? WHERE id=? RETURNING current_version
    ```
    followed by an insert into `versions`.
  - **Search:** calls `indexVersion` (from B8) through `ctx.waitUntil`.
  - Returns `url = appOrigin + viewerPath(id)`.
- **Routes:**
  - `POST R.artifacts`: JSON `PublishInput`, with an `id` only if it's a reserved id.
  - `POST R.versions(id)`.
  - `POST R.uploads`.
  - `PUT R.upload(uploadId)`. This route is exempt from session and CSRF because the signature authorizes it.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `publish.test.ts`:
    - Publishing markdown `content` creates version 1, and R2 holds the bytes.
    - A second publish creates version 2 whose manifest holds the new key.
    - `lastAgent` equals the passed `AgentRef`.
    - An editor publishing works. An editor changing visibility → 400.
    - A viewer publishing → 404.
  - `publish.paths.test.ts`, **Review Focus #2**: each hostile path from F2 → 400 with `details.path` set, and `FILES.list()` stays empty afterward. Also:
    - case-only duplicates → 400
    - an entry that's missing → 400
    - 1,001 files → 400
    - 128 KB + 1 byte inline → 413 `too_large` (256 KB before be/inline-128k)
  - `publish.concurrency.test.ts`: `Promise.all` of 5 publishes to one artifact → versions `{2,3,4,5,6}`, `current_version === 6`, and 5 rows in `versions`.
  - `uploads.test.ts`:
    - `create_upload` → PUT 3 bytes with the right length → publish with `{ uploadId }` → the manifest reuses the key.
    - A wrong sig → 404. Expired → 404. A length mismatch → 400.
    - Reusing a consumed upload → 400.
    - Another user's upload → 400.
    - `sweepUploads` deletes stale uploads and keeps fresh ones.
- [ ] **Step 2: Implement.**

---

### Task B7: Artifact read, list, patch, delete, versions, restore, cron purge

**Files:** Create the rest of `src/services/artifacts.ts`, plus `src/routes/artifacts.ts` and `src/cron.ts`. Tests: `test/artifacts.api.test.ts` and `test/cron.test.ts`.

**Interfaces:**
```ts
export async function getSummary(env: Env, caller: Caller, id: string): Promise<ArtifactSummary>;
export async function list(env: Env, caller: Caller, q: ListQuery): Promise<Page<ArtifactSummary>>;  // keyset cursor on (updated_at, id) desc, cursor = b64url JSON
export async function listVersions(env: Env, caller: Caller, id: string): Promise<VersionInfo[]>;    // newest first
export async function readVersionFile(env: Env, caller: Caller, id: string, v: number, path: string): Promise<R2ObjectBody>; // viewer+
export async function patch(env: Env, user: Member, id: string, p: ArtifactPatch): Promise<ArtifactSummary>; // title/description editor+; others owner-only
export async function softDelete(env: Env, user: Member, id: string): Promise<void>;   // owner-only, sets deleted_at, removes artifact_search row
export async function undelete(env: Env, user: Member, id: string): Promise<ArtifactSummary>; // owner-only, within 30d, re-index current version
export async function restoreVersion(env: Env, user: Member, id: string, v: number, agent: AgentRef | null): Promise<PublishResult>; // editor+; copies manifest/entry/language as new version, message "Restored v{v}"
export async function purgeDeleted(env: Env, now: number): Promise<number>; // deleted_at < now-30d → delete R2 prefix files/{id}/, thumbs/{id}.webp, rows, DO storage (stub.destroy())
```
- **Scopes for `list`:**
  - `mine`: the caller is the owner.
  - `shared`: the caller has a share row.
  - `team`: visibility is team and the caller is a member or higher.
  - `all`: the union of those.
  - Anonymous callers → 401.
- **`thumbnailUrl`:** `R.thumbnail(id)` when `has_thumbnail` is set, otherwise `null`. A GET on it serves the image to callers with viewer access.
- **Cron:** `scheduled` runs `purgeDeleted` and `sweepUploads`, wrapped in `ctx.waitUntil`. Each run is capped at 50 artifacts so it fits the budget.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `artifacts.api.test.ts`:
    - Pagination: 30 items, then `limit=25` → 25 items plus a cursor, then 5 more.
    - A guest's `scope=all` lists only the artifacts shared with them.
    - Restore v1 → v3 has v1's manifest.
    - An editor deleting → 404. The owner deleting → the artifact disappears from the list. `includeDeleted` shows it. Undelete restores it.
    - `PATCH` with an unknown field → 400.
  - `cron.test.ts`: an artifact deleted 31 days ago is purged, with its R2 keys gone. One deleted 29 days ago is kept.
- [ ] **Step 2: Implement.**

---

### Task B8: Search and text extraction

**Files:** Create `src/services/search.ts`, `src/routes/search.ts`, and the `versionText` route in `src/routes/artifacts.ts`. Tests: `test/search.test.ts` and `test/search.authz.test.ts`.

**Interfaces:**
```ts
export async function extractText(format: Format, body: ReadableStream | string): Promise<string>;
//   html: HTMLRewriter text handler, skip <script>/<style>, collapse whitespace
//   markdown/code: raw text
//   pdf: "" (browser extracts)
//   capped at LIMITS.searchBodyChars
export async function indexVersion(env: Env, artifactId: string, version: number): Promise<void>; // reads entry from R2; replaces artifact_search row; sets text_indexed=1 for non-pdf
export async function putExtractedText(env: Env, caller: Caller, id: string, v: number, text: string): Promise<void>; // viewer+ (any viewer may contribute), only if version is pdf && text_indexed=0 && v === current_version; ≤ LIMITS.extractedTextBytes
export async function search(env: Env, caller: Caller, q: string, cursor?: string, limit?: number): Promise<Page<SearchHit>>;
//   FTS MATCH with user input escaped as quoted phrase tokens; JOIN artifacts with listFilterSql(caller,"all"); snippet(artifact_search, 3, '[', ']', '…', 12); order by bm25
```

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `search.test.ts`:
    - Publishing HTML `<script>secret()</script><p>quarterly plan</p>` → searching "quarterly" finds it, and searching "secret" doesn't.
    - Searching a query like `"foo* OR bar"` with FTS syntax doesn't throw.
    - A PDF is only findable after `PUT versionText`. A second PUT is ignored.
  - `search.authz.test.ts`, **Review Focus #3**: the guest's search never returns artifacts that aren't shared with them, and returns none after unshare. Deleted artifacts never appear in results.
- [ ] **Step 2: Implement.**

---

### Task B9: Sharing

**Files:** Create `src/services/shares.ts` and `src/routes/shares.ts`. Test: `test/shares.test.ts`.

**Interfaces:**
```ts
export async function listShares(env: Env, user: Member, id: string): Promise<Share[]>;   // owner-only
export async function putShare(env: Env, user: Member, id: string, s: { email: string; role: ShareRole }): Promise<Share>; // owner-only; email lowercased; owner's own email → 400
export async function deleteShare(env: Env, user: Member, id: string, email: string): Promise<void>;
```
- Sharing with an email that has no user row is allowed. That person becomes a guest when they first log in (B4).
- **Visibility** changes go through `PATCH` from B7.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - Share as viewer → the guest can get the artifact. Upgrade to editor → the guest can publish. Delete → 404.
  - A non-owner calling `listShares` → 404.
  - `Bob@X.com` and `bob@x.com` are the same share.
- [ ] **Step 2: Implement.**

---

### Task B10: Content host — signed paths, serving, sandbox, injection

**Files:** Create `src/content/app.ts`, `src/content/signing.ts`, `src/content/inject.ts`, and the content-URL route in `src/routes/artifacts.ts`. Tests: `test/content-host.test.ts` and `test/content-host.sandbox.test.ts`.

**Interfaces:**
```ts
// content/signing.ts
export async function signContentPrefix(env: Env, id: string, v: number, now?: number): Promise<string>; // "/c/{exp}.{sig}/{id}/v{v}/"   sig = hmac(CONTENT_SIGNING_KEY, `${id}:${v}:${exp}`), exp = now + 600s
export async function verifyContentPrefix(env: Env, token: string, id: string, v: number, now?: number): Promise<boolean>;
export function publicPrefix(id: string, v: number): string;  // "/p/{id}/v{v}/"
```
- **`GET R.contentUrl(id, v?)`** requires viewer access.
  - Public artifacts: `{ url: "https://CONTENT_HOST" + publicPrefix + "__view", expiresAt: null }`.
  - Otherwise: the signed prefix + `"__view"`, with `expiresAt`.
- **Content app routes**, on `CONTENT_HOST` only:
  - `GET /c/:token/:id/v:v/*path` and `GET /p/:id/v:v/*path`. The `/p/` form only works while the artifact is `public` and not deleted. Everything else → 404.
  - **`path === "__view"`** returns a format-appropriate HTML page:
    - `html`: the entry file itself, with the runtime injected.
    - `markdown`, `code`, `pdf`: a tiny HTML page that loads `/_oa/render.js` (from B11) with a `<meta name="oa-entry" content="{entry}">`, `<meta name="oa-format">`, and `<meta name="oa-language">`. The renderer fetches the entry relative to the page.
  - **Any other path** streams the R2 object for that manifest path, with its `contentType`. A missing path → 404.
  - **`/_oa/*`** serves the built runtime and render bundles. The Worker imports them as text modules from `packages/runtime/dist` and `packages/render/dist`. They get `Cache-Control: public, max-age=31536000, immutable`, keyed by a content hash in the filename.
- **Headers on every content response:**
  - `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors https://{APP_HOST}`
  - `Cross-Origin-Resource-Policy: cross-origin`
  - No `Set-Cookie`.
  - `Cache-Control: private, max-age=300` for signed paths, and `public, max-age=60` for public ones.
- **Injection:** `injectRuntime(res: Response): Response`, using HTMLRewriter. It prepends `<script src="/_oa/runtime.{hash}.js"></script>` as the first child of `<head>`, creating a head if there isn't one.
- **Version manifest lookup:** one D1 read per request. A small in-isolate LRU of 200 entries keyed by `${id}:${v}` holds the manifest. That's safe because versions never change.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `content-host.test.ts`:
    - A valid signed prefix → the entry is served, and `style.css` resolves under the same prefix.
    - An expired token → 404. A token for v1 used on v2 → 404.
    - `/p/…` for a private artifact → 404. After switching to public → 200. After deleting → 404.
    - The API on the content host (`/api/v1/me`) → 404.
    - The content host never sets cookies on any route.
  - `content-host.sandbox.test.ts`, **Review Focus #1**, server side:
    - Every response has the exact CSP sandbox header without `allow-same-origin`, plus `frame-ancestors` set to the app host.
    - An HTML entry without a `<head>` gets the runtime script injected.
    - An entry that already has `<script>` in its head keeps the runtime first.
    - A `__view` for markdown contains the meta entries and no inline user content.
- [ ] **Step 2: Implement.**

---

### Task B11: `@oa/render` — browser renderers (Markdown, code, PDF)

**Files:** Create `packages/render/src/index.ts`, `markdown.ts`, `code.ts`, `pdf.ts`, `theme.css`, and `vite.config.ts` (library build to `dist/render.[hash].js` plus `manifest.json`). Test: `packages/render/test/render.test.ts`, run with vitest and happy-dom.

**Interfaces:**
- Consumes: `@oa/shared` protocol, `sendToShell` from `@oa/shared`, and Design's D5 render theme, which goes in `theme.css`. Until D5 lands, use a neutral placeholder theme.
- Produces:
  - Its entry reads `meta[name=oa-*]`, fetches the entry, and renders into `document.body`.
  - `export function renderMarkdown(src: string): string;` uses markdown-it with `{ html: false, linkify: true }`, plus GitHub Flavored Markdown tables and task lists. Fenced code goes through Shiki, using dual light and dark themes from D5. A ```` ```mermaid ```` fence is replaced with `<pre class="mermaid">`, and `mermaid` is dynamically imported only when one is present.
  - `export async function renderCode(src: string, language: string): Promise<string>;` renders with Shiki and adds line numbers and a copy button.
  - `export async function renderPdf(url: string, el: HTMLElement): Promise<{ text: string }>;` uses pdf.js with its worker from `/_oa/`. It renders the pages lazily and extracts the text of the first 50 pages. After rendering, it posts `pdf.text` to the shell, and it answers `thumb.request` with page 1 as webp.
  - **Light and dark** follow the theme from the shell's `welcome`/`theme` message, falling back to `prefers-color-scheme`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `renderMarkdown("<script>x</script>\n# T")` contains no `<script` and does contain `<h1`.
  - A ```` ```mermaid ```` fence becomes `<pre class="mermaid">`.
  - `renderCode("const a=1","ts")` contains `class="shiki"` and the line-number markup.
  - The bundle size check: `dist/render.*.js` is under 400 KB gzip, with Mermaid and pdf.js split into lazy chunks.
- [ ] **Step 2: Implement.**
  - Wire `pnpm --filter @oa/render build` into `@oa/server`'s build so the Worker can import the bundle as text.

---

### Task B12: `ArtifactRuntime` Durable Object

**Files:** Create `src/runtime/do.ts`. Test: `test/runtime.do.test.ts`.

**Interfaces:**
```ts
export class ArtifactRuntime extends DurableObject<Env> {
  // RPC (called via stub from Worker); `actor` = viewer key: "u:{userId}" | "ip:{ip}" | "agent:{userId}"
  get(collection: string, id: string): Promise<DataDoc | null>;
  list(collection: string, cursor?: string, limit?: number): Promise<Page<DataDoc>>;
  query(collection: string, q: DataQuery): Promise<Page<DataDoc>>;        // where → json_extract(data,'$.k') = ? (keys must match /^[A-Za-z0-9_]{1,64}$/)
  set(collection: string, id: string, data: unknown, actor: string): Promise<DataDoc>;
  update(collection: string, id: string, patch: Record<string, unknown>, actor: string): Promise<DataDoc>; // shallow merge; missing doc → create
  delete(collection: string, id: string, actor: string): Promise<void>;
  storageGet(viewer: string, key: string): Promise<unknown | null>;
  storageSet(viewer: string, key: string, value: unknown): Promise<void>;
  storageDelete(viewer: string, key: string): Promise<void>;
  storageList(viewer: string): Promise<string[]>;
  fetch(req: Request): Promise<Response>;   // WebSocket upgrade for subscribe; uses ctx.acceptWebSocket(ws, [collection]) (hibernation)
  destroy(): Promise<void>;                 // deleteAll()
}
```
- **SQLite tables:** `docs(collection, id, data, updated_at, updated_by, primary key(collection, id))`, `storage(viewer, key, data, updated_at, primary key(viewer, key))`, and `writes(actor, minute, n, primary key(actor, minute))`.
- **Validation:** collection names and doc ids match `/^[A-Za-z0-9_.-]{1,128}$/`.
- **Limits**, all from `LIMITS`:
  - A serialized doc over 1 MB → `too_large`.
  - A total over 50 MB → `too_large`. Track the total in `meta`.
  - More than 100 writes per minute per actor → `rate_limited`.
- **Broadcast:** after each write, send `{type:"db.change", collection, docs:[doc], deleted:[]}` to every websocket tagged with that collection.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - A set/get/update/delete round trip.
  - `query({ where: { choice: "B" } })` returns only the matching docs.
  - A `where` key like `"a') OR 1=1 --"` → `bad_request`.
  - Doc limits: 1 MB + 1 byte → `too_large`. Write limits: the 101st write in a minute → `rate_limited`. A different actor isn't affected.
  - Two websocket clients on `votes`: client A sets a doc and client B receives `db.change`. A client subscribed to `other` receives nothing.
  - `storageSet` for viewer X isn't visible to viewer Y.
- [ ] **Step 2: Implement.**

---

### Task B13: Runtime REST, websocket route, anonymous rate limit, `@oa/runtime` SDK

**Files:** Create `src/runtime/routes.ts`, `packages/runtime/src/index.ts`, `packages/runtime/src/bridge.ts`, `packages/runtime/src/snapshot.ts`, and `packages/runtime/vite.config.ts`. Tests: `test/runtime.routes.test.ts` and `packages/runtime/test/sdk.test.ts`.

**Interfaces:**
- **Worker routes** (`R.data*`, `R.storage*`, `R.dataSubscribe`):
  - `requireAccess(viewer)`.
  - Then `capability(artifact, METHOD_CAPABILITY[...])` → 403 `capability_denied` when that capability isn't declared. That's the one place a 403 is right, because access was already proven.
  - **Writes:**
    - Signed-in viewers are allowed, with `actor = "u:"+id`.
    - Anonymous callers are allowed only if `allow_anonymous_writes`. They first pass `env.RL_ANON.limit({ key: "ip:"+CF-Connecting-IP })`, otherwise 429, and their `actor = "ip:"+ip`.
    - `storage.*` requires a signed-in user. Anonymous callers → 401.
  - `dataSubscribe` forwards the upgrade to the DO stub `idFromName(artifactId)`.
- **The `window.openArtifacts` SDK** (`@oa/runtime`, built to `dist/runtime.[hash].js`, ≤ 8 KB gzip):
```ts
interface OpenArtifacts {
  ready: Promise<void>;                                 // resolves on "welcome"
  viewer: { get(): Promise<{ email: string; name: string | null } | null> };
  db: { collection(name: string): Collection };
  storage: { get(key: string): Promise<unknown>; set(key: string, v: unknown): Promise<void>; delete(key: string): Promise<void>; list(): Promise<string[]> };
  theme: "light" | "dark"; onTheme(cb: (t: "light" | "dark") => void): () => void;
}
interface Collection {
  get(id: string): Promise<DataDoc | null>; list(opts?: { cursor?: string; limit?: number }): Promise<Page<DataDoc>>;
  query(q: DataQuery): Promise<Page<DataDoc>>; set(id: string, data: unknown): Promise<DataDoc>;
  update(id: string, patch: Record<string, unknown>): Promise<DataDoc>; delete(id: string): Promise<void>;
  subscribe(cb: (e: { docs: DataDoc[]; deleted: string[] }) => void): () => void;
}
```
- **Bridge:**
  - On load, send `hello`.
  - Accept messages only where `event.source === window.parent`. Parse them with `parseShellMessage`.
  - Calls time out after 15 s with `{ code: "internal", message: "shell did not respond" }`.
  - If `window.parent === window`, meaning the raw view, every call rejects with `capability_denied "Open this artifact in Open Artifacts to use live data"`.
- **Snapshot:** on `thumb.request`, dynamically import `/_oa/snapshot.[hash].js` (the html-to-image library), render a 1200×750 webp, and send `thumb.ready`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `runtime.routes.test.ts`:
    - An artifact without `capabilities.db` → `db.set` route 403 `capability_denied`.
    - A public artifact read anonymously → 200. An anonymous write → 401 unless `allowAnonymousWrites`. With it on, the 31st anonymous write per minute → 429.
    - A viewer whose share was revoked → 404.
  - `sdk.test.ts`, using happy-dom with a fake parent window:
    - A message from a non-parent source is ignored.
    - A malformed message is ignored.
    - A `result` resolves the matching call id only.
    - A call with no reply rejects after 15 s, using fake timers.
    - The raw view rejects with `capability_denied`.
- [ ] **Step 2: Implement.**

---

### Task B14: MCP server — tools, OAuth provider, PAT routing, agent attribution

**Files:** Create `src/mcp/server.ts`, `src/mcp/tools/artifacts.ts`, `src/mcp/tools/data.ts`, and `src/mcp/oauth.ts`, and modify `src/index.ts`. Tests: `test/mcp.tools.test.ts`, `test/mcp.auth.test.ts`, and `test/mcp.neutral.test.ts`.

**Interfaces:**
- `createServer(ctx: { env: Env; user: Member; agent: AgentRef | null }): McpServer` (from `@modelcontextprotocol/server` v2). It registers these tools. Each input schema is the matching F2 Zod schema, and each handler calls the matching B6–B9 or B12 service:

| Tool | Input | Service |
|---|---|---|
| `publish_artifact` | `PublishInput` | `publish` |
| `create_upload` | `UploadCreateInput` | `createUpload` |
| `get_artifact` | `{ id, version?, path?, includeContent=true }` | `getSummary` + `readVersionFile`. Text ≤ 1 MB inline; else a signed download URL |
| `list_artifacts` | `ListQuery` | `list` |
| `search_artifacts` | `{ q, cursor?, limit? }` | `search` |
| `list_versions` | `{ id }` | `listVersions` |
| `restore_version` | `{ id, version }` | `restoreVersion` |
| `share_artifact` | `{ id, email, role }` | `putShare` |
| `unshare_artifact` | `{ id, email }` | `deleteShare` |
| `set_visibility` | `{ id, visibility }` | `patch` |
| `delete_artifact` | `{ id }` | `softDelete` |
| `artifact_data_get` / `_list` / `_query` / `_set` / `_update` / `_delete` | `{ id, collection, … }` | DO stub. `actor = "agent:"+userId`; capability not required for the owner |

- **Results:**
  - Every result is `{ content: [{ type: "text", text: <one-line human summary + URL> }], structuredContent: <schema output> }`.
  - An `ApiError` becomes `{ isError: true, content: [{ type: "text", text: "<code>: <message>" }] }`. Quota errors use `QUOTA_MESSAGE` verbatim.
- **Server `instructions`:** a 60-line guide. It explains the formats, multi-file publishing, `create_upload` for anything over 128 KB (256 KB before be/inline-128k), how to declare capabilities, and the `window.openArtifacts` API with a 10-line poll example. The same text is exposed as the resource `openartifacts://docs/runtime`.
- **Routing in `index.ts`** (app host):
  - `path === "/mcp"` with `Authorization: Bearer oa_pat_…` → `verifyPat`. On failure → 401 JSON. On success → `createMcpHandler(() => createServer({ env, user, agent: { name: patLabel, version: null } })).fetch(req, { authInfo })`.
  - Everything else goes to `new OAuthProvider({ apiRoute: "/mcp", apiHandler: { fetch: (req, env, ctx) => createMcpHandler(() => createServer({ env, user: lookup(ctx.props.userId), agent: { name: ctx.props.clientName, version: null } }))(req, env, ctx) }, defaultHandler: app, authorizeEndpoint: "/oauth/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register" })`.
  - Before implementing, confirm the exact option names against the installed `@cloudflare/workers-oauth-provider` 1.x README. Adjust them if they differ, but keep this behavior.
- **`/oauth/authorize`** (in `mcp/oauth.ts`):
  - It needs a session. Without one → 302 to `/auth/login?next=<this url>`.
  - With one, it renders a server-side consent page: "{clientName} wants to publish and read artifacts as {email}", with Allow and Deny.
  - Allow → `completeAuthorization({ userId, props: { userId, clientName } })`.
  - Guests can't authorize. They get "Only members can connect agents".
- `GET R.oauthClients` and `DELETE R.oauthClient(grantId)` use the provider's `listUserGrants` and `revokeGrant`.
- **Tool manifest:** the build step `scripts/emit-tool-manifest.ts` writes `src/mcp/tool-manifest.json` with `[{ name, description }]` for every tool. The file is committed, and D7 consumes it. A test fails when the file is out of date.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `mcp.tools.test.ts` uses `@modelcontextprotocol/client` against the Worker with a PAT:
    - `tools/list` includes all 17 tools.
    - `publish_artifact` markdown → `get_artifact` returns the same content.
    - Publish a 3-file HTML artifact → `list_versions` length 1.
    - `artifact_data_set` → `artifact_data_get` round trip.
    - A quota error is mocked → the tool result has `isError` and its text contains `QUOTA_MESSAGE`.
  - `mcp.auth.test.ts`:
    - No auth → 401 with a `WWW-Authenticate` header pointing at the resource metadata.
    - A revoked PAT → 401.
    - The full OAuth flow: register a client, authorize as a member (the consent POST), exchange the token, then call `tools/list` → 200. The version's `agent.name` equals the registered `client_name`.
    - A guest at the consent page → the members-only message.
  - `mcp.neutral.test.ts`: no tool name, description, or the instructions contain `/claude|anthropic|openai|chatgpt/i`.
- [ ] **Step 2: Implement.**

---

### Task B15: Tokens, OG shell injection, thumbnails, usage

**Files:** Create `src/routes/tokens.ts`, `src/routes/shell.ts`, the thumbnail routes in `src/routes/artifacts.ts`, `src/services/usage.ts`, and `src/routes/usage.ts`. Tests: `test/tokens.test.ts`, `test/shell.test.ts`, and `test/usage.test.ts`.

**Interfaces:**
- **Tokens:**
  - `GET R.tokens` returns the caller's tokens.
  - `POST R.tokens {label}` → `TokenCreated`, for members and above. Guests → 404.
  - `DELETE R.token(id)` → revoke.
- **`GET /a/:id`** and **`/a/:id/v/:v`**:
  - Fetch `env.ASSETS` `/index.html`, then run HTMLRewriter.
  - **Public, not deleted:** set `<title>{title} · Open Artifacts</title>`, plus `og:title`, `og:description`, `og:type=website`, and `og:url`. Set `og:image` to `R.thumbnail(id)` if there is one.
  - **Otherwise:** `<title>Open Artifacts</title>` and no OG tags.
  - The response sends `Cache-Control: no-store`.
- **Thumbnails:**
  - `PUT R.thumbnail(id)` takes `image/webp` of at most `LIMITS.thumbnailBytes`, from viewers and above. It's accepted only when `has_thumbnail = 0` or when the uploader is an editor or higher.
  - `GET R.thumbnail(id)` serves it, from viewers and above.
- **Usage:**
  - `getUsage(env): Promise<Usage>`.
  - Without `ANALYTICS_TOKEN` → `{ available: false, date, metrics: [] }`.
  - With it: POST to `https://api.cloudflare.com/client/v4/graphql` for today in UTC:
    - `workersInvocationsAdaptive` sum of requests (limit 100000)
    - `d1AnalyticsAdaptiveGroups` rowsRead (5000000) and rowsWritten (100000)
    - `durableObjectsInvocationsAdaptiveGroups` requests (100000)
  - Cache the result for 5 minutes with the Cache API, keyed by date.
  - Usage is visible to owners and admins only.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - Tokens: a created token works with `/mcp` and `/api/v1/me`. After deletion, it's 401.
  - `shell.test.ts`:
    - A public artifact's shell HTML contains its `og:title`.
    - A private artifact's shell HTML contains neither its title nor its description, checked against the bytes.
    - A deleted public artifact → the generic title.
  - `usage.test.ts`:
    - No token → `available: false`.
    - With a token and a mocked GraphQL response → metrics are mapped correctly.
    - A second call within 5 minutes doesn't fetch again.
- [ ] **Step 2: Implement.**

---

### Task B16 (owner: **OpenArtifacts Platform**): Setup and upgrade CLI (`@oa/setup`)

**Files:** Create in `scripts/setup/src/`: `index.ts`, `state.ts`, `cf.ts`, `steps/prereqs.ts`, `steps/resources.ts`, `steps/access.ts`, `steps/secrets.ts`, `steps/deploy.ts`, `steps/owner-token.ts`, `steps/selftest.ts`, and `steps/agent-config.ts`. Tests: `scripts/setup/test/*.test.ts`.

**Interfaces:**
- **CLI:** `pnpm oa:setup [--name open-artifacts] [--app-host h] [--content-host h] [--owner-email e] [--account-id id] [--yes] [--upgrade] [--json]`. `--name` prefixes every resource. Staging is `--name open-artifacts-staging`, and setup must **adopt** staging's existing resources by name, reporting `skipped`. I3 tests this..
  - Interactive prompts fill in anything that's missing.
  - With `--yes`, a missing value is an error naming the flag.
  - `--json` prints machine-readable progress, one JSON object per step: `{ step, status: "ok"|"skipped"|"action_required"|"error", message, data? }`. Agents parse this.
- **State:** `.openartifacts/state.json` holds `{ accountId, appHost, contentHost, ownerEmail, d1Id, r2Bucket, kvId, accessAppId, accessClientId, teamDomain, deployedVersion }`. It's gitignored.
- **Each step** is `{ name, check(state): Promise<"done"|"todo">, apply(state): Promise<void> }`. Rerunning is idempotent: steps that are already done report `skipped`.

| Step | What it does |
|---|---|
| `prereqs` | Checks Node ≥ 22, pnpm, `wrangler whoami`, and that both hosts are in a zone the account owns (`GET /zones?name=`). |
| `resources` | Runs `wrangler d1 create open-artifacts`, `r2 bucket create open-artifacts`, and `kv namespace create OAUTH_KV`, or reuses them if they exist. Renders `apps/server/wrangler.jsonc` from the template with `ENVIRONMENT="production"`. |
| `access` | Gets a token with `wrangler auth token --json` and calls `GET /accounts/{id}/access/organizations`. A 403 is `action_required`: print a prefilled token-creation link (Access: Apps and Policies Edit; Access: Organizations Read; Zone: DNS Read) and prompt for `CF_API_TOKEN`, using it in memory only. No organization is `action_required` with the link `https://one.dash.cloudflare.com/` and "enable Zero Trust (free), then rerun". Otherwise, create or reuse the reusable policy "Open Artifacts – everyone" (`decision: allow, include: [{ everyone: {} }]`) and the SaaS app (`type: "saas"`, `saas_app.auth_type: "oidc"`, `redirect_uris: ["https://{appHost}/auth/callback"]`, `grant_type: ["authorization_code"]`, scopes `openid email profile`, PKCE on). Store the team domain and client id. |
| `secrets` | `wrangler secret put` for `ACCESS_CLIENT_SECRET`, plus `SESSION_SECRET` and `CONTENT_SIGNING_KEY` (32 random bytes, base64url; generated only on first run). `ANALYTICS_TOKEN` is optional and prompted for, and skipping it is fine. |
| `deploy` | Builds, runs `wrangler d1 migrations apply open-artifacts --remote`, then `wrangler deploy`. Before deploying, it **refuses** if the rendered config has `ENVIRONMENT=dev`. |
| `owner-token` | Generates a PAT locally, then runs `wrangler d1 execute --remote` to upsert the owner user and insert its hash. Outputs the token **once**, in the JSON `data`. |
| `selftest` | `GET /healthz`, OIDC discovery at `accessIssuer + "/.well-known/openid-configuration"` → 200, then the MCP `tools/list` and `publish_artifact` "Welcome to Open Artifacts" (Markdown from `scripts/setup/welcome.md`) with the PAT, then `GET` the returned URL → 200. |
| `agent-config` | Prints MCP config snippets with the URL and the `Authorization: Bearer` header for Claude Code (`claude mcp add --transport http …`), Codex CLI (`~/.codex/config.toml`), Cursor (`.cursor/mcp.json`), OpenCode, and generic JSON. |

- **`--upgrade`** skips `access` and `secrets` unless they're missing, then runs `deploy` and `selftest`.

**Steps:**

- [ ] **Step 1: Write the failing tests.** These use a fake `execa` and `fetch`, with recorded fixtures.
  - A first run on an empty account calls every create, in order.
  - A second run is all `skipped`, except `deploy` and `selftest`.
  - A 403 on access organizations → `action_required` with the token link, and the run exits with code 2.
  - A rendered config with `ENVIRONMENT=dev` → `deploy` errors out.
  - The PAT never appears in `state.json` or the logs, only in `owner-token`'s `data`.
  - Every `--json` line parses.
- [ ] **Step 2: Implement.**

---

### Task B17: CPU-budget suite and backend milestone checks

**Files:** Create `apps/server/test/cpu-budget/*.test.ts` and `apps/server/scripts/bench.ts`.

**Interfaces:**
- `bench.ts` runs `wrangler dev --remote=false` and, for each scenario, makes 50 requests and reads `cpuTime` from `wrangler tail`-style local tracing. If local tracing doesn't expose CPU time, it falls back to `performance.now()` around the handler inside the vitest pool and treats wall time as an upper bound.
- **Scenarios and p95 budgets:**

| Scenario | p95 budget |
|---|---|
| publish 50 KB markdown | ≤ 8 ms |
| publish 1.9 MB inline base64 | ≤ 9 ms |
| content `__view` html with injection, 500 KB entry | ≤ 5 ms |
| list 25 | ≤ 5 ms |
| search | ≤ 6 ms |
| db.set | ≤ 4 ms |
| MCP `tools/list` | ≤ 6 ms |

**Steps:**

- [ ] **Step 1: Write the tests asserting the budgets above.**
- [ ] **Step 2: Run them, optimize anything that's over budget, and run them again.**
  - Expected: all within budget.
  - If 1.9 MB of base64 can't fit, lower `LIMITS.inlineBytes` in `@oa/shared`. That's a contract change, so announce it. Then update the spec value.
- [ ] **Step 3: Milestone checks.**
  - **After B11: M1, backend half.** Dispatch a whole-track adversarial review of B1–B11.
  - **After B16: M2, backend half.** Review B12–B16. The adversarial brief must include: forging the PAT and OAuth routing, a guest reaching the consent page, crossing actors in the DO, and a `/p/` path for a public artifact that later went private.
  - **After B17:** report to the leads.
