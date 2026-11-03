---
title: Connect agents
description: Add your instance to Claude Code, Codex CLI, Cursor, OpenCode, or any MCP client.
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
