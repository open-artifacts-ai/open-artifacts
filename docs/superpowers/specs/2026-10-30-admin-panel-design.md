# Provisioning API and admin panel (M1)

Status: draft v3, 2026-10-30. Reworked on top of the Manager's review, after
the user reframed it. Owner: Platform. Panel UI: Frontend. Visual options:
Design.

## Why

The user's direction:
- Creating and managing an instance is one direct API call, with no CI
  anywhere in the path and never a laptop.
- The product is a **Provisioning API**. The admin panel is one client of it.
  Self-serve signup is another, a thin client on the same endpoints under a
  stricter policy.
- leo.open-artifacts.app is created through it.

## Goals

- One API and one Workflow for every lifecycle operation: create, upgrade,
  suspend/resume, delete/restore, rollback, and list. The admin panel, any
  AI agent an admin authorizes, and (post-M1) the self-serve signup page all
  call the same endpoints.
- Two principals with an explicit authz table: platform admin and self-serve
  user.
- The release gate and "prod is clean" run inside the Workflow, automatically,
  fail closed, with no approval clicks.
- Every action is audited.
- Staging first: the whole path passes red-line on staging before prod.

## Non-goals (M1)

- The self-serve signup screens, checkout and billing (#849, #858, #866).
  The API is self-serve-ready: same route, same Workflow, and the self-serve
  policy is built and tested, but `SIGNUPS_ENABLED` stays `false` in prod.
- Editing an install's content or users (that stays inside the install).
- Admin roles beyond one "platform admin".

## Anti-goals

- CI in any provisioning path, or anything per-install written by CI.
- A new long-lived credential.
- An install reachable before it has been checked.
- A create or upgrade from anything but a signed release that CI published.
- Admin code inside an install's bundle.

## Decisions (Manager's call; the user can override)

1. **Sign-in:** Google through the existing auth broker. Admins match a
   committed allowlist. Not Cloudflare Access.
2. **Delete:** a 7-day soft delete with restore, then a hard delete.
3. **Inventory key:** replaced by GitHub OIDC in M1.
4. **CI break-glass for installs: none** (section 9).
5. **AI agents:** yes in M1, through short-lived, scoped tokens that an admin
   mints from a signed-in session (section 4).

## Shape

```
admin panel (browser) ─┐   admin.open-artifacts.app/api/v1/*   (same Worker, session cookie)
any AI agent ──────────┼─> api.open-artifacts.app/v1/*         (bearer: agent token)
self-serve page (later)┘   signup host, same /api/v1 handler   (session cookie, self-serve policy)
        │
        ▼
oa-<p>-provisioning  (the API Worker: auth, authz, validation, audit, jobs)
        │  starts Workflow instances; never holds the provisioning token
        ▼
oa-<p>-provisioner   (Workflows: ProvisionInstall, ManageInstall; queue consumer for self-serve)
        │  WfpProvisioner from @oa/provision; token from Secrets Store
        ▼
Workers for Platforms (oa-prod), KV, D1, R2 (oa-p-releases)
```

- **`apps/provisioning`** is one Worker, `oa-<p>-provisioning`, on two
  hosts:
  - `admin.<app>`: the panel's SPA assets, plus `/api/v1/*`, same-origin,
    with a host-only cookie.
  - `api.<app>`: `/v1/*` for bearer callers only. No cookies are accepted
    there.
  - Staging uses the same names under `open-artifacts-staging.app`. The
    self-serve page later gets its own host on the same Worker.
- **`apps/provisioner`** (from #859) runs every lifecycle operation as a
  Workflow. Only it binds the provisioning token, through Secrets Store.

## 1. Routes and authz

The contract lands first, as its own small PR in `packages/shared/src/provisioning/`:
zod schemas, enums and error codes. Frontend builds against mocks of it.

**Principals.**
- **Admin:** a session whose verified email exactly matches `admin_emails`
  (committed config, prod: `me@leourbina.com`), or an agent token minted by
  such a session. The token carries only its scopes.
- **Self-serve user:** a session for any other verified Google account. They
  are a user only of installs whose `owner_sub` is their Google subject.

| Route | Admin session | Agent token (scope) | Self-serve user |
|---|---|---|---|
| `GET /me` | yes | yes | yes |
| `GET /installs` | all installs | `installs:read` | only their own |
| `GET /installs/:id` | yes | `installs:read` | only their own |
| `POST /installs` (create) | any slug, owner, tier and auth | `installs:write` | only for themselves: owner = their verified email, `tier: trial`, Turnstile token required, one install per Google account, under the daily cap, and only while `SIGNUPS_ENABLED=true` |
| `POST /installs/:id/upgrade` | yes | `installs:write` | no (403) |
| `POST /installs/:id/rollback` | yes | `installs:write` | no |
| `POST /installs/:id/suspend`, `/resume` | yes | `installs:write` | no |
| `POST /installs/:id/delete`, `/restore` | yes | `installs:delete` | their own only, with the typed slug; restore within the grace period |
| `POST /installs/:id/release-lease` | yes | no | no |
| `GET /jobs/:id` | yes | `installs:read` | only jobs on their own installs |
| `GET /releases` | yes | `installs:read` | no |
| `GET /audit` | yes | `audit:read` | no |
| `GET /slugs/:slug` | yes | `installs:read` | yes (rate-limited) |
| `POST /tokens`, `GET /tokens`, `DELETE /tokens/:id` | yes | never (a token can't mint tokens) | no |

Any other combination is 403, decided by one authz table in code. A test
walks every route against every principal.

**Shapes.**
- `GET /me`: `{ email, role: "admin" | "user", env: "staging" | "prod", csrf }`.
  401 sends a browser to sign-in with a return path; 403 is "no access".
- Create body: `{ slug, ownerEmail, tier, auth: { providers, domains }, requestId, turnstile? }`.
  The self-serve policy overrides `ownerEmail` and `tier` and ignores `auth`.
  Returns 202 `{ jobId, installId }`.
- Every other write takes `requestId`. Suspend needs `reason` (1 to 200
  characters), and delete needs `confirmSlug`. Each returns 202 `{ jobId }`.
- Job: `{ id, kind, installId, status, step, steps, startedAt, finishedAt, error }`.
  Clients poll every 2 s.
- Install (detail): the list fields plus owner email, `activeJobId` and
  `purgeAt`.
- List fields: slug, app host, release, tier, auth (providers and domain
  count), state, created, health. Paging is a cursor of 50, and `q` (slug or
  host prefix) and `state` filters run on the server.
- `GET /releases`: `[{ version, publishedAt, current }]`.
- `GET /audit?cursor=&installId=`.

**Enums.**
- Install state: `creating`, `create_failed`, `active`, `upgrading`,
  `suspended`, `deleting`, `deleted`.
- Health: `ok`, `failing`, `unknown`.
- Tier: `trial`, `team`, `business`.
- Job kind: `create`, `upgrade`, `rollback`, `suspend`, `resume`, `delete`,
  `restore`.
- Job status: `queued`, `running`, `done`, `failed`.
- Steps, ordered per kind:
  - create: `reserve`, `fetch_release`, `upload`, `verify_clean`, `route`,
    `notify`, `done`;
  - upgrade: `check`, `fetch_release`, `upload`, `verify_clean`, `switch`,
    `done`.
- Error codes: `unauthenticated`, `forbidden`, `csrf_failed`,
  `rate_limited`, `invalid_input`, `slug_invalid`, `slug_reserved`,
  `slug_taken`, `turnstile_failed`, `signup_limit`, `signups_closed`,
  `job_in_progress`, `release_not_published`, `release_unverified`,
  `downgrade_refused`, `confirm_mismatch`, `not_found`, `prod_dirty`,
  `grace_expired`, `internal`.

**Validation.** provision's slug rule and `RESERVED_SLUGS` move to
`@oa/shared` so every client checks before it submits.

**Jobs and replays.**
- Every write starts one Workflow instance. Its id comes from the
  client's `requestId` (`<kind>-<requestId>`), so a replay returns the same job
  and never starts a second operation.
- Slugs are unique in D1, so two creates for one slug end with one install
  and one `slug_taken`.
- A write on an install with an active job gets `job_in_progress`, and the
  install's lease enforces the same inside the Workflow.
- Downgrades are refused. Going back is `rollback` (to the stored previous
  version).

**One create path.** Every create writes a `signups` row (`source`: `admin`
or `self-serve`; admin rows also carry `vars`: providers, domains, tier) and
the owner email in `signup_secret`.
- An admin create is admitted at once and starts `ProvisionInstall`.
- A self-serve create is written `pending` and goes through #859's queue
  consumer, which admits it under the daily cap and then starts the same
  `ProvisionInstall`.

## 2. Panel UI

The panel is on `admin.<app>` and calls `/api/v1`. Frontend reuses the
dashboard's shell and components: AppLayout, SettingsLayout, ConfirmDialog,
VersionCard, useInfinite and errorCopy.

Screens:
- sign-in, and no access;
- the installs list;
- install detail, with its jobs and audit;
- create;
- the audit log;
- agent tokens.

`env` drives a "Production" banner on every write form in prod. Design draws
two or three options for the list and the create flow, and writes the copy for
the install's "This workspace is paused" page (suspended, and deleting).

**E2E sign-in stub:** test builds only, so Playwright can drive the panel
without Google. It's absent from release builds: check-no-test-hooks covers
`apps/provisioning`, and a red-line probe proves release builds refuse it.

## 3. Sign-in, sessions and limits

- **Sign-in.** The provisioning Worker is registered in the broker registry
  like an install (its own Ed25519 key, origin `https://admin.<app>`). The
  entry is platform deploy state, written by the CI deploy of this Worker,
  never per install. The broker returns Google's raw ID token, and the Worker
  verifies it itself: signature, `aud`, nonce, expiry and `email_verified`.
  The admin check is an exact email match. Nothing relies on Google's `hd`
  claim or on a domain.
- **Session.** A `__Host-` cookie (Secure, HttpOnly, SameSite=Strict) lasting
  8 hours, plus a CSRF token from `/me` in an `x-csrf-token` header and a
  matching `Origin` on every write. Cookies are accepted only on the browser
  hosts, never on `api.<app>`.
  - The session key is a Worker secret that CI sets **only when it's absent**,
    so a deploy never logs anyone out. Rotation is a separate op.
- **Rate limits.** These use Workers rate-limit bindings; an unbound limiter
  fails closed with 503.
  - Refused sign-ins: 10 a minute per IP, and 20 an hour per email.
  - Admin writes: 30 a minute per admin (shared with that admin's tokens).
  - Self-serve: creates 3 an hour per IP and 1 per Google account; slug
    checks 30 a minute per IP.
  - Any limit returns 429 `rate_limited`, with an audit row.
- **Alert.** 5 or more refused sign-ins within 10 minutes sends one email
  through the existing ops alert path, at most one an hour.

## 4. AI agents: scoped, short-lived tokens

- **Minting.** An admin session mints one with `POST /tokens { label, scopes, ttlMinutes }`.
  - Scopes: `installs:read`, `installs:write`, `installs:delete`,
    `audit:read`.
  - TTL: 15 minutes by default, 60 at most.
  - At most 5 live tokens per admin.
- **Storage.** The token is opaque (`oat_<random>`) and shown once. D1 stores
  only its SHA-256, the admin's email, the scopes and the expiry.
- **Use.** Agents send `Authorization: Bearer` to `api.<app>/v1`. Every call
  is audited under the admin's email, with the token's label.
- **Revocation.** `DELETE /tokens/:id`, or all of an admin's tokens at once.
  When an admin leaves the allowlist, their tokens stop working at once,
  because the allowlist is checked on every call.
- A token can't mint tokens, can't call `release-lease`, and can't widen its
  scopes. Agent tokens for self-serve users come after M1.

## 5. The release gate and "prod is clean", inside the Workflow

CI only builds, signs and publishes releases, and deploys platform code. The
checks on a create or upgrade all run in the Workflow:

1. **Release.** `fetch_release` reads the version from `oa-<p>-releases`
   (where only CI's gated publish-release can put it) and verifies its
   signature with provision's existing release reader.
   - A missing version is `release_not_published`.
   - A bad signature is `release_unverified`.
2. **Upload without routes.** The script is uploaded with no `hosts` row and
   no `oa-<p>-hosts` mapping. For an upgrade, the old version keeps serving.
3. **verify_clean.** Read back the uploaded script's bindings, settings and
   secret names. Refuse on any test hook or test-only binding, or on a bundle
   other than `release` in prod (`prod_dirty`).
4. **route / switch.** Only then write the hosts row and the KV mapping, or
   switch the upgrade over.

A dirty install is never served. On `prod_dirty`, the Workflow removes the
upload as cleanup and fails the job.

**Monitoring, not a step.** The hourly red-line `prod-clean` job watches every
prod install and sends an ops alert on failure. It never gates or runs a
provisioning step.

**Getting releases there.** A new `hosted-publish` job in
`release-please.yml`, after `hosted-attach-*`, runs the tag gate and publishes
each release to staging, then to prod. That's release publishing, not
provisioning. Before the first prod create, one CI publish of v0.77.0 puts a
release in `oa-p-releases`.

## 6. What changes in CI

- **Retired:** `hosted-ops.yml`'s `create`, `upgrade`, `rollback`, `delete`,
  `update-vars`, `release-lease` and `reissue-owner-token`. Its prod-clean
  precheck and `CREATE_OWNER_EMAIL` go with them.
- **Kept:** `publish-release` and `publish-floor` (moved into the new
  `hosted-publish` job), and deploy-hosted-platform for the platform Workers,
  now including `provisioning`, `provisioner` and the Secrets Store secret.
- **Platform deploy state, written by CI deploys only:** the Secrets Store
  provisioning token, the provisioning Worker's broker entry and key, its
  session key (only if absent), and the queues. Nothing per install.
- The local `pnpm oa:hosted` CLI stays as a read-only status tool. Its write
  commands are removed once the API is live.

## 7. What comes out of #849 and #859

- **From #859, taken into a new PR on main** (no billing):
  - `apps/provisioner`: ProvisionInstall, the queue consumer, `errors.ts` and
    `message.ts`;
  - the migrations `0006_platform_state` and `0007_signups`;
  - its provision changes;
  - the provisioner deploy target, the Secrets Store secret, and the queue and
    its DLQ.
- **New work:**
  - a `ManageInstall` Workflow;
  - admin `vars` and `source` on `signups`;
  - the fetch, upload, read-back and route order in provision;
  - migration `0008_provisioning` (`jobs`, `admin_audit`, `agent_tokens`,
    state `suspended`, `purge_at`);
  - dispatch's paused page;
  - the scheduler's purge after the grace period.
- **Left out:** #849, #858, #866, and #859's scheduler signups, alerts and
  billing-health parts. The provisioner imports only `@oa/provision`.
- **Security review** (the Manager plus a fresh reviewer, per PR):
  1. The provisioner extraction as new code: the Secrets Store token bound
     only there, leases, the email never leaving its steps, replays, and the
     new ordering.
  2. The provisioning Worker: token verification, the authz table and its
     test, cookies, CSRF and Origin handling, agent tokens, rate limits,
     audit, and no route that reaches the provisioning token.
  3. The red-line probes below, green on staging before prod.

## 8. Red-line probes (staging first)

- Every route against every principal matches the authz table: admin,
  admin's token per scope, self-serve user, no auth.
- A self-serve user:
  - can't read or change another user's install;
  - can't pick an owner, tier or auth;
  - can't create a second install;
  - is refused without a valid Turnstile token;
  - is refused while `SIGNUPS_ENABLED=false`.
- A non-admin Google account can't use admin routes, and the refusal is
  audited.
- No cookie, a forged cookie, or a cookie sent to `api.<app>`: 401.
- A missing or foreign `Origin`, or no CSRF token, on a write: 403.
- Agent tokens:
  - an expired, revoked or out-of-scope token is refused;
  - a token can't mint tokens;
  - removing the admin from the allowlist ends its tokens.
- The sign-in stub is refused by release builds.
- Rate limits: the 11th refused sign-in in a minute gets 429.
- A replayed create returns the same job, and installs grow by exactly one.
- Two creates for one slug: one install, one `slug_taken`.
- An unpublished version gets `release_not_published`, and a downgrade gets
  `downgrade_refused`.
- A write during a running job gets `job_in_progress`.
- A wrong `confirmSlug` gets `confirm_mismatch`, and nothing changes.
- Suspend: the paused page serves and the scheduler skips the install.
  Resume restores both.
- Prod is clean (staging-only test): a forced test binding never gets
  routed, and the job ends `prod_dirty`.

## 9. CI break-glass: none

- Recovery runs through the API itself:
  - `rollback` for a bad upgrade;
  - `release-lease` for a stuck lease;
  - `suspend` to stop an install serving.
- If the provisioning Worker or the provisioner itself is broken, the fix is a
  code change deployed from CI like any other platform deploy. A parallel CI
  lifecycle path would be a second, rarely exercised route around the
  Workflow's checks, which is exactly what the user wants gone.

## 10. Bring-up: staging, then prod, all in dashboards

- **Environments.** The Manager creates `hosted-staging-deploy` the same way
  as `hosted-prod-deploy`: main only, no reviewers, admin bypass off.
- **Tokens.** One per environment, user-owned, each pasted into its GitHub
  secret form; no laptop. Read-only checks today:
  - Prod lacks only Secrets Store.
  - Staging lacks Secrets Store and every zone scope on
    `open-artifacts-staging.app` and `.page`.
- **Scopes both need:**
  - Account: Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Workers
    R2 Storage Edit, Turnstile Edit, Queues Edit, Workflows Edit, Secrets
    Store Edit.
  - Zone (the env's two zones): Zone Read, Zone Settings Edit, DNS Edit,
    Workers Routes Edit.
- **Steps per token:** edit it in place to add the missing scopes, then Roll
  it and paste the value into `CLOUDFLARE_API_TOKEN`. The page links each
  step.
- **Nothing else is seeded:**
  - the inventory key is gone (OIDC);
  - `CREATE_OWNER_EMAIL` is gone (the owner is an API field);
  - the session and broker keys are minted by CI;
  - the Google secrets exist.
- **Order:**
  1. ci-seeds merges.
  2. Staging: seed the token, CI deploys the platform and the API, red-line
     goes green.
  3. Prod: seed the token, CI deploys, v0.77.0 is published.
  4. leo is created from the panel, and the prod-clean monitor goes green.

## 11. Parts, ETA and merge order

| # | Part | Owner | ETA |
|---|---|---|---|
| 1 | `pl/ci-seeds` (one token, derived values, `hosted-publish`) | Platform | PR tonight |
| 2 | The API contract in `packages/shared` | Platform | 0.5 day, first |
| 3 | Provisioner extraction, ManageInstall, the new provision order | Platform | 1.5 days |
| 4 | The provisioning Worker: authz, sessions, agent tokens, limits, audit, deploy target | Platform | 1.5 days, parallel with 3 |
| 5 | Dispatch's paused page, the scheduler's purge | Backend | 0.5 day |
| 6 | Inventory OIDC; retire hosted-ops' lifecycle ops | Platform | 0.5 day |
| 7 | Panel UI | Frontend, after Design's options, on mocks from part 2 | 2 to 3 days, parallel |
| 8 | Red-line probes, staging bring-up, green run | Platform | 0.5 day |

Merge order: 1, then 2, then 3 and 4, then 5 and 6, then 7, then 8 green on
staging, then prod bring-up and leo from the panel. Realistic date for leo:
about 3 to 4 working days from approval.

## Left to the builders

Component layout, polling details, table styling, error copy (Frontend and
Design), D1 indexes, and the token prefix format.
