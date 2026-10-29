# SS3: the hosted provisioner (self-serve step 3)

Status: design for review (Manager), 2026-10-29. Post-M1: branches only, nothing
merges until the freeze lifts and M1 ships.

## Intent

A self-serve sign-up must create a hosted install with no laptop and no human in
the loop. Today `create` runs only from the `oa:hosted` CLI (a laptop, or CI
through #848's hosted-ops.yml). SS3 runs the same `WfpProvisioner.create` inside
a control-plane Worker, triggered by a queue message from the sign-up service
(SS4, built later), with the account-wide provisioning token held only there.

## Goals

- One queue message in, exactly one install out, however often the message or
  any step is retried.
- Reuse `@oa/provision` as it is: every guard the red-line suite proved (prod
  lock, signed release record and floor, lease, check-first steps, selftest)
  stays in force, unmodified.
- The provisioning token is a Secrets Store secret bound only to
  `oa-<p>-provisioner`.
- A daily create cap, and an operator alert (SS1b's email path) when the cap is
  hit or a create fails for good.
- The owner gets exactly one welcome email.

## Non-goals

- The public sign-up Worker, Google sign-in, Turnstile, the name check and the
  one-free-install-per-Google-account store: SS4 (Platform), next.
- Sign-up and onboarding screens: SS4 pages (Frontend).
- Fleet upgrades: step 4. Upgrades, rollbacks and deletes stay on the CLI/CI.
- Paid tiers at create: every self-serve install starts free (SS1's tier row).

## Anti-goals (a failure even if it works)

- Two installs for one sign-up, or an install with no `signups` row pointing at it.
- The owner's email in any log line, Workflow step output, step error, alert or
  queue dead-letter payload we write.
- A token that can reach any Worker other than the provisioner.
- A provision fork: a second, Worker-only copy of create's logic.

## What exists (main, 5469cf78)

- Bundling already happens at publish time. `create` reads the signed, prebuilt
  release from `oa-<p>-releases` through `ReleaseReader`
  (`r2ReleaseReader(cf, env)`, REST plus the token). bundle.ts and release.ts's
  file walks are publish-side only; `internal/template.ts` is a test helper.
- Still Node-bound in the create path: `patDir` (the owner PAT file for the
  selftest, and the red-line-only test-hook key), `node:crypto` (createHash,
  Ed25519 `generateKeyPairSync`, `createPublicKey`, `verify`) and
  `AsyncLocalStorage`.
- #848 (approved, draft) adds the ephemeral `ci-<run>` owner token: minted under
  the lease, held in memory for the selftest, revoked before the lease is
  released (`ciOwnerToken: { label }` on WfpOptions). That removes the PAT
  file from create. SS3 stacks on #848 (`pl/hosted-ops-ci`) and #849
  (`pl/ss1-tier-store`: BILLING, platform migration 0006).
- create's lease is 30 minutes (`LEASE_MS`); a rerun while it is held is
  refused with a `ProvisionRefused` naming the lease.
- `create` already treats `ownerEmail` as sensitive (`this.sensitive`) and
  redacts it from errors.

## Approaches

- **A. One coarse Workflow step around `create()` (chosen).** reserve, create,
  notify. Retries rerun `create`, which resumes partial work through its own
  check-first idempotency and lease. Almost no provision change; costs: the
  step must fit one invocation's CPU, subrequest and memory limits.
- **B. Split create into many Workflow steps.** Finer retries, but a deep
  refactor of wfp.ts (3,700 lines) and its lease, and the red-line coverage must
  be re-earned: several days more.
- **C. The queue dispatches #848's hosted-ops workflow.** Dropped: a GitHub
  write token in a Worker, prod runs wait on Environment approval (no
  self-serve), and it spends the shared GitHub API budget.

Chosen: **A, gated on the spike** (Manager, 2026-10-29). If a real create does
not fit one step, split out only the part that does not fit (most likely the
release upload), and keep the rest coarse.

## Limits that bind (Cloudflare docs, checked 2026-10-29)

- Workflow step wall time: unlimited. CPU per invocation: 30 s default, up to
  300 s with `limits.cpu_ms`. Waiting on fetch does not count.
- Subrequests: 10,000 per invocation on Paid by default (configurable higher).
- Memory: 128 MB per isolate.
- Queue consumer invocation: 15 min wall.

## Step 0: the spike (gate; numbers reported before building)

Everything deploys through CI, staging included (the user's rule), so the
spike runs in two parts.

1. **Now, without deploying anything:**
   - the release's size: module and asset bytes of the current staging
     release, read (read-only) from `oa-s-releases`;
   - the subrequest count of one create, from a full create against the
     existing fake Cloudflare (`fake-cf.ts`) with the real release's files,
     every API call and fetch counted by kind;
   - memory and CPU of that create in workerd, run under pool-workers (and
     `wrangler dev` where pool-workers can't show peak memory);
   - workerd compatibility: `@oa/provision` imports and runs under
     `nodejs_compat`, Ed25519 key generation and verification included.
2. **After #848 merges (post-gate):** one real staging create of a throwaway
   install (`ss3-spike-<n>`, codes off) through `hosted-ops.yml`, its wall
   time and API calls read from the run, then its delete through the same
   workflow.
Fit rule: subrequests under 50% of 10,000, CPU under 50% of 300 s, peak
   heap under 64 MB. Anything over goes back to the Manager with a split
   proposal for just that part.

The spike changes no code on main and leaves no staging resources behind.
**The plan stops at this gate**: a split, if needed, is designed from the
numbers and reviewed before any build.

## Design (if the spike fits)

### Shape

`apps/provisioner`, deployed per env as `oa-<p>-provisioner` (no routes,
`workers_dev: false`, observability logs off like the other platform Workers):

- **Queue consumer** of `oa-<p>-signups` (max batch 1, retries 5, a dead-letter
  queue `oa-<p>-signups-dlq`).
- **Workflow** `ProvisionInstall`, instance id = `signupId`.
- Bindings: platform D1, HOSTS KV, broker and directory registry KV (whatever
  create resolves today), `oa-<p>-releases` R2 (read), BILLING (SS1 tier row),
  `ALERT_EMAIL` / `WELCOME_EMAIL` send_email (Email Sending, from the env's
  onboarded domain, any recipient), Secrets Store `oa-<p>-provision-token` as
  `PROVISION_TOKEN`. No BILLING binding: billing reads a missing row as
  free/active, so create writes nothing to billing.

### The message

`{ signupId }` only (Manager, 2026-10-29). SS4's sign-up service writes the
`signups` row (status `pending`) and the `signup_secret` row in platform D1
first, then enqueues. The owner's email never enters a queue, so the runtime
dead-letter queue (kept) only ever sees an id, and nothing is lost when D1
blips at the consumer: the row is already there. `signupId` is a ULID minted by
SS4 when the sign-up is accepted; `owner_sub` is the Google subject (SS4's
one-per-account key, stored on the row). A message that isn't exactly
`{ signupId: <ULID> }` is acked and logged by category, never retried.

### Idempotency

- Platform D1 migration `0007_signups.sql` (additive; 0006 is SS1's):
  `signups(signup_id TEXT NOT NULL PK, owner_sub TEXT NOT NULL, slug TEXT NOT NULL,
  install_id TEXT UNIQUE, status TEXT NOT NULL CHECK (status IN
  ('pending','queued','waiting_cap','creating','ready','failed')),
  admitted_at INTEGER, welcome_claimed_at INTEGER, welcome_sent_at INTEGER,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`, an
  index on `signups(admitted_at)`, and `signup_secret(signup_id TEXT NOT NULL
  PK, owner_email TEXT NOT NULL)`. Workflows keeps instance params for up to
  30 days, so the email is never a param: SS4 writes it to `signup_secret`,
  the create step reads it, and `done` deletes the row. The email lives only
  in that row and `installs.owner_email` (which create already writes).
  Params are `{ signupId, slug, ownerSub }`, read from the stored row.
- SS4 writes `signups` only as `pending` rows with their `signup_secret`, in
  one D1 batch, then enqueues. Everything after `pending` belongs to the
  provisioner.
- The cap counts admissions, not arrivals: `admitted_at` is set when a row
  leaves `pending` or `waiting_cap` for `queued`, and the cap counts rows
  whose `admitted_at` is in the current UTC day. A promoted `waiting_cap` row
  counts toward the day it is admitted into, so a day never admits more than
  the cap.
- Over the cap (deferred, never failed): the row becomes `waiting_cap`; the
  scheduler re-enqueues `waiting_cap` rows after 00:00 UTC, oldest first. The
  first cap hit of each UTC day sends one operator alert (an abuse or demand
  signal). The cap is config: `SIGNUP_DAILY_CAP`, staging 20, prod 50, parsed
  strictly (`^[1-9][0-9]{0,3}$`); an invalid value retries and logs, never
  defers silently.
- Consumer: read the row. No row: retry (SS4 writes it before enqueueing; the
  runtime DLQ takes the id after the retries). `pending` or `waiting_cap`: one
  conditional `UPDATE signups SET status = 'queued', admitted_at = now WHERE
  signup_id = ? AND status IN ('pending','waiting_cap') AND (SELECT count(*)
  FROM signups WHERE admitted_at >= <UTC day start>) < cap`, else the same row
  to `waiting_cap` (atomic: D1 serializes writes). `queued` or `creating`:
  `PROVISION_INSTALL.create({ id: signupId, params })` from the stored row; an
  "already exists" from Workflows is success. `ready` or `failed`: ack. Ack
  only after the start.
- Sweep (scheduler, every tick): a `pending` row older than 15 minutes, or a
  `queued` row with no Workflow instance, is re-enqueued as `{ signupId }`.
- Workflow `reserve` step: picks the install id once and stores it on the row
  (`install_id` set only when NULL); a retry reads it back. `create` is called
  with that fixed install id, so a rerun resumes the same install.

### Steps

1. `reserve`: the install id as above (the cap was settled atomically by the
   consumer's insert). Output: `{ installId }` only.
2. `sweep`, then `create`: revoke any active `ci-<signupId>` token left by a
   crashed attempt (#848's sweep, verified), then `new WfpProvisioner({ cf,
   env, target, domains, release: r2BindingReleaseReader(env.RELEASES),
   ciOwnerToken: { label: \`ci-${signupId}\` }, ... })
   .create({ installId, slug, ownerEmail, ... })`. Output: `{ appHost }` only.
   Errors are rethrown as a fixed category plus the `ProvisionRefused` message
   (already redacted by create's sensitive set); the step output and error never
   carry params. A lease-held refusal is retryable, with a backoff that
   outlasts `LEASE_MS`; every other `ProvisionRefused` is terminal.
3. `notify`: `UPDATE signups SET welcome_claimed_at = now WHERE signup_id = ?
   AND welcome_claimed_at IS NULL`; only if a row changed, send the one welcome
   email, then set `welcome_sent_at`. At most once: a crash between claim and
   send leaves `welcome_claimed_at` set and `welcome_sent_at` NULL, and the
   scheduler's alerts flag it ("welcome unsent") for the operator.
4. `done`: sweep again, delete `signup_secret`, status `ready`.

A step that exhausts its retries sets status `failed` with a category and
raises the operator alert. There is no automatic re-drive: the operator re-runs
a failed signup with a new CLI command `signup-redrive --signup <id>` (restarts
the same Workflow instance id) or removes a half-made install with the CLI
`delete`. A failed signup counts toward neither the cap nor its slug. The lease
and audit rows are create's own. "Welcome unsent" (claimed, not sent) is one
more alert key in SS1b's scheduler `alerts.ts`.

### Provision changes (small, upstreamed, no fork)

- `ReleaseReader` over an R2 binding (`r2BindingReleaseReader`), next to
  `r2ReleaseReader`, same checks.
- `patDir` becomes optional: required only for the red-line bundle variant (the
  test-hook key) and the laptop PAT path; the ephemeral owner token path never
  touches it.
- `Cf` client built from the Secrets Store token.
- The deploy verify fails if any platform Worker other than the provisioner
  binds `oa-<p>-provision-token`.

### Deploy

A `provisioner` target in #847's `deploy-hosted-platform.yml` after `billing`,
with the same fill-and-verify checks; the queue, DLQ and Secrets Store secret
are created by the deploy script check-first. Prod stays behind
`PROD_UNLOCKED` and the gated Environment.

## Tests

- Message validation, DLQ on bad shape, ack only after reserve and start.
- Idempotency: the same `{ signupId }` twice, a Workflow retry of each step, a crash
  after create before `notify`, a crash mid-create with the lease held: one
  install, one email, no active `ci-<signupId>` token left.
- The daily cap, including concurrent messages at the boundary.
- No email anywhere: a test greps every captured log line, step output, step
  error, alert body and DLQ payload for the owner email.
- workerd: the provisioner's create against fake-cf under pool-workers.
- Red-line additions (step 5 of the self-serve plan): a replayed signup creates
  nothing new; a signup for a slug in use fails cleanly.

## Left to the builder

- Module layout inside `apps/provisioner`, test helpers, retry delays.
- Exact alert subjects and the welcome email's text (plain, no URLs with tokens;
  the owner signs in through the install's own sign-in page).

## Calls made by Platform (check while reading)

The tier step dropped; the email kept out of Workflow params via
`signup_secret` (written by SS4); the atomic cap as a conditional update counting admissions; lease-held as the
only retryable refusal; no automatic re-drive; stacking on #848 and #849.

## Open (for the Manager)

None. Decided 2026-10-29 (Manager): over the cap is deferred; the spike's
real create goes through #848's workflow after it merges; caps staging 20/day
and prod 50/day, in config (`SIGNUP_DAILY_CAP`).

