# Red-line test hooks (contract, as built)

P5 Task 1. Describes `/__test/*` exactly as implemented in
`apps/server/src/test-hooks/index.ts` (with `app.ts`, `index.ts`,
`auth/codes.ts`, `routes/codes.ts` and `@oa/shared` `hosted/test-hooks.ts`).
The suite in `tests/redline` codes against this. Where it differs from the P5
plan's Task 1 interfaces, the code wins; the differences are listed at the end.

## When hooks exist (fail closed)

Hooks are live only when **all** of these hold:

1. Build: `__OA_TEST_HOOKS_ALLOWED__` is compiled `true` (the `redline`
   bundle, `packages/provision/src/bundle.ts`). The release bundle defines it
   `false`; `app.ts`, `auth/codes.ts` and `routes/codes.ts` then hold no
   reference to `test-hooks/`, esbuild drops the module, and no `/__test/*`
   route is registered (`test-hooks-strip.test.ts`, `check-no-test-hooks`).
2. Var `TEST_HOOKS === "1"`.
3. Secret `TEST_HOOK_KEY` is a string of at least 32 chars.
4. Var `TEST_DOMAIN` is a non-empty string.

Otherwise every `/__test/*` request gets the standard JSON 404
(`not_found`) before any auth, and `/healthz` has no `testHooks` field.

Provisioning (`packages/provision/src/metadata.ts`): only `testHooks: true`
installs get `TEST_HOOKS=1` and `TEST_HOOK_KEY`; `testHooks` is refused in
`prod`, and so is `TEST_DOMAIN` without `testHooks` or in `prod`.

## Hosts

Hooks exist on the **app host only**. The Worker routes `CONTENT_HOST` to the
content app, which mounts no hooks (its 404). A host that is neither
`APP_HOST` nor `CONTENT_HOST` gets a plain-text 404 before routing (under
`ENVIRONMENT=dev`, `localhost`, `127.0.0.1` and `[::1]` also count as the app
host). Hooks are mounted before the session middleware, so no session is read.

## Request pipeline

Every `/__test/*` request, in order:

1. Hooks off (above): 404.
2. `RL_ANON` unbound: 404. Rate limit
   `RL_ANON.limit({ key: "test:<installKey>:<cf-connecting-ip>" })`
   (`installKey` is the trimmed `INSTALL_ID`, else `APP_HOST`). Limited: 404,
   logged `test_hook.limited`, no audit row.
3. `Authorization: Bearer <key>` compared with `TEST_HOOK_KEY` in constant
   time (SHA-256 of both, then an XOR fold over the digests). Missing or wrong:
   audit `denied`, 404 (never 401).
4. Method other than `POST`, or an unknown path: audit `refused`, 404.
5. The hook's own input checks; any failure: audit `refused`, 404.

Every refusal is the same 404 body, so a 404 alone proves nothing.

## Audit

Every call past the rate limit writes one D1 `audit_events` row:
`actor_kind = 'test_hook'`, `actor_id` = the user id when known,
`action = 'test_hook.<hook>'` (`session`, `otp_latest`, `oauth_client`,
`unknown`), `target_type = 'test_hook'`, `target_id = <hook>`, and `detail`
JSON `{ hook, ip, outcome, domain? }`. `outcome` is `ok`, `denied`, `refused`
or `none` (otp/latest found nothing). `domain` is the email's domain, never
the address. The audit DDL runs `IF NOT EXISTS` first, so installs that
predate the `audit_events` migration log too. `GET /api/v1/audit` and its
export list only `user`, `sync` and `system` actors, so `test_hook` rows are
readable through D1 only. A log line
`{"evt":"test_hook.<hook or outcome>"}` goes to Workers Logs.

## Hooks

### `POST /__test/session`

Body (`TestSessionInputSchema`, strict):
`{ email, role: "owner"|"admin"|"member"|"guest", spaces?: [{ spaceId, role: "viewer"|"editor"|"manager" }] }`.

Returns `200 { cookie }`: a signed session value for that user (provider
`test`, the user's current session epoch). The cookie name is
`__Host-oa_session`, or `oa_session` under `ENVIRONMENT=dev`. Refused (404)
when:

- `role` is `owner` (new users are capped at admin);
- the normalized email's domain isn't exactly `TEST_DOMAIN`;
- the email is `OWNER_EMAIL`;
- the user exists with a different role, or isn't `active` (no role change:
  insert-if-absent, then the stored row is judged, so a race can't slip a
  role through);
