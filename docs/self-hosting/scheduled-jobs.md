# Scheduled jobs (cron trigger)

A self-hosted install has one cron trigger, `*/2 * * * *` (every 2 minutes). Workers Free allows 5 cron triggers per account, so one per install leaves room for others. Code: `apps/server/src/cron.ts`.

- **Every tick** re-queues search indexing and thumbnail jobs a publish lost: a couple of indexed reads when there is nothing to do.
- **The daily work** (trash purge, upload and sign-in code sweeps, the release check, audit retention, the directory sync kick) runs on the first tick from 03:17 up to 03:30 UTC that claims the UTC day, so a missed tick doesn't skip a day. Each run logs `cron_daily_ran` with the `day` and `via` (`slot` for the tick, `daily` for the older trigger).
- **The older daily trigger**, `17 3 * * *`, still works: an install that has it, alone or with the 2-minute trigger, runs the daily work once a day. Both triggers claim the same day, so the order they fire in doesn't matter.

## Rolling back below this release

Releases before the one-trigger cron treat every non-system cron as the daily one. On the 2-minute trigger they would run the daily work every 2 minutes, including a GitHub release check 720 times a day.

**A rollback to an older release must restore the `17 3 * * *` trigger** (and drop `*/2 * * * *`). Setup does this for you when it deploys the older release. If you roll back another way (redeploying an old build, or the Cloudflare dashboard's rollback, which keeps the current triggers), set the trigger yourself under the Worker's **Settings → Trigger events** in the Cloudflare dashboard.
