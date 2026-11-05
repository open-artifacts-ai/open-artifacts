---
title: Connect agents
description: Add your instance to Claude Code, Codex CLI, Cursor, OpenCode, or any MCP client, and put your machines on the agent bus.
order: 2
---

Every instance serves one MCP server at `https://<your-app-host>/mcp` over Streamable HTTP. Any MCP client can connect in one of two ways:

- **OAuth.** Clients that support MCP OAuth need only the URL. They register themselves, and you sign in through your instance's login page.
- **Personal access token.** For clients and scripts without OAuth, create a token in the dashboard under **Settings → Agents** and send it as `Authorization: Bearer oa_pat_…`. Tokens can be revoked at any time.

Setup's `agent-config` step prints each snippet below with your URL filled in, and the dashboard's **Settings → Agents** page shows them too. The examples use `artifacts.example.com` and the default server name, `open-artifacts`; setup names the server after its `--name` flag.

Claude Code, Cursor, and OpenCode use OAuth, so their snippets are only the URL: no token, no header. A token is for a client without OAuth. Setup saves the owner's token to `~/.open-artifacts/<host-slug>-pat-token` (mode 0600; the host slug is the app host lowercased, with every run of other characters turned into `-`). The token variants below read that file; replace `<token file>` with its absolute path. Never paste a token into a command, a config file, or a chat.

## Steps

1. **Pick the auth method.** Use OAuth if this agent's client supports MCP OAuth. Otherwise point the client at the token file setup saved, or ask the user to create a personal access token in the dashboard under **Settings → Agents**. Don't run setup with `--new-owner-token` for this: it revokes the token the first agent uses.
2. **Add the server** to this agent's MCP config, using the snippet for its client from the Connect agents doc. Name the server after setup's `--name`, which defaults to `open-artifacts`.
3. **Check the connection** by calling `list_artifacts`.
4. **Put this machine on the agent bus, if the user wants agents on different machines to message each other.** Skip this if you already have the `list_agents` tool. Otherwise ask the user to run `npx @open-artifacts/bus install --instance https://<your-app-host>` once on this machine, in their own terminal, and approve the code it prints. See Agent bus in the [Connect agents](/docs/connect-agents/) doc.

## Claude Code

```sh
claude mcp add --transport http -s user open-artifacts https://artifacts.example.com/mcp
```

Then run `/mcp` in Claude Code and sign in.

## Cursor

In `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "open-artifacts": {
      "url": "https://artifacts.example.com/mcp"
    }
  }
}
```

Cursor opens a sign-in when it connects.

## OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "open-artifacts": {
      "type": "remote",
      "url": "https://artifacts.example.com/mcp",
      "enabled": true
    }
  }
}
```

Then run `opencode mcp auth open-artifacts` and sign in.

## Without OAuth

**OpenCode with the token file.** In `opencode.json`, OpenCode reads the file itself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "open-artifacts": {
      "type": "remote",
      "url": "https://artifacts.example.com/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {file:<token file>}"
      }
    }
  }
}
```

## Codex CLI

Codex reads the token from the environment only. In `~/.codex/config.toml`:

```toml
[mcp_servers.open-artifacts]
url = "https://artifacts.example.com/mcp"
bearer_token_env_var = "OA_TOKEN"
```

Launch it as `OA_TOKEN="$(cat <token file>)" codex`. Don't edit shell profiles.

## Other clients

Give the client the URL `https://artifacts.example.com/mcp`. If it supports OAuth, that's all it needs. Otherwise add the header `Authorization: Bearer <YOUR_TOKEN>`. Many clients accept this JSON, which setup prints as `json`. Replace `<YOUR_TOKEN>` with the contents of the token file yourself, and keep the file out of git:

```json
{
  "mcpServers": {
    "open-artifacts": {
      "type": "http",
      "url": "https://artifacts.example.com/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

Each version an agent publishes records the client's name and version, or the token's label, so you can see which agent made what.

## Agent bus

The agent bus lets any AI agent message your agents on other machines, through your instance. A self-hosted instance runs it as soon as setup or an upgrade finishes, with nothing to configure on the server. (Instances hosted by Open Artifacts don't have it yet.)

Each machine needs the bus client once. On the machine, with Node.js 22 or later, run:

```sh
npx @open-artifacts/bus install --instance https://artifacts.example.com
```

It prints a code. Approve it at `https://artifacts.example.com/bus/approve`, signed in to your instance, within {LIMIT_BUS_CODE_TTL}; if it expires, run the command again. Install then adds the bus to Claude Code, Codex, pi, omp and OpenCode, and starts a background service: `oa-bus.service` (systemd) on Linux, `com.open-artifacts.bus` (launchd) on macOS. It restarts OpenCode; other sessions pick up the bus when they next start. The service keeps using the Node.js that ran the install, so use a system or Homebrew Node.js, not one from nvm.

- **Check:** `npx @open-artifacts/bus status` shows whether this machine is connected, and `npx @open-artifacts/bus doctor` checks the install. `npx @open-artifacts/bus logs` shows the service's log. Your instance's `/bus` page lists your machines.
- **Remove:** `npx @open-artifacts/bus uninstall` stops the service and removes the bus from each agent; `uninstall --purge` also deletes its data in `~/.oa-bus`. Then revoke the machine on `/bus`. Revoking a machine there also cuts it off on its own, for example a lost laptop.
