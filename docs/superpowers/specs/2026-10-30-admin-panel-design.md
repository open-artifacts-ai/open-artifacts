# Admin panel: create and manage hosted installs by API (M1)

Status: draft for the Manager's review, 2026-10-30. Owner: Platform. UI:
Frontend. Visual options: Design.

## Why

The user's direction: bringing up an environment or an instance must never
need their laptop, and creating an instance is one API call on the same path
self-serve will use. M1 now includes an admin panel that lists the hosted
installs and manages them. leo.open-artifacts.app is created through it.

## Goals

- One create path for every hosted install: the provisioner Workflow from #859
  (`ProvisionInstall`). Admin creates and, later, self-serve signups both go
  through it.
- An admin API and a panel over it on a platform host, for platform admins
  only.
- Every safety check stays automatic and fails closed, with no approval
  clicks: the release gate, "prod is clean" and the read-backs.
- Every admin action is audited.

## Non-goals (M1)

- Self-serve signup UI, checkout, billing and free-plan caps (#849, #858, #866
  and the signup half of #859).
- Editing an install's content or its users (that stays inside the install).
- Multiple admin roles. One role, "platform admin", for M1.

## Anti-goals

- A new long-lived credential to get any of this working.
- Any path that creates or changes a prod install without the release gate and
  "prod is clean".
- Admin code or admin routes inside an install's bundle.

## Shape

```
browser ──> admin.open-artifacts.app  (Worker oa-p-admin: SPA + /api)
              │  sign-in: auth-broker (Google), allowlist
              │  PLATFORM_DB (read; writes only admin_jobs, signups, audit)
              │  PROVISION_INSTALL / MANAGE_INSTALL (Workflow bindings, script_name oa-p-provisioner)
              ▼
            oa-p-provisioner  (Workflows: ProvisionInstall, ManageInstall)
              │  WfpProvisioner from @oa/provision; token from Secrets Store
              ▼
            Workers for Platforms (oa-prod), KV, D1, R2 (oa-p-releases)
```

- **New app `apps/admin`** (Frontend's call, agreed): its own Worker
  `oa-<p>-admin` on `admin.open-artifacts.app` (staging:
  `admin.open-artifacts-staging.app`). The Worker serves the SPA's static
  assets and `/api/*`. No admin code goes into any install's bundle.
- **The provisioner Worker** (from #859) runs every lifecycle operation as a
  Workflow. The admin Worker never holds the provisioning token: it only
  starts Workflow instances and reads D1.

## 1. Admin API

All JSON. Error bodies are `{ "error": <code> }` with a stable code enum in
`packages/shared` (`admin-errors.ts`), so Frontend maps codes to copy.

| Method and path | What it does |
|---|---|
| `GET /api/me` | The signed-in admin's email, or 401. |
| `GET /api/installs?cursor=&q=&state=` | Paged list (50 per page, cursor). `q` matches slug or host prefix, server-side. |
| `GET /api/installs/:id` | One install, plus its latest jobs. |
| `POST /api/installs` | Create. Body: `{ slug, ownerEmail, tier, auth: { providers, domains }, requestId }`. Returns `202 { jobId }`. |
| `POST /api/installs/:id/upgrade` | Body `{ version, requestId }`. 202 with a job. |
| `POST /api/installs/:id/suspend` and `/resume` | Body `{ reason, requestId }`. 202 with a job. |
| `POST /api/installs/:id/delete` | Body `{ confirmSlug, requestId }`. `confirmSlug` must equal the slug. 202 with a job. |
| `POST /api/installs/:id/restore` | Within the grace period only. 202 with a job. |
| `GET /api/jobs/:id` | `{ kind, status: queued/running/done/failed, step, error }`. The UI polls every 2 s (no SSE in M1). |
| `GET /api/releases` | Versions the upgrade picker may offer: only releases published to `oa-<p>-releases` (see section 4). |
| `GET /api/audit?cursor=` | The admin audit log, newest first. |

List fields: slug, app host, release (version), tier, auth (providers and
domain count), state, created, last health (from the scheduler's nightly
results when present, else "unknown"). Owner email appears only on the detail
view. No usage numbers in M1.

**Async.** Every write starts one Workflow instance and returns a job id.
`requestId` is a client-generated UUID and the Workflow instance id is derived
from it (`<kind>-<requestId>`), so a replayed or double-submitted request
returns the same job and never starts a second operation. A create also holds
the slug's uniqueness in D1 (`signups.slug` and `installs.slug`), so two
different requestIds for one slug end with one install and one
`slug_taken` error.

**Lifecycle mapping.** Create is `ProvisionInstall`. A new `ManageInstall`
Workflow wraps provision's existing `upgrade`, `delete` and the new
suspend/resume, each under the install row's existing lease.

## 2. Panel UI

On `admin.open-artifacts.app`. Frontend reuses the dashboard's shell and
components (AppLayout, SettingsLayout side nav, ConfirmDialog with
type-to-confirm, VersionCard, useInfinite, errorCopy, the zod contract in
packages/shared). Screens: sign-in, no access, the installs list, install
detail (with its jobs and audit), create, and the audit log. Design draws two
or three options for the list and the create flow. The visual language is the
existing app's.

## 3. Auth

**Recommendation: Google through the existing auth broker, with an allowlist.**

- The admin Worker is registered in the broker registry like an install
  (registry entry `install:<admin id>` with its own Ed25519 key, origin
  `https://admin.open-artifacts.app`, domains `[]`). The CI deploy writes the
  entry; nothing is seeded by hand.
- Sign-in follows an install's flow exactly: the broker returns Google's raw
  ID token, and the admin Worker verifies it itself (signature, aud, its nonce,
  `email_verified`).
- The allowlist is committed config (`.github/hosted/<env>.json`,
  `admin_emails`, prod: `me@leourbina.com`). An email that isn't listed gets
  "no access" and an audit row. Changing admins is a reviewed PR.
- Session: a host-only, `__Host-` cookie on the admin host (Secure, HttpOnly,
  SameSite=Strict), 8 hours, signed with a key the CI deploy generates and
  puts as a Worker secret (CI-minted, never seen by a human). Every write
  also requires a matching `Origin` header and a CSRF token from `/api/me`.
- No new long-lived token: the broker's Google client and secret already
  exist.

Alternative: Cloudflare Access in front of the host. Rejected for M1 because
the token would need Access permissions (another edit) and Zero Trust setup is
a dashboard step outside CI.

**Audit.** A new `admin_audit` table: at, admin email, action, install id,
request id, outcome, error code. Every API write and every refused sign-in
writes a row in the same request, before the response. The Workflows also keep
writing provision's existing `hosted_audit` rows.

## 4. The release gate and "prod is clean"

- **Release gate.** A release reaches `oa-<p>-releases` only through CI's
  publish-release, which already runs `tag-passed-checks.sh` (published, on
  main, release checks passed, signed assets). The admin API offers and
  accepts only versions present in that bucket, and provision verifies the
  release's signature on every create and upgrade. So the gate stays in CI and
  cannot be skipped from the panel. A version that isn't in the bucket gets
  `release_not_published`.
- **Prod is clean.** It is a red-line probe that GitHub runs with the
  `redline-staging` read tokens. Inside an API-driven create it becomes two
  checks, both automatic and fail closed:
  1. In the Workflow: before create, refuse unless the bundle is `release`
     (never the test bundle) and the target is the prod namespace. After
     create, read back the new script's settings and secret names, and if a
     test hook or a test-only binding is present, delete the install and fail
     the job (`prod_dirty`).
  2. In CI: the existing `prod-clean` red-line job runs on a schedule (every
     hour) and on every release, across all prod installs, and emails the ops
     alert address on failure. That address comes from the scheduler's
     existing `OPS_ALERT_EMAIL` in #859.
- The read-backs from #847 and #848 stay as they are for the platform Workers.

## 5. What comes out of #849 and #859

- **From #859, taken into a new PR on main** (no billing):
  - `apps/provisioner`: the ProvisionInstall Workflow, the queue consumer (the
    queue stays for self-serve later), `errors.ts`, `message.ts`.
  - The platform migrations `0006_platform_state` and `0007_signups`.
  - Its `packages/provision` changes (the create changes, `ciTokenSweep`, the
    release reader).
  - The provisioner deploy target, the Secrets Store secret
    `oa-<p>-provision-token` (written by CI from `CLOUDFLARE_API_TOKEN`), and
    the queue and DLQ.
- **Changed for admin creates:** `signups` gains `source` ('admin' or
  'self-serve') and an admin-only `vars` JSON (providers, domains, tier). The
  Workflow passes them to `create` instead of `vars: {}`. Self-serve rows keep
  `{}`.
- **Left out:** all of #849 (billing), #858, #866, and #859's scheduler
  signups, alerts and billing-health parts. The provisioner imports only
  `@oa/provision`, so the extraction doesn't need billing.
- **Security review plan** (the Manager, plus a fresh reviewer):
  1. The extracted provisioner PR, reviewed as new code: the token from Secrets
     Store (no other Worker binds it), the lease handling, the email never
     leaving its steps, and the replay rules.
  2. The admin Worker: the sign-in verification, the allowlist, cookie and
     CSRF, every write audited, and no route that reaches the provisioning
     token.
  3. The red-line probes below run against staging before any prod use.

## 6. Red-line probes (new, staging first)

- A non-admin Google account signs in: `/api/me` is 403, the audit gets a
  refused row, and every `/api/*` write is 403.
- No cookie, a forged cookie, or a cookie from another host: 401 on every
  route.
- A write with a missing or foreign `Origin`, or no CSRF token: 403.
- A replayed create (same `requestId`): the same job id comes back, and the
  installs count changes by exactly one.
- Two creates with different requestIds for one slug: one install, one
  `slug_taken`.
- An upgrade to a version that isn't in the releases bucket:
  `release_not_published`, with no Workflow started.
- Delete without the right `confirmSlug`: 400, nothing changes.
- Suspend: the install's hosts return the suspended page (503) and its
  scheduler jobs skip it. Resume restores both.

## 7. Suspend, delete and restore

- **Suspend:** a new install state, `suspended`. Dispatch serves a fixed
  "This workspace is paused" page (503, Design writes the copy) for its hosts,
  the scheduler skips it, and its data is untouched. Resume sets it back to
  `active`.
- **Delete:** soft. The state becomes `deleting` with a 7-day grace period:
  hosts return the paused page, and restore is allowed. When the grace period
  ends, the scheduler runs provision's existing `delete` through ManageInstall
  (a hard delete, with the directory revoke). The panel asks the admin to type
  the slug.

## 8. Bring-up: what is still seeded once

- After `pl/ci-seeds`, in dashboards, with no laptop:
  - `CLOUDFLARE_API_TOKEN` in `hosted-prod-deploy`: roll the token in the
    Cloudflare dashboard and paste it into GitHub's secret form.
  - The inventory key: proposed to be replaced by GitHub OIDC (the inventory
    Worker verifies a GitHub Actions token, so there's no shared secret).
    Until then, one value pasted into two GitHub secret forms.
- `CREATE_OWNER_EMAIL` is no longer needed: the owner email is a field in the
  create form.
- The admin session key and the admin broker key are minted by CI.

## 9. Parts, ETA and merge order

| # | Part | Owner | ETA |
|---|---|---|---|
| 1 | `pl/ci-seeds` (one token, derived values) | Platform | PR today, about 20:30Z |
| 2 | Provisioner extraction from #859, with admin vars and replay-safe ids | Platform | 1 day |
| 3 | ManageInstall (upgrade, suspend/resume, soft delete and restore), the `suspended` state, dispatch's paused page | Platform, with Backend for dispatch | 1 day |
| 4 | Admin Worker API, auth, audit, and its deploy target | Platform | 1 day, parallel with 3 |
| 5 | Panel UI | Frontend, after Design's options | 2 to 3 days, starting once the API contract (packages/shared) lands |
| 6 | Red-line probes, staging | Platform | 0.5 day |
| 7 | Inventory OIDC (optional for M1) | Platform | 0.5 day |

Merge order: 1, then 2, then 4 with the API contract (so Frontend can build
against it), then 3, then 5, then 6 green on staging, then prod bring-up and
leo created from the panel. Realistic M1 date for leo: about 3 to 4 working
days from approval, with the UI on the critical path.

## Left to the builders

Component layout, polling details, table styling, the exact error copy
(Frontend and Design), and the D1 indexes.

## Open questions for the user

1. Admin auth: Google through the broker with an allowlist (recommended), or
   Cloudflare Access?
2. Delete: a 7-day soft delete with restore (recommended), or immediate?
3. Inventory key: GitHub OIDC (no seed, about half a day), or one value pasted
   into two secret forms?
