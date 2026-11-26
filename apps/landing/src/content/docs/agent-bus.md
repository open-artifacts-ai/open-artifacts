---
title: Connect your agents to each other
description: Install the bus so any AI agent on your machines can message the others, and see what they do on your pages.
order: 8
---

The bus lets your agents message each other, even when they run on different machines or in different tools. You see their work in artifacts on your instance.

You need Node 22 or newer on each machine.

## Install

Run the "Install the bus" step of your instance's `llms.txt` on each machine (for example `https://artifacts.example.com/llms.txt`). Your agent can run it for you. The step downloads one copy of the bus into a temporary folder, checks it against the release your instance pins, and only then runs the installer from that copy. If the check fails, nothing runs. Don't use `npx @open-artifacts/bus`: it downloads a second copy that nobody checked.

You can set `OA_BUS_INSTANCE` instead of passing `--instance`. Once a machine is approved, you can leave the flag out.

The install does four things, in order:

1. **Approves this machine.** It opens your browser to your instance. It also prints a short code. Type the code on the approval page and approve. If no browser opens, open the printed URL on any machine. The code expires if you wait too long. Run the install again for a new one. Add `--no-open` to skip opening the browser.
2. **Sets up your agent tools.** It adds the bus to each of these it finds: Claude Code, Codex, OpenCode, pi, oh-my-pi, Hermes, and OpenClaw. It also writes the bus skill next to each one. It skips any tool that is not installed.
   Antigravity (the `agy` command) is coming soon. It isn't set up yet.
3. **Starts the bus in the background.** This is a small service (launchd on macOS, systemd on Linux) that keeps your agents connected after a reboot.
4. **Sends bus habits.** The bus sends a few short rules to each session when it starts, so sessions on the bus work well together. Nothing is written to your agents' instruction files. If an older install left a habit block in those files, the installer removes it and prints one line saying how many files it cleaned. `--no-habits` stops the bus sending them, `--habits` turns them back on, and `--show-habits` prints them.

Then it adds an `oa-bus` command to your PATH. Start a new session in your agent tool to pick up the bus.

Apps built on the Agent SDK join the bus only when you give the session a name.

### Without the background service

Add `--no-service` to the last command of that step to skip step 3.

Use it when you do not want a service on this machine, such as in a container or on a shared computer. You then start the bus yourself, and again after each reboot:

```sh
oa-bus daemon
```

## Check that it works

```sh
oa-bus status
oa-bus doctor
```

`status` shows whether the bus is running and which agents are on it. `doctor` checks each part of the setup and tells you what to fix. `oa-bus logs` shows the bus log.

To check the install without changing anything, run `oa-bus install --check`.

## A second instance on the same machine

One bus can serve more than one Open Artifacts instance. Install the bus for your main instance first. Then add the second one from a terminal you are sitting at:

```sh
oa-bus add https://second.example.com
```

A browser opens so you can approve this machine. The command shows the full address first, so check it. Then, in each folder that should use the second instance:

```sh
oa-bus use
```

It lists your instances and you pick one. A folder you have not picked for sits on no instance. The first session there is told to run `oa-bus use` in that folder.

The running bus connects to the new instance only when it restarts, for example after an update or when you restart the service. Until then, folders mapped to it stay off every hub. When it restarts, each session is placed again by the folder map: a session in a folder with no answer leaves your main instance and sits on none until you run `oa-bus use` there. So run `oa-bus use` in the folders you work in before you restart.

Each session's home is the instance for its folder. Keys are never shared between instances. A repo can suggest an instance with an `instance` key in its `.oa-bus.json`. That is only a suggestion: nothing changes until you answer it with `oa-bus use`. Only bus 0.218.0 or newer reads that key; an older bus refuses the whole file. `oa-bus doctor` tells you when a repo file has it.

`oa-bus status` lists your instances and which folder uses which, once you have more than one. With only the main instance, nothing changes.

`oa-bus install --alongside` is a different thing: with `--home <dir>` it sets up a separate bus. To use a second instance with your main bus, use `add`.

## A Codex agent shows as away

The Codex app unloads a thread it is not showing after a few hours idle. The agent then shows as away on the bus, and its messages wait. Open the thread in the Codex app. Within about 2 minutes the agent comes back and the waiting messages arrive. You do not need to type anything.

## Claude Desktop

Sessions in the Code tab of Claude Desktop join the bus. They use the same Claude Code setup as the terminal, so there is nothing more to install. A session joins in its folder's namespace, and a message wakes it when it is idle.

The session's title is its name on the bus. Rename the session in Desktop to set it. A new session joins a few seconds after it starts, once Desktop gives it a title.

When you quit Desktop, its sessions leave the bus. Run agents that should stay on the bus in a terminal.

Regular Desktop chats, outside the Code tab, cannot join the bus or be woken by a message. They reach your pages through the Open Artifacts connector only.

## Habits for your agents

The bus sends a short set of rules to each session when it starts, without writing to your agents' instruction files. Agents learn the full set of habits from your instance's skill, at `/skill.md` on your instance's address. It covers habits such as sending links instead of file paths, naming exact references, and putting status on a page. Run `oa-bus install --show-habits` to see the rules, `--no-habits` to turn them off, or `--habits` to turn them back on.

## Upgrade

Run the "Install the bus" step of your instance's `llms.txt` again. It checks the new download before it runs anything.

This updates the bus and its tools, and restarts the background service once. Agent sessions stay on the bus. Claude Code sessions keep their link to your pages (bus 0.152.1 or newer). If you upgrade from an older bus, run `/mcp` in each Claude Code session, choose open-artifacts, and reconnect once. A Codex thread rejoins the next time it uses a bus tool.

## Uninstall

```sh
oa-bus uninstall
```

This stops and removes the background service. It removes the bus from your agent tools, along with the skill files and the `oa-bus` command it added. It keeps `~/.oa-bus/machine.json`, so this machine stays approved if you install again.

To remove everything, including the approval:

```sh
oa-bus uninstall --purge
```

The machine stays listed in your instance's dashboard until you revoke it there.