- more than 20 `spaces`, a duplicate `spaceId`, or an id not matching
  `^test-[A-Za-z0-9_-]{1,59}$`;
- a listed space that exists is personal, deleted, or has any member whose
  email isn't under `TEST_DOMAIN` (checked before the user is created, and
  again inside the SQL of each write).

Missing `test-` spaces are created as `shared`; the user's `manual`
`space_members` rows are upserted in one batch. Lowering a role closes the
user's live sockets.

### `POST /__test/otp/latest`

Body `{ email }`. Returns `200 { code }`, or 404 when there is none. `email`
must be under `TEST_DOMAIN`. Codes stay hashed in D1. Only while hooks are on,
a code actually **sent** to a `TEST_DOMAIN` address is also written in
plaintext to `OAUTH_KV` under `test:otp:<installKey>:<emailKey(email)>`
(`emailKey` is an HMAC of the address, never the address) with a 600 s TTL,
and deleted when the code is redeemed.

### `POST /__test/oauth-client`

No body. Returns `200 { clientId, accessToken }`: a public client
(`token_endpoint_auth_method: none`, redirect
`http://127.0.0.1/p5-oauth-callback`) registered through the real OAuth
provider, an authorization completed server-side with PKCE S256 for the
`/mcp` resource, and the code exchanged at `/oauth/token`. The grant is for
the fixed member `p5-oauth@<TEST_DOMAIN>` (created as `member` if absent).

### `POST /__test/audit`

Read-only (added in #642). Body (`TestAuditInputSchema`, strict): `{ since }`,
ms since the epoch, integer ≥ 0; anything else is audited `refused` and gets
the 404. Returns `200 { events }`, each `{ action, at, actorId, targetId,
detail }` with `at >= since`, newest first, at most `TEST_AUDIT_LIMIT` (200).
Only `test_hook.*` rows, enforced in SQL (`actor_kind = 'test_hook'` and
`substr(action, 1, 10) = 'test_hook.'`, no `LIKE` wildcards), so no other audit
event leaves through it. Audited like every hook (`test_hook.audit`), written
after the read, so a response never contains its own call. `GET /api/v1/audit`
and its export are unchanged and still list no `test_hook` rows. Release
builds drop it with the rest of `test-hooks/` (a strip-test marker and the
`check-no-test-hooks` path list).

## `/healthz`

`{ ok: true, plan, version, testHooks?: true, installId? }`. `testHooks` is
present (`true`) only while hooks are on; absent means off. `installId` is the
trimmed `INSTALL_ID`, absent when unset.

## Suite credentials

Hooks never act on the owner, so the suite's per-install credential is an
**admin** test user, `redline-admin@<TEST_DOMAIN>`: the session hook gives its
cookie, then `POST /api/v1/tokens { label: "redline" }` with that cookie and
`x-oa-request: 1` returns `201 { token }`. Where the plan says "owner PAT",
read this admin PAT.

## Suite checks on the hooks

- A wrong key gets the 404.
- Hooks on the content host get a 404.
- A hook call shows up in `audit_events` (`action = 'test_hook.session'`).
  Local mode reads D1. Staging takes `since = Date.now()`, calls
  `/__test/session`, then `/__test/audit { since }` and expects that row; a 404
  from the audit hook reports `unproven-live`, never pass.

## Differences from the P5 plan's Task 1

| Plan | As built |
|---|---|
| Live when `TEST_HOOKS="1"` and a 32+ char key | Also needs the build flag and a non-empty `TEST_DOMAIN` |
| `/healthz` reports `testHooks: false` when off | The field is **absent** when off, never `false` |
| `session` for any role; user "created if missing" | `owner` refused; email must be under `TEST_DOMAIN` and not `OWNER_EMAIL`; an existing user's role is never changed |
| `spaces?: [{id, role}]` | `spaces?: [{spaceId, role}]`; `test-` ids only, at most 20, no member outside `TEST_DOMAIN` |
| `otp/latest` KV key `test:otp:<install>:<email>` | `test:otp:<installKey>:<emailKey(email)>`; only sent codes to `TEST_DOMAIN`; deleted on redeem |
| `oauth-client`: a grant for the owner | A grant for member `p5-oauth@<TEST_DOMAIN>` |
| Cookie `__Host-oa_session` | `oa_session` under `ENVIRONMENT=dev` |
| Rate-limited, every call audited | Rate-limited calls are logged, not audited; every call past the limiter is audited |
| "Owner PAT" | Admin PAT for `redline-admin@<TEST_DOMAIN>` |
