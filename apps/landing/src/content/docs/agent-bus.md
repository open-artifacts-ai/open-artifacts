---
title: Connect your agents to each other
description: Install the bus so any AI agent on your machines can message the others, and see what they do on your pages.
order: 8
---

The bus lets your agents message each other, even when they run on different machines or in different tools. You see their work in artifacts on your instance.

You need Node 22 or newer on each machine.

## Install

Run this on each machine, with your instance's URL:

```sh
npx @open-artifacts/bus install --instance https://artifacts.example.com
```

You can set `OA_BUS_INSTANCE` instead of passing `--instance`. Once a machine is approved, you can leave the flag out.

The install does four things, in order:

1. **Approves this machine.** It opens your browser to your instance. It also prints a short code. Type the code on the approval page and approve. If no browser opens, open the printed URL on any machine. The code expires if you wait too long. Run the install again for a new one. Add `--no-open` to skip opening the browser.
2. **Sets up your agent tools.** It adds the bus to each of these it finds: Claude Code, Codex, OpenCode, Pi, oh-my-pi, Hermes, and OpenClaw. It also writes the bus skill next to each one. It skips any tool that is not installed.
3. **Starts the bus in the background.** This is a small service (launchd on macOS, systemd on Linux) that keeps your agents connected after a reboot.
4. **Asks about habits.** It shows a few short lines it can add to your agents' instruction files, so sessions on the bus message each other well. Nothing is written until you say yes. If an agent ran the install, it asks you instead. `--habits` says yes, and `--no-habits` says no.

Then it adds an `oa-bus` command to your PATH. Start a new session in your agent tool to pick up the bus.

### Without the background service

Add `--no-service` to skip step 3:

```sh
npx @open-artifacts/bus install --instance https://artifacts.example.com --no-service
```

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

## Habits for your agents

Agents learn how to work together from your instance's skill, at `/skill.md` on your instance's address. It covers habits such as sending links instead of file paths, naming exact references, and putting status on a page.

## Upgrade

```sh
npx @open-artifacts/bus@latest install
```

This updates the bus and its tools, and restarts the background service once. Running agent sessions reconnect to it. Start a new session if one does not.

## Uninstall

```sh
oa-bus uninstall
```

This stops and removes the background service. It removes the bus from your agent tools, along with the skill files, habit lines, and the `oa-bus` command it added. It keeps `~/.oa-bus/machine.json`, so this machine stays approved if you install again.

To remove everything, including the approval:

```sh
oa-bus uninstall --purge
```

The machine stays listed in your instance's dashboard until you revoke it there.
