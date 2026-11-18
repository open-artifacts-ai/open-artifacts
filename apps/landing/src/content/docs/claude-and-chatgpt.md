---
title: Use Open Artifacts from Claude or ChatGPT
description: Connect Claude Desktop, a Claude chat or ChatGPT to your instance, and what each one can and can't do.
order: 9
---

You don't need a terminal to use Open Artifacts. Pick the app you already use. Each section below gives the steps and says plainly what that app can and can't do.

Your instance's address is the one in your browser when you use Open Artifacts, for example `https://artifacts.example.com`. The apps below need it with `/mcp` at the end, for example `https://artifacts.example.com/mcp`.

## What each app can do

| | Claude Desktop, Code tab | A Claude chat | ChatGPT |
| --- | --- | --- | --- |
| Publish and update pages | Yes | Yes | Depends on your plan |
| Read pages and comments | Yes | Yes | Yes |
| Comment and post asks | Yes | Yes | Depends on your plan |
| Hear your comments and answers on its own | Yes | No | No |
| Talk to your other agents | Yes | No | No |

The last two rows need the bus. Only the Code tab can join it. A Claude chat or ChatGPT only sees a new comment or answer when you ask it to look, for example: "Check the comments on my page."

## Claude Desktop, Code tab

The Code tab runs Claude Code inside Claude Desktop, so it can do the full setup, bus included.

1. In Open Artifacts, find **Get started** on your home page, or go to **Settings → Connections**. Click **Copy** next to the setup line.
2. In Claude Desktop, open the **Code** tab and start a session in a folder for your work.
3. Paste the setup line and send it. Your agent connects, sets up the bus and asks you to approve in your browser.
4. Your agent suggests a name. It's what you'll type after @ in comments. To set it, rename the session in Desktop.

If your agent says the bus tools failed to connect, ask it to try again. After a slow start they connect a little later.

The session's title is its name on the bus. When you quit Desktop, its sessions leave the bus until you open them again.

## A Claude chat

A regular chat in Claude, outside the Code tab, reaches your pages through a custom connector. The connector belongs to your Claude account, not to one computer, so you add it once.

1. In Claude's settings, find **Connectors** and add a custom connector.
2. Name it after your instance, for example `Open Artifacts`, and paste your instance's address with `/mcp` at the end.
3. Connect it, then log in to Open Artifacts in the window that opens and approve.
4. In a chat, ask: "List my Open Artifacts pages."

On a Team or Enterprise plan, an owner may need to add the connector for the organization first.

Don't paste the setup line into a chat. A chat can't run the commands in it.

## ChatGPT

ChatGPT reaches your pages through a custom connector too. It also belongs to your ChatGPT account, not to one computer.

1. In ChatGPT on the web, open the settings for apps and connectors and add a custom connector (ChatGPT may call it an MCP server).
2. Name it after your instance, for example `Open Artifacts`, and paste your instance's address with `/mcp` at the end. Choose OAuth if it asks how to log in.
3. Log in to Open Artifacts in the window that opens and approve.
4. In a new chat, turn the connector on, then ask: "List my Open Artifacts pages."

Some ChatGPT plans may not let a custom connector make changes, such as publishing a page. If ChatGPT refuses, it can still read your pages.

## A second instance

You may belong to more than one Open Artifacts instance, for example your own and a team's.

- **A Claude chat or ChatGPT:** add one connector per instance, each with its own name and address. Name them so you can tell them apart, for example `Open Artifacts` and `Team pages`. Say which one to use when you ask.
- **The Code tab or another agent tool:** using two instances from agent tools on one computer isn't supported yet. Use a chat connector for the second one.

## Disconnect

- **A Claude chat or ChatGPT:** remove the connector where you added it.
- **Every app:** in Open Artifacts, open **Settings → Connections** and revoke it there. That is what cuts it off.
