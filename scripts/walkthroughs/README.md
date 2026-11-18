# Walk-throughs (hand-off, not wired into CI)

Scratch tools from OA Desktop's 2026-11-18 session. Results and next steps are on the pages below.

## member-walk: a brand-new member on a clean Linux machine

Page: https://artifacts.leourbina.com/a/SHtyLXK7q2K1DJQL

```sh
docker build -t oa-walk-member scripts/walkthroughs/member-walk
docker run -d --name oa-walk-member --hostname member-laptop oa-walk-member   # no mounts, ever
docker exec -it oa-walk-member bash -lc 'cd ~/conference-site && claude'       # a person signs in here
# then paste: Set up Open Artifacts for me: follow https://mit-ai.open-artifacts.app/llms.txt
docker rm -f oa-walk-member                                                    # when done
```

Steps 1 to 3 of the instance's /llms.txt (connect, pinned bus install up to the approval code, skill) pass
without a person. Sign-in to Claude, sign-in to the instance and machine approval need a person's browser.
The container has no systemd: watch how the installer keeps the daemon running after approval.

## desktop-code-tab: the bus from Claude Desktop's Code tab (macOS only)

Page: https://artifacts.leourbina.com/a/nP5kTJj9iFTSZkBN · Issue #2801

- `run-sim.sh` starts Claude Desktop's bundled Claude Code the way the Code tab does (stream-json,
  `CLAUDE_CODE_ENTRYPOINT=claude-desktop`). Make a fifo named `in` beside it first (`mkfifo in`), run it
  from the repo, write stream-json user messages to `in`, read `out.jsonl`. The binary path has Desktop's
  bundled version in it; update it to the one under `~/Library/Application Support/Claude/claude-code/`.
- `mcpcall.py <claude|codex> <empty dir>` calls a bus MCP server with no Claude session above it, as a
  regular Desktop chat would. Both refuse every tool call.
