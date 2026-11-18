// The Claude Code PreToolUse hook that refuses `oa-bus add` and `oa-bus use`
// from an agent (#2793 S5a). Those commands are person-only; a pty wrapper
// defeats the isTTY check, so this hook is the real gate. The script is plain
// JavaScript with no imports from the bus, so install writes it as one file
// and Claude Code runs it with `node`. It does no network and reads only its
// stdin. Run directly it prints a deny, or nothing (allow); imported it only
// exports `refuses` and `decide`.
//
// Conservative on purpose: a command that mentions oa-bus (or the npm package,
// or the bus home) together with an `add` or `use` word is refused, whatever
// the shell shape around it. Quotes and backslashes are dropped first so
// `oa-"bus" add` is seen as `oa-bus add`. A command that never mentions the bus
// is allowed, and so is input we cannot parse unless its raw text matches.
//
// Written with String.raw: no backticks or dollar-brace inside.

export const HOOK_REASON =
  "oa-bus add and oa-bus use need you at your own terminal. An agent can't run them.";

export const HOOK_SCRIPT = String.raw`// oa-bus-refuse-add-use: written by oa-bus install. Refuses oa-bus add and oa-bus use from an agent.
// Edits are replaced on reinstall. Removed by oa-bus uninstall.
import { fileURLToPath } from "node:url";

export const REASON = ${JSON.stringify(HOOK_REASON)};

const MENTIONS = ["oa-bus", "open-artifacts/bus", "bus-cli"];

// extra: the bus home, another way a command can name the installed bin.
export function refuses(text, extra) {
  const t = String(text)
    .toLowerCase()
    .replace(/\\[nrt]/g, " ")
    .replace(/['"\\\u0060]/g, "");
  const names = extra ? MENTIONS.concat([String(extra).toLowerCase()]) : MENTIONS;
  if (!names.some((m) => t.includes(m))) return false;
  return t.split(/[^a-z0-9_.@\/~:+-]+/).some((w) => w === "add" || w === "use");
}

// The hook JSON in, the answer out: a deny object, or undefined to allow.
export function decide(input, extra) {
  let subject = String(input);
  try {
    const j = JSON.parse(input);
    if (j && typeof j === "object") {
      if (typeof j.tool_name === "string" && j.tool_name !== "Bash") return undefined;
      const c = j.tool_input && j.tool_input.command;
      subject = typeof c === "string" ? c : JSON.stringify(j.tool_input === undefined ? j : j.tool_input);
    }
  } catch {}
  if (!refuses(subject, extra)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: REASON,
    },
  };
}

function run() {
  const extra = process.argv[2];
  let data = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const d = decide(data, extra);
    if (d) process.stdout.write(JSON.stringify(d) + "\n");
    process.exit(0);
  };
  // Never block: whatever has arrived by then is judged.
  setTimeout(finish, 5000).unref();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { data += c; });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
`;
