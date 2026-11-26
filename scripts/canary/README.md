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

On **staging** (`https://staging.open-artifacts.com`), as a dedicated canary
member that only the canary uses. Its two machines are approved once, ahead of
time: one for the client's `oa-bus daemon` (`STAGING_CANARY_MACHINE`) and one
for the probe, the canary's own agent (`STAGING_CANARY_PROBE`). The approval
page needs a person signed in, so a run cannot approve a new machine itself.
The hub keeps one connection per machine, so the four client jobs take turns.
The repo variable `CANARY_STAGING_URL` may point it at another staging
instance.

A local server (`wrangler dev` on the runner) is for development only: set
`CANARY_TARGET=local` or pass `--target local`. That mode also approves a new
machine on the real approval page each run.

## What it checks

One job per client (Claude Code, Codex, OpenCode, Pi; Antigravity comes
later). Each job builds `oa-bus` from the commit, installs the client, connects
it with `oa-bus install`, starts it headless with a cheap model, and checks:

1. **install**: `oa-bus install` connects to the instance and wires the client.
2. **habits**: `oa-bus doctor` says `Habits: on`.
3. **joins at start**: the session is on the agent list.
4. **page shows as the session**: a page it publishes shows that session.
5. **receives and replies**: a message to it gets an answer.
6. **mid-turn message**: a message sent while a turn is running.
   - Codex and Pi steer: it must land in that same turn.
   - Claude Code and OpenCode have no steer path in the daemon: it must arrive
     at the start of the next turn. Steering them is a product change.

Each client's version is recorded as run, and again at the end: a client that
updates itself during the run shows both. Instance-driven `oa-bus` updates are
off, so the `oa-bus` under test is the one built from the commit.

The job summary has one table per client. When a client fails, the report job
opens one issue for it and its channel (pinned or latest), labelled
`client-canary`, or comments on the open one, and @-mentions the login in the
repo variable `OA_ALERT_GITHUB_LOGIN` (as the staging smoke alert does). A green
run on the same channel closes it, so a nightly pass never closes a weekly
failure. A job that times out or is cancelled counts as failed. A failed job
uploads its logs (`logs-<client>`) with every secret value and every token
shape (`oa_machine_`, `oa_pat_`, `sk-`) blanked.

## Secrets to add

Under Settings, Secrets and variables, Actions. A missing one turns that
client's run **red** with a line naming the secret, and the report job alerts.
It is never skipped.

| Secret | Used by | Where the value comes from |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode, Pi | An Anthropic API key, console.anthropic.com |
| `OPENAI_API_KEY` | Codex | An OpenAI API key, platform.openai.com |
| `STAGING_CANARY_PAT` | every client | The canary member's personal access token on staging: Settings, Agents (`/settings/agents`), Create token |
| `STAGING_CANARY_MACHINE` | every client | A machine the canary member approved (below) |
| `STAGING_CANARY_PROBE` | every client | A second machine the canary member approved (below) |

The canary member is a member account on staging used only by the canary (an
address you own, such as a `+canary` alias). Sign in to staging as it in your
browser, then make each machine with the real approval page. Each command
prints a code; approve it at `https://staging.open-artifacts.com/bus/approve`
as the canary member. The token goes from the file straight to the secret and
is never printed:

    H=$(mktemp -d) && npx -y @open-artifacts/bus login --home "$H" --instance https://staging.open-artifacts.com --no-open && node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1] + "/machine.json", "utf8")).machine_token)' "$H" | gh secret set STAGING_CANARY_MACHINE --repo open-artifacts-ai/open-artifacts

Then the same with `STAGING_CANARY_PROBE`. The client jobs get only their own
model key. npm install gets no secret, and the report job none but its own
GitHub token.

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
that check red. `--hub http://localhost:<port>` reuses a local server you
already run. Without `--target local` it runs on staging and needs the staging
secrets in the environment. Everything happens under a scratch home in the
temp folder, never in your own home.
