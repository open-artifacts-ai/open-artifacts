# Client canary

A scheduled check that each real bus client still works end to end
(`.github/workflows/client-canary.yml`, agy S7). It never runs on a pull
request: pull requests keep the fake-client contract tests.

## When it runs

- Nightly at 03:30 UTC, on each client's pinned release.
- Weekly on Monday at 04:30 UTC, on each client's latest release, to catch
  upstream changes before users do.
- By hand: Actions, client-canary, Run workflow (pick pinned or latest).

## Where it runs

On **rl-a** (`https://rl-a.open-artifacts-staging.app`), the staging install
with test hooks that the dashboard's staging e2e uses. Each run signs in a new
member through its session hook (`TEST_HOOKS.session`, as
`apps/dashboard/e2e/staging/rl-a/fixtures.ts` does), named
`t19-canary-<run>-<client>@oa-redline-a.fyi`. That member makes its own token,
then approves the client's machine and the probe's machine (the canary's own
agent) on the real `/bus/approve` page, as a person does. So every run checks
the approval path too. No machine or token is kept between runs.

Every run erases its member again (`TEST_HOOKS.peoplePurge`), with its pages,
token and machines, whether it passed or failed. Each client job has its own
member, so the jobs run side by side.

The canary sends its hook key only to a bare https origin one label under
`open-artifacts-staging.app` that reports test hooks on at `/healthz`. The repo
variables `CANARY_STAGING_URL` and `CANARY_STAGING_TEST_DOMAIN` may point it at
another such install.

rl-a needs the bus feature on (`FEATURES` includes `bus`): without it the
approval page answers 404 and the run fails, saying so.

A local server (`wrangler dev` on the runner) is for development only: set
`CANARY_TARGET=local` or pass `--target local`. It signs in with the dev login
instead of the hook.

## What it checks

One job per client (Claude Code, Codex, OpenCode, Pi; Antigravity comes
later). Each job builds `oa-bus` from the commit, installs the client, connects
it with `oa-bus install`, starts it headless with a cheap model and no prompt,
and checks:

1. **install**: `oa-bus install` connects to the instance and wires the client.
2. **habits**: `oa-bus doctor` says `Habits: on`.
3. **joins at start**: the session is on the agent list before any prompt is
   sent. The roster is read right after launch, and again on each roster
   change the canary's own agent hears, up to a deadline. Only then is the
   first prompt typed in.
4. **page shows as the session**: the session publishes a page and says
   `PUBLISHED <title>` on the bus. The page must be linked, show the client's
   product and this run's token, with no other session on the member's bus.
   The page is tied to the session by that token and by being the only live
   session on a new member, not by comparing agent ids: a page's versions do
   not show the publisher's hub agent id yet.
5. **receives and replies**: a message to it gets an answer.
6. **mid-turn message**: a message sent while a turn is running.
   - Codex and Pi steer: it must land in that same turn.
   - Claude Code and OpenCode have no steer path in the daemon: it must arrive
     at the start of the next turn. Steering them is a product change.
   - A held command that is never released says "timed out" and fails the
     check.

### Bound to this run

Each run has its own id (`CANARY_RUN_ID`, set from the workflow run, else a
random one). It is in the member's address, the token's label and the page
title. The session under test is the one live agent of the client's kind on
the machine this run approved, by its hub agent id. Messages go to that id
only, and a reply counts only when it comes from that id and name and says
exactly the expected words. A session from an earlier run or another client
never counts.

### Versions

Each client's version is recorded as run, and again at the end: a client that
updates itself during the run shows both. Instance-driven `oa-bus` updates are
turned off (the run fails if that does not work), so the `oa-bus` under test is
the one built from the commit. Its version is recorded at the start and the
end too, and the run fails if it changed.

### Waits

No sleeps and no polling timers. Each wait is on a signal with a deadline: a
file event (the held command's release, a log line), a process exit, or a
frame on the canary's own bus socket (a reply, a receipt, a roster change).

### Results and alerts

The job summary has one table per client. When a client fails, the report job
opens ONE issue for that client, labelled `client-canary`, or comments on the
open one, and @-mentions the login in the repo variable `OA_ALERT_GITHUB_LOGIN`
(as the staging smoke alert does). The issue shows each channel (pinned and
latest) and its last result since it opened. It closes only once every channel
has passed since it opened, so a nightly pass never closes a weekly failure. A
job that times out or is cancelled counts as failed.

Text from a client, a log or the hub never reaches a summary, issue or comment
as is: it is one line, capped, with every secret value and token shape
blanked, and made inert (no HTML, markdown, @-mention, #-link or URL). The
issue names the client from `clients.ts`, never from the result file.

### Credentials

Deleted on every way out (a pass, a failure, a timeout, a cancel, SIGINT,
SIGTERM or SIGHUP): the token, the bus home and machine file, the client's
settings, the scratch HOME and the daemon's socket folder. The staging member
is erased; a local run revokes its token and machines. A failed run keeps a
copy of its logs with every secret value and every token shape (`oa_machine_`,
`oa_pat_`, `sk-`, `gh*_`, bearer headers) blanked: in the job, uploaded as
`logs-<client>`. The workflow runs each job with its own temp folder and an
`if: always()` step that runs `run.ts --cleanup` (it erases this run's staging
member again and empties that folder) for a job cut off by its timeout or a
cancel.

## Secrets to add

Under Settings, Secrets and variables, Actions. A missing one turns that
client's run **red** with a line naming the secret, and the report job alerts.
It is never skipped.

| Secret | Used by | Where the value comes from |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode, Pi | An Anthropic API key, console.anthropic.com |
| `OPENAI_API_KEY` | Codex | An OpenAI API key, platform.openai.com |
| `CANARY_RL_A_HOOK_KEY` | every client | rl-a's test hook key: its `TEST_HOOK_KEY`, the same value the staging e2e reads as `REDLINE_RL_A_HOOK_KEY` in open-artifacts-cloud |

The client jobs get only their own model key and the hook key. npm install
gets no secret, and the report job none but its own GitHub token.

Each client uses its cheapest model. To change one, set the repo variable
`CANARY_MODEL_<CLIENT>` (for example `CANARY_MODEL_CODEX`).

## Run it here

Build `oa-bus` first (and the server, for local mode):

    pnpm --filter @open-artifacts/bus build
    pnpm --filter @oa/server build

Then, with no model and no key, the stand-in Pi (`fake-pi.ts`) loads the real
extension that `oa-bus install` writes, against a local server:

    node --experimental-strip-types scripts/canary/run.ts --client pi --fake --target local

`--fake-break steer` makes the stand-in miss the mid-turn message, which turns
that check red. Add `--fake-next-turn` to judge it as a client with no steer
path, which then passes. Pick a `--port` no other server on the machine uses. `--hub http://localhost:<port>` reuses a local server you
already run. Without `--target local` it runs on rl-a and needs
`CANARY_RL_A_HOOK_KEY` in the environment. Everything happens under a scratch home in the
temp folder, never in your own home.
