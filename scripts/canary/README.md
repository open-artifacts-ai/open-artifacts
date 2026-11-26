# Client canary

A scheduled check that each real bus client still works end to end
(`.github/workflows/client-canary.yml`, agy S7). It never runs on a pull
request: pull requests keep the fake-client contract tests.

## When it runs

- Nightly at 03:30 UTC, on each client's pinned release.
- Weekly on Monday at 04:30 UTC, on each client's latest release, to catch
  upstream changes before users do.
- By hand: Actions, client-canary, Run workflow (pick pinned or latest).

## What it checks

One job per client (Claude Code, Codex, OpenCode, Pi; Antigravity comes
later). Each job starts a local Open Artifacts server on the runner
(`wrangler dev`, no staging), builds `oa-bus` from the commit, installs the
client, connects it with `oa-bus install` (approved on the real approval page),
starts it headless with a cheap model, and checks:

1. **install**: `oa-bus install` is approved and wires the client.
2. **habits**: `oa-bus doctor` says `Habits: on`.
3. **joins at start**: the session is on the agent list.
4. **page shows as the session**: a page it publishes shows that session.
5. **receives and replies**: a message to it gets an answer.
6. **mid-turn message**: a message sent during a turn reaches that same turn
   (Codex and Pi; the others take it in their next turn, so it is skipped).

The job summary has one table per client. When a client fails, the report job
opens one issue for it, labelled `client-canary`, or comments on the open one.
A green run closes it.

## Secrets to add

Only model API keys. Add them under Settings, Secrets and variables, Actions:

| Secret | Used by |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude Code, OpenCode, Pi |
| `OPENAI_API_KEY` | Codex |

A client whose key is missing is skipped with a line saying which secret to
add. Its job stays green.

Each client uses its cheapest model. To change one, set the repo variable
`CANARY_MODEL_<CLIENT>` (for example `CANARY_MODEL_CODEX`).

## Run it here

Build the server and `oa-bus` first:

    pnpm --filter @oa/server build
    pnpm --filter @open-artifacts/bus build

Then, with no model and no key, the stand-in Pi (`fake-pi.ts`) loads the real
extension that `oa-bus install` writes:

    node --experimental-strip-types scripts/canary/run.ts --client pi --fake

`--fake-break steer` makes the stand-in miss the mid-turn message, which turns
that check red. `--hub http://localhost:<port>` reuses a server you already
run. Everything happens under a scratch home in the temp folder, never in your
own home.
