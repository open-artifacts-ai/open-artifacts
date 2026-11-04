# Hosted alerts

Each alert email names its key. Find the key below. Most alerts clear on their own, and the email says so when they do. An open alert sends a reminder every 24 hours (`signin_refused_burst` excepted). The rules come from `apps/scheduler/src/provapi/alerts.ts` and `packages/shared/src/provisioning/alerts.ts`.

Two rules hold for every alert:

- **Forward only** (#1106). Never revert or roll back. A failed upgrade stays on the new version and halts the fleet. The fix is a new release. The D1 Time Travel bookmark from MIG-2 (`upgrade.restore_point`) is a disaster record, not a recovery step. It is used only for a migration that destroyed data, and only with the user's yes.
- **Admin writes** (suspend, upgrade, retry, cancel, purge, discard, resend and the rest) are made only by the Manager session, each with the user's explicit yes. Where an action below is a write, ask the Manager.

## signin_refused_burst

5 or more admin sign-ins were refused within 10 minutes. Clears on its own once a 10-minute window has fewer. At most one email an hour, and no clear email. Nothing to do. If it comes back for hours, tell the user.

## admin_unknown_sub

A Google account that isn't on the admin list tried to sign in. Clears on its own 24 hours after the last try. Nothing to do, unless it was a real admin: then the user adds that account.

## job_failed

A job failed in the last 24 hours, and no later job on that install finished. Clears on its own after 24 hours, or once a later job on the install finishes. Read the job's code on the admin job page.

- A code that says it will retry (`lease_held`, `cf_error`, `token_invalid`): the Manager retries it, with the user's yes.
- `upgrade_rolled_back`: only on older jobs, from before upgrades stopped reverting. Ship a fix as a new release.
- `copy_key_left`: see the next section. It stays open until the key is gone.
- Anything else: a bug. Ship a fix as a new release.

### copy_key_left

An OAuth copy job couldn't delete `OAUTH_COPY_KEY` from the install. The job rotated it to a value nobody holds, so the route is closed in practice. This one never clears on its own. The Manager deletes the `OAUTH_COPY_KEY` secret on the install's `oa-<s|p>-<id>` script, with the user's yes. The next upgrade or OAuth store change on that install sees it gone and clears the alert.

## job_retrying

An open job is on its 3rd attempt or later. Clears on its own when the job finishes or fails. Nothing to do. If it then fails, `job_failed` opens.

## job_stuck

An open job hasn't changed for 2 hours and no retry is due. Clears when the job moves. A dead Workflow run is settled by the sweep on its own, so a stuck job is one whose run is alive but not moving: a bug. The Manager cancels it, with the user's yes, and the fix ships as a new release.

## prod_dirty

An install's render failed `verify_clean`, so it was paused. Clears once the install is purged or discarded. The Manager purges or discards it, with the user's yes. The fix ships as a new release.

## prodclean_failed

The latest hourly prod-clean report failed. The email names the install and the detail. Clears on its own when a later report passes. If it stays open, tell the user: something on that install isn't clean.

## upgrade_incomplete

An upgrade failed, and the install stays on the new version (forward only). It may serve with errors until the fix lands. Clears once a later upgrade, purge or discard of that install finishes. Ship the fix as a new release. A fleet upgrade's install gets one automatic try at the next release. Any other install: the Manager upgrades it, with the user's yes.

## unreachable_after_route

An install failed its hourly health check right after create or retry routed it. Clears on its own when a later check passes. If it stays open past the next hourly check, it's a bug in create: ship a fix as a new release.

## purge_stuck

A purge failed 3 times, and the scheduler stopped retrying it. Never clears on its own. The Manager retries the purge, then, if the directory revoke is what fails, purges with `skipDirectoryRevoke` and a reason. Each is a write with the user's yes.

## welcome_unsent

A welcome email was owed or claimed over 15 minutes ago and never marked sent. Clears once it is marked sent. Check the send log first. Only if it never went out, the Manager sends it from the admin panel, with the user's yes.

## signup_cap

Today's self-serve signup cap (`SIGNUP_DAILY_CAP`) was reached. New signups wait. Clears on its own at 00:00 UTC. Nothing to do, unless the user wants a higher cap.

## oauth_register_flood

More than 500 MCP clients registered today (UTC). Clears on its own at 00:00 UTC. Nothing to do if it happens once. If it repeats, tell the user: it may be abuse.

## token_expiring

The provisioner's Cloudflare token expires within 30 days. In its last 5 days, create, upgrade, var changes and Turnstile rotation are refused. Clears once the token is rolled. The user rolls it (dashboard > My Profile > API Tokens > Roll) and pastes it into Secrets Store as `oa-<p>-provision-token`.

## token_invalid

The provisioner's Cloudflare token is invalid or expired. Jobs that need it retry, then fail. Clears on its own once a valid token is in place. The user rolls it, as for `token_expiring`.

## fleet_halted

The fleet rollout stopped. No install is upgraded to a halted version, and the fleet never rolls one back. It clears on its own once a new release ships and its canary soaks. A halt on an older version stays on the alert for 6 hours. The email lists a code per problem:

- `fleet_halt`: upgraded installs failed two health probes of this version on separate ticks. Ship a fix as a new release. Its rollout starts again from the canary.
- A job code (usually `upgrade_incomplete`): a fleet upgrade failed, and that install stays on the new version. Ship a fix as a new release. `upgrade_rolled_back` shows only on older jobs.
- `migration_held` (canary only): the release has a migration that can lose data. A person reads the migration. If it is safe, the Manager upgrades the canary with `nonAdditive: true`, with the user's yes. If not, fix the migration in a new release. On any other install, `migration_held` shows in `version_skew` instead.
- `canary_blocked`: the canary (`FLEET_CANARY`) hasn't soaked on the release by 30 minutes past its soak (`FLEET_SOAK_MIN`: 45 minutes in all on staging, 90 on prod), so nothing else moved. Check the canary on the admin panel. If it is suspended, paused, unhealthy or busy, that is the cause. A bug ships as a new release.
- `no_target`: the scheduler has no stable release tag, so nothing can move. It was deployed without one. The next release's deploy sets it.
- `bad_soak`: the scheduler's `FLEET_SOAK_MIN` isn't a whole number of minutes from 1 to 1440, so nothing moves. Fix it in `apps/scheduler/wrangler.jsonc` and ship a release.

## version_skew

An install has been off the platform's release for 6 hours. Clears on its own once it reaches the release. Usually `fleet_halted` explains it. If not, check that install on the admin panel: a suspended, paused or `migration_held` install stays behind until someone acts. Each fix is a write the Manager makes, with the user's yes.
