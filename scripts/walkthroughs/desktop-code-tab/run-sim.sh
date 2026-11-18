#!/bin/bash
# Simulates how Claude Desktop's Code tab launches Claude Code (same binary, stream-json, entrypoint claude-desktop).
S="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/Library/Application Support/Claude/claude-code/2.1.326/c4434d650cb3/claude.app/Contents/MacOS/claude"
cd "${REPO:-$PWD}"
exec 3<>"$S/in"
exec timeout 1500 env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TERM=dumb \
  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  CLAUDE_CODE_ENTRYPOINT=claude-desktop \
  "$BIN" --output-format stream-json --verbose --input-format stream-json \
  --setting-sources user,project,local --permission-mode default --replay-user-messages \
  --model claude-haiku-5-5 --name "OA Desktop Sim" <&3 >"$S/out.jsonl" 2>"$S/err.log"
