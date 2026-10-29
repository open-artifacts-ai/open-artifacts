# SS3 Hosted Provisioner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `oa-<p>-provisioner` turns one `oa-<p>-signups` queue message into exactly one hosted install, through a Workflow that runs the existing `WfpProvisioner.create`.

**Architecture:** A Queue consumer records the signup atomically (cap included) and starts a Workflow whose instance id is the signup id. The Workflow's steps are reserve, sweep+create, notify and done. Provision gains three small upstream changes: lazy asset reads, an R2-binding release reader, and an optional `patDir`. Alerts stay in the scheduler (SS1b `stepAlert`), which reads the signup facts the provisioner writes.

**Tech Stack:** TypeScript, Cloudflare Workers (Queues, Workflows, Secrets Store, D1, R2, send_email), `@cloudflare/vitest-plugin` (pool-workers), Vitest, `@oa/provision`.

**Spec:** `docs/superpowers/specs/2026-10-29-ss3-provisioner-design.md` (approved 8921def7). Spike part 1: 212 calls, 288 ms CPU, +24 MB heap per create; the provision index, Ed25519, ALS and node:fs all run under nodejs_compat.

## Global Constraints

- Branch `pl/ss3-provisioner`. Post-M1: push and open a DRAFT PR; never arm or merge. Nothing merges until the freeze lifts.
- Base: `origin/main` + `origin/pl/hosted-ops-ci` (#848, `ciOwnerToken`, `ciTokenSweep`) + `origin/pl/ss1-tier-store` (#849, `platform_state` 0006, scheduler `alerts.ts`), merged in Task 0.
- `ownerEmail` never in a log line, Workflow param, step output, step error, alert text, DLQ payload or D1 row other than `signup_secret` and `installs.owner_email`.
- One signup id gives one install and at most one welcome email.
- Caps: `SIGNUP_DAILY_CAP` var, staging `20`, prod `50`. Over the cap the signup is deferred (`waiting_cap`), never failed.
- Token: Secrets Store secret `oa-<p>-provision-token`, bound only to `oa-<p>-provisioner` as `PROVISION_TOKEN`.
- Provision guards stay unmodified: prod lock, signed record and floor, lease (`LEASE_MS` 30 min), check-first steps, selftest.
- A lease-held `ProvisionRefused` is retryable; every other `ProvisionRefused` is terminal.
- Turning the provisioner on in prod waits for spike part 2: a real staging create and delete through `hosted-ops.yml` after #848 merges.
- No deploys, no Cloudflare or GitHub writes beyond pushing the branch and the draft PR. Never print secrets. No em dashes in comments or copy.
- Before every push: `pnpm -s typecheck`, `pnpm -s exec biome ci .` and the affected tests under `env -i PATH="$PATH" HOME="$HOME"`. Read every exit code and push only when all are 0. Full suites only via `lockf -k /tmp/oa-fullsuite.lock <cmd>`.
- No force-push, no git stash, no `pkill -f`. Commit WIP at checkpoints and push.

## Review Focus

1. A queue message redelivered while its first Workflow is still mid-create: one install, the second start a no-op (Task 5 test `redelivery during create`).
2. Two messages at the cap boundary arriving together: exactly `cap` signups `queued`, the rest `waiting_cap` (Task 5 test `concurrent at the boundary`).
3. A slug already taken by an active install: the signup ends `failed` with category `slug_taken`, no half-made resources, the slug untouched (Task 6 test `slug taken`).
4. A crash after the welcome claim and before the send: no second email on retry, and "welcome unsent" raised (Task 6 test `claim without send`; Task 7 test `welcome unsent alert`).
5. An owner email containing `+` and uppercase: redaction still keeps it out of every captured output (Task 6 test `email never leaks`, with `Owner+Tag@Example.COM`).

---

### Task 0: Base branch

- [ ] **Step 1:** In the `pl/ss3-provisioner` worktree, `git merge origin/pl/hosted-ops-ci` and then `git merge origin/pl/ss1-tier-store` (normal merges, no rebase). Resolve conflicts in `scripts/ops/deploy-platform-worker.sh` and its test by keeping every allowlist entry from both sides.
- [ ] **Step 2:** Run `pnpm -s typecheck`, `pnpm -s exec biome ci .`, and the provision, hosted, scheduler, billing and dispatch tests. Expected: each exit 0.
- [ ] **Step 3:** Commit the merge and push.

### Task 1: A full create inside workerd

**Files:**
- Create: `packages/provision/test/fake-cf-sql.ts` (a `SqlEngine` interface plus a node:sqlite engine)
- Modify: `packages/provision/test/fake-cf.ts` (its D1 goes through `SqlEngine`)
- Create: `apps/provisioner/` skeleton: `package.json`, `tsconfig.json`, `wrangler.test.jsonc` (with `nodejs_compat`), `vitest.config.ts`
- Create: `apps/provisioner/test/d1-engine.ts` (a `SqlEngine` over a Miniflare D1 binding)
- Test: `apps/provisioner/test/workerd-create.test.ts`

**Interfaces:**
- Produces: `interface SqlEngine { exec(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; changes: number }> }`, and `new FakeCf({ now, sql?: (dbName: string) => SqlEngine })`. The default keeps node:sqlite, so the existing provision tests change nothing.

- [ ] **Step 1: Failing test.** `workerd-create.test.ts` "a full create runs in workerd": a FakeCf with D1 engines over Miniflare D1, the same `makeRelease`-style reader (move `makeRelease` and its fixtures to `packages/provision/test/fixtures/release.ts` so both suites import it), and `new WfpProvisioner({...}).create(input)`. Assert the install row is `state: "active"`, both hosts are mapped, and `fake.log.length < 400`.
- [ ] **Step 2:** Run it with `pnpm -C apps/provisioner exec vitest run test/workerd-create.test.ts`. Expected: FAIL (no D1 engine).
- [ ] **Step 3:** Implement the `SqlEngine` split and the D1 engine.
- [ ] **Step 4:** Run the workerd test and the full provision suite. Expected: both PASS, and the provision suite's test count is unchanged.
- [ ] **Step 5:** Commit `test(provision): fake-cf D1 over a SqlEngine; a full create runs in workerd`.

### Task 2: Lazy asset reads (no whole release in memory)

**Files:**
- Modify: `packages/provision/src/release.ts` (`ReleaseReader`)
- Modify: `packages/provision/src/wfp.ts` (`readAssets`, `uploadRelease` and its callers at the three `readAssets` sites)
- Modify: `packages/provision/src/cf.ts` (`assetsUpload`)
- Modify: `packages/provision/src/publish.ts` (`r2ReleaseReader`)
- Test: `packages/provision/test/wfp-create.test.ts` and `packages/provision/test/release-t3b.test.ts`

**Interfaces:**
- Produces: `ReleaseReader.assets(version, variant): Promise<ReleaseAssetEntry[]>`, now the list only (path, size, sha256), and `ReleaseReader.assetBytes(version, variant, path): Promise<Uint8Array>`. `cf.assetsUpload(target, script, manifest: { path: string; size: number; bytes: () => Promise<Uint8Array> }[])` reads bytes only for the files in the bucket it is uploading.
- Rule: every asset's bytes are read once for verification (sha256 and size against the record, the file then dropped), and read again only if Cloudflare asks for it in a bucket. A file whose bytes change between the two reads is refused (`refuse(rec, "assets", ...)`), as today.

- [ ] **Step 1: Failing tests.**
  - "assets are read one at a time": a reader that tracks concurrently held asset bytes; assert the peak is at most one bucket's files.
  - "a file changed between verify and upload is refused": the second `assetBytes` read returns different bytes; expect a `ProvisionRefused` matching `/assets/`.
  - The existing asset tests still pass.
- [ ] **Step 2:** Run `pnpm -C packages/provision exec vitest run test/wfp-create.test.ts -t "assets"`. Expected: the two new tests FAIL.
- [ ] **Step 3:** Implement the interface change in the reader, the three call sites and `assetsUpload`.
- [ ] **Step 4:** Run the full provision suite, the hosted CLI suite and the Task 1 workerd test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(provision): assets are verified and uploaded one bucket at a time`.

### Task 3: Provision options for a Worker host

**Files:**
- Modify: `packages/provision/src/publish.ts` (add `r2BindingReleaseReader`)
- Modify: `packages/provision/src/wfp.ts` (`WfpOptions.patDir` optional; the provisioner token label)
- Test: `packages/provision/test/wfp-create.test.ts`, plus `apps/provisioner/test/workerd-create.test.ts`

**Interfaces:**
- Produces: `r2BindingReleaseReader(bucket: R2Bucket, env: Env): ReleaseReader`, with the same keys and checks as `r2ReleaseReader`.
- Produces: `WfpOptions.patDir?: string`. It is required, as `ProvisionRefused("patDir is required ...")`, only for the redline variant (the test-hook key) and when `ciOwnerToken` is absent.
- Produces: `PROVISIONER_TOKEN_LABEL_RE = /^ss-[0-9A-HJKMNP-TV-Z]{26}$/`. `ciOwnerToken.label` and `ciTokenSweep(id, label)` accept a label matching `CI_TOKEN_LABEL_RE` or this one. Flag this for the Manager's security re-check, since it widens #848's approved regex.

- [ ] **Step 1: Failing tests.**
  - "r2BindingReleaseReader reads what r2ReleaseReader reads": the same seeded release, compared field by field.
  - "no patDir with ciOwnerToken": create succeeds and nothing is written under any directory.
  - "redline variant without patDir is refused".
  - "ss-<ULID> labels mint and sweep; other labels are refused" (`ss-short`, `ss-` followed by 26 lowercase characters, `ci-abc`).
  - "a sweep revokes only its own exact label": with active tokens `ci-123`, `ci-1234`, `ss-<A>` and `ss-<B>`, `ciTokenSweep(id, "ci-123")` revokes only `ci-123`, and `ciTokenSweep(id, "ss-<A>")` revokes only `ss-<A>`. A sweep never matches by prefix or pattern (Manager, 2026-10-29).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the provision, hosted and workerd tests. Expected: PASS.
- [ ] **Step 5:** Mutation-checks: accept any label in `ciTokenSweep`, and match labels by prefix in the sweep; confirm a test fails for each. Then commit `feat(provision): R2-binding reader, optional patDir, provisioner token labels`.

### Task 4: Platform migration 0007

**Files:**
- Create: `apps/platform-db/migrations/0007_signups.sql`
- Test: `packages/provision/test/platform-migrations.test.ts`

The schema is the spec's, verbatim:
- `signups(signup_id TEXT NOT NULL PK, owner_sub TEXT NOT NULL, slug TEXT NOT NULL, install_id TEXT UNIQUE, status TEXT NOT NULL CHECK (status IN ('queued','waiting_cap','creating','ready','failed')), welcome_claimed_at INTEGER, welcome_sent_at INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
- `signup_secret(signup_id TEXT NOT NULL PRIMARY KEY, owner_email TEXT NOT NULL)`;
- an index on `signups(created_at)`.
- Everything uses `CREATE ... IF NOT EXISTS`. The migration is additive only.

- [ ] **Step 1:** Failing test "0007 is additive and applies after 0006": the migration contains no ALTER, DROP, UPDATE or DELETE; it applies cleanly on top of 0001-0006 twice; and both tables exist.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write the SQL.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform-db): 0007 signups and signup_secret`.

### Task 5: The queue consumer

**Files:**
- Create: `apps/provisioner/wrangler.jsonc`, with no top-level name or main, and env blocks `oa-s-provisioner` / `oa-p-provisioner`. It has:
  - `nodejs_compat`;
  - `limits.cpu_ms` `300000`;
  - `workers_dev` false, no routes, logs off;
  - a queue consumer of `oa-<p>-signups` with `max_batch_size` 1, `max_retries` 5 and dead-letter queue `oa-<p>-signups-dlq`;
  - the workflow `ProvisionInstall` bound as `PROVISION_INSTALL`;
  - bindings `PLATFORM_DB`, `HOSTS`, `BROKER_REGISTRY`, `DIRECTORY_REGISTRY` and `RELEASES` (R2 `oa-<p>-releases`);
  - `WELCOME_EMAIL` as send_email;
  - Secrets Store `PROVISION_TOKEN` → `oa-<p>-provision-token`;
  - vars `SIGNUP_DAILY_CAP` (`{{SIGNUP_DAILY_CAP_STAGING}}` / `_PROD`), `WELCOME_FROM` and `ACCOUNT_ID`.
- Create: `apps/provisioner/src/message.ts`, `apps/provisioner/src/consumer.ts` and `apps/provisioner/src/index.ts`
- Test: `apps/provisioner/test/consumer.test.ts`, `apps/provisioner/test/node/config.test.ts`

**Interfaces:**
- Produces: `parseSignup(body: unknown): SignupMessage | null`, where `SignupMessage = { signupId: string /* ULID */; slug: string; ownerSub: string; ownerEmail: string; tier: "free" }`. The slug is validated with provision's slug rule, and the sub with `/^[0-9]{1,255}$/`.
- Produces: `recordSignup(db: D1Database, m: SignupMessage, cap: number, now: number): Promise<"queued" | "waiting_cap" | "exists">`, written as one conditional `INSERT ... SELECT ... WHERE (SELECT count(*) FROM signups WHERE created_at >= <UTC day start> AND status != 'failed') < ?cap`. If that inserts nothing, a second statement inserts `waiting_cap`. Both use `ON CONFLICT (signup_id) DO NOTHING`. The email goes to `signup_secret` with `INSERT OR IGNORE`.
- Produces: the Workflow params `{ signupId, slug, ownerSub }`.

- [ ] **Step 1: Failing tests.**
  - "bad shapes go to the DLQ with the signup id only": the message is retried to DLQ, and no D1 row is written.
  - "queued: one row, one secret row, one workflow start, then ack".
  - "redelivery during create: recordSignup says exists, the start returns 'already exists', ack, still one row".
  - "over the cap: waiting_cap, no workflow start, ack".
  - "concurrent at the boundary": cap 2, five messages at once, exactly two `queued`.
  - "workflow params carry no email".
  - Config test: both env blocks have the queue, DLQ, workflow and Secrets Store binding, and no other platform Worker's config binds `oa-<p>-provision-token`. It checks every `apps/*/wrangler.jsonc`.
- [ ] **Step 2:** Run `pnpm -C apps/provisioner test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Mutation-check: replace the conditional insert with a count followed by an insert, and confirm "concurrent at the boundary" fails. Then commit `feat(provisioner): the signups consumer, cap and idempotent start`.

### Task 6: The ProvisionInstall Workflow

**Files:**
- Create: `apps/provisioner/src/workflow.ts`, `apps/provisioner/src/errors.ts` and `apps/provisioner/src/welcome.ts`
- Test: `apps/provisioner/test/workflow.test.ts`

**Interfaces:**
- Consumes: `r2BindingReleaseReader`, `ciOwnerToken: { label: \`ss-${signupId}\` }` and `ciTokenSweep` (Task 3); the FakeCf D1 engine (Task 1).
- Produces: `class ProvisionInstall extends WorkflowEntrypoint<Env, { signupId: string; slug: string; ownerSub: string }>`, with steps named exactly `reserve`, `sweep`, `create`, `notify` and `done`.
- Produces: `classify(e: unknown): { retryable: boolean; category: string }`. The categories are `lease_held` (retryable), `slug_taken`, `refused`, `cf_error` (retryable) and `internal`. A step's thrown error is `new Error(category)` plus, only for `refused`, the `ProvisionRefused` message. That message is already redacted by create's sensitive set, and is redacted again with this signup's email before it is thrown.
- Retries: the `create` step uses `retries: { limit: 6, delay: "10 minutes", backoff: "exponential" }`, so the total outlasts `LEASE_MS`. A non-retryable category is thrown as `NonRetryableError`.
- `notify`: the claim is `UPDATE signups SET welcome_claimed_at = ? WHERE signup_id = ? AND welcome_claimed_at IS NULL`. The email is sent only when `changes === 1`; then `welcome_sent_at` is set. The welcome text is plain and names the app host; it contains no tokens.
- `done`: sweep again, `DELETE FROM signup_secret`, status `ready`. After the retries run out, the signup is `failed` with `error = category`.

- [ ] **Step 1: Failing tests.** Use the Workflows test API in pool-workers, with FakeCf behind `fetch`.
  - "one signup, one install, one email".
  - "a retry of each step changes nothing".
  - "crash mid-create with the lease held: retried, then one install, no active ss- token".
  - "claim without send: the retry sends nothing".
  - "slug taken: failed slug_taken, nothing created".
  - "email never leaks": with owner `Owner+Tag@Example.COM`, grep every console line, step output, step error and D1 row except `signup_secret` and `installs.owner_email`, and find none.
  - "done deletes signup_secret".
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Mutation-checks: drop the `IS NULL` claim guard (the email test fails); drop the sweep step (the crash test fails); log the params (the leak test fails). Then commit `feat(provisioner): the ProvisionInstall workflow`.

### Task 7: Scheduler alerts and the cap re-enqueue

**Files:**
- Modify: `apps/scheduler/src/alerts.ts` (three `Alert`s), `apps/scheduler/src/index.ts` (the tick) and `apps/scheduler/wrangler.jsonc` (a `SIGNUPS` queue producer binding)
- Create: `apps/scheduler/src/signups.ts`
- Test: `apps/scheduler/test/signups.test.ts`

**Interfaces:**
- Consumes: `stepAlert(env, alert, condition, now, opts)` (SS1b).
- Produces: the alerts `signupCapAlert(env)` (the condition is true while any `waiting_cap` row exists today; it opens once per UTC day), `signupFailedAlert(env)` (a `failed` row in the last 24 h) and `welcomeUnsentAlert(env)` (a row with `welcome_claimed_at` set, `welcome_sent_at` NULL, older than 10 minutes). The alert text carries counts and signup ids only.
- Produces: `requeueWaiting(env, now)`. After 00:00 UTC it sends `waiting_cap` rows, oldest first, as signup messages; each message's email comes from `signup_secret`. It sends at most that day's free cap, and moves each sent row back to `queued`.

- [ ] **Step 1: Failing tests.** The three alerts open and clear; "cap alert opens once a day"; "requeue respects the cap and order"; and "alert text has no email".
- [ ] **Step 2:** Run `pnpm -C apps/scheduler test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scheduler): signup alerts and the waiting_cap re-enqueue`.

### Task 8: CLI `signup-redrive` and the deploy wrapper

**Files:**
- Modify: `scripts/hosted/src/cli.ts` (the `signup-redrive --env <e> --signup <ULID>` command, which restarts the Workflow instance through the API with the provisioning token; laptop or CI, like the other commands) and `scripts/hosted/src/ci-args.ts` (the op allowlist)
- Modify: `scripts/ops/deploy-platform-worker.sh`. Its allowlist gains `provisioner`, with fills `SIGNUP_DAILY_CAP` (`^[1-9][0-9]{0,3}$`), `WELCOME_FROM` (the email pattern) and the registry and DB ids (the uuid and id patterns).
- Test: `scripts/hosted/test/cli.test.ts`, `scripts/ops/deploy-platform-worker.test.ts`

- [ ] **Step 1: Failing tests.**
  - "redrive restarts only a failed signup".
  - "redrive refuses a non-ULID".
  - "the wrapper fills and verifies provisioner placeholders".
  - "a provisioner config binding another Worker's secret is refused".
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit `feat(hosted): signup-redrive; provisioner deploy fills`.

### Task 9: Red-line cases and docs

**Files:**
- Modify: `tests/redline` (two cases marked staging-only until the provisioner is deployed: "a replayed signup creates nothing new" and "a signup for a taken slug fails cleanly")
- Modify: `docs/ops/hosted.md` (the provisioner section: queue, Workflow, cap, redrive, alerts, and the prod enable gate)
- Note in the PR body: the deploy target lands in #847 after the freeze, ordered `billing`, `provisioner`, `dispatch`.

- [ ] **Step 1:** Add the two cases. They report `unproven-live` until deployed and never count as a pass.
- [ ] **Step 2:** Run `pnpm -C tests/redline test`. Expected: exit 0, with both new cases listed.
- [ ] **Step 3:** Write the docs.
- [ ] **Step 4:** Run the affected suites, typecheck and biome. Expected: every exit code 0.
- [ ] **Step 5:** Commit, push, and open a DRAFT PR titled `feat(provisioner): self-serve step 3, the hosted provisioner (draft, post-freeze)`.
