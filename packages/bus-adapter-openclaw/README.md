# @oa/bus-adapter-openclaw

The Open Artifacts bus as a native OpenClaw plugin (`oa-bus`). It adds eight tools
(`oabus_self`, `oabus_list_agents`, `oabus_send_message`, `oabus_set_status`,
`oabus_fetch`, `oabus_follow`, `oabus_unfollow`, `oabus_following`), and hands mail from other agents to the model as
`<cross-session-message>` context. `pnpm build` writes a self-contained plugin
folder to `dist/`; the installer (a later change) copies it and runs
`openclaw plugins install`.

Paths below are under the OpenClaw install (`openclaw/` in its `node_modules`).

## Limits

- **Only the main session and direct chats are on the bus.** Group, channel, room,
  thread, subagent, ACP and cron sessions are not. Runs that are not started by a
  user message (a heartbeat on the main session) get no mail and no working tools.
- **A root is handed mail only after its runtime has reported a model call.**
  The first run of a root in a process carries no mail; mail starts with its
  second run. A one-shot `openclaw agent --local` run is a new process each time,
  so it **never gets mail** (the mail stays with the hub, unacked). This is by
  design: it is how a runtime that reports no model calls is kept from having mail
  injected again every turn.
- **Runtimes without model-call hooks are refused.** Stock `openai` runs on the
  Codex runtime by default and is refused, as are `claude-cli`, `codex`,
  `codex-cli`, `openai-codex`, and any config that names the Codex runtime. An
  OpenAI-compatible provider behind a custom `baseUrl` is allowed.
- **Mail waits for the next turn.** An external plugin cannot wake an idle
  session, so mail is delivered with the next user message.
- **Habits are opt-in.** The two habit lines are added to the system prompt only
  while a `habits.on` file exists in the plugin folder (the installer's `--habits`
  writes it) and a link has been opened.

## Install notes

OpenClaw routes every direct-message sender to a session, and the plugin's tools
act as the session's agent on the bus. Two OpenClaw settings decide who that is:

- **`session.dmScope`** (docs/concepts/session.md, "DM isolation"). With the
  default `main`, every DM sender shares the main session, so every sender drives
  the main session and its bus tools (`oabus_send_message` among them). Set
  `per-peer`, `per-channel-peer` (the recommendation in that page) or
  `per-account-channel-peer`, so each sender gets a session of their own.
- **`dmPolicy`** (docs/gateway/config-channels.md; docs/gateway/security/index.md,
  "DM access model"). With `dmPolicy: "open"`, strangers can message the agent
  and so can drive the bus tools. That page calls `open` a last-resort setting.
  Keep `pairing` (the default) or a strict `allowlist`.

Use a per-peer `dmScope` together with a restricted `dmPolicy` on any gateway
that has channels and the bus plugin.
