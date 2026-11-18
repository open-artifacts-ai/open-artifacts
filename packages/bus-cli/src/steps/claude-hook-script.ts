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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REASON = ${JSON.stringify(HOOK_REASON)};

// Words after which the rest of a simple command may be the real command.
const WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "exec", "nohup", "time", "timeout", "nice",
  "ionice", "setsid", "stdbuf", "xargs", "parallel", "npx", "pnpm", "pnpx",
  "bunx", "bun", "yarn", "npm", "node", "nodejs", "sh", "bash", "zsh", "dash",
  "ksh", "eval", "script", "watch", "builtin",
]);
const KEYWORDS = new Set(["if", "then", "do", "else", "elif", "while", "until", "!"]);
const ASSIGN = /^[a-z_][a-z0-9_]*=/;
const EXPANSION = /[$\u0060]|<\(/;
const GLOB = /[*?[{]/;

const base = (tok) => tok.slice(tok.lastIndexOf("/") + 1);

// A token as a regex: expansions and globs stand for anything. Null when it has none.
function toRegex(tok) {
  const hasVar = tok.includes("$");
  if (!hasVar && !GLOB.test(tok)) return null;
  const src = tok
    .replace(/\$\{[^}]*\}/g, "\u0001")
    .replace(/\$\(.*$/g, "\u0001")
    .replace(/\$[a-z0-9_]*/g, "\u0001")
    .replace(/\{[^}]*\}/g, "\u0001")
    .replace(/\[[^\]]*\]/g, "\u0002")
    .replace(/\*/g, "\u0001")
    .replace(/\?/g, "\u0002");
  const literal = src.replace(/[\u0001\u0002]/g, "").length;
  const re = src
    .replace(/[.+^|()\\\/\[\]{}$]/g, "\\$&")
    .replace(/\u0001/g, ".*")
    .replace(/\u0002/g, ".");
  try {
    return { re: new RegExp("^" + re + "$"), literal };
  } catch {
    return { re: /^/, literal: 0 };
  }
}

// Could this word, once the shell has expanded it, be exactly target?
function couldBe(tok, target) {
  if (EXPANSION.test(tok)) return true;
  const r = toRegex(tok);
  return r ? r.re.test(target) : tok === target;
}

// Does this token, in command position, name the bus program?
function isBusName(tok, extra) {
  const b = base(tok);
  if (b === "oa-bus" || b.startsWith("oa-bus.") || b.startsWith("oa-bus@")) return true;
  if (
    tok.includes("@open-artifacts/bus") ||
    tok.includes("/bus-cli/dist") ||
    tok.includes("/bus-cli/bin") ||
    tok.includes(".oa-bus/bin/")
  ) return true;
  if (extra && tok.startsWith(extra + "/")) return true;
  // The name split by a glob or expansion: oa-b*, oa-?us, oa-bu-var-s.
  const r = toRegex(b);
  return !!r && r.literal >= 2 && r.re.test("oa-bus");
}

// The words after the program: refused when add or use could be the subcommand
// (one of the first two plain words, to allow for an option value).
function argsRefused(rest) {
  let words = 0;
  for (const tok of rest) {
    if (tok === "") continue;
    if (EXPANSION.test(tok)) return true;
    if (tok.startsWith("-")) continue;
    if (couldBe(tok, "add") || couldBe(tok, "use")) return true;
    if (++words >= 2) break;
  }
  return false;
}

function simpleRefused(tokens, extra) {
  let wrapped = false;
  let fanout = false;
  for (const tok of tokens) {
    if (tok === "") continue;
    if (isBusName(tok, extra)) {
      if (fanout) return true;
      const i = tokens.indexOf(tok);
      return argsRefused(tokens.slice(i + 1));
    }
    if (wrapped) {
      continue;
    }
    if (ASSIGN.test(tok) || KEYWORDS.has(tok)) continue;
    const w = base(tok);
    if (!WRAPPERS.has(w)) return false;
    wrapped = true;
    if (w === "xargs" || w === "parallel") fanout = true;
  }
  return false;
}

// extra: the bus home, another way a command can name the installed bin.
export function refuses(text, extra) {
  const t = String(text)
    .toLowerCase()
    .replace(/\\\r?\n/g, "")
    .replace(/['"\\]/g, "");
  const e = extra ? String(extra).toLowerCase() : "";
  // Whole simple commands, and again with parens and backticks cut out so a
  // command substitution is judged on its own.
  const parts = t.split(/[;&|\n]+/).concat(t.split(/[;&|\n()\u0060]+/));
  return parts.some((p) => simpleRefused(p.trim().split(/\s+/), e));
}

// The hook JSON in, the answer out: a deny object, or undefined to allow.
export function decide(input, extra) {
  let subject = String(input).replace(/\\[nrt]/g, "\n").replace(/[{}\[\]:,]/g, "\n");
  try {
    const j = JSON.parse(input);
    if (j && typeof j === "object") {
      const tool = j.tool_name;
      if (typeof tool === "string" && tool !== "Bash" && tool !== "Monitor") return undefined;
      const c = j.tool_input && j.tool_input.command;
      if (typeof c === "string") subject = c;
      else if (Array.isArray(c) && c.every((x) => typeof x === "string")) subject = c.join(" ");
      else subject = JSON.stringify(j.tool_input === undefined ? j : j.tool_input).replace(/[{}\[\]:,"]/g, "\n");
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

// Node resolves symlinks in import.meta.url but not in argv[1]: compare real paths,
// and if they cannot be read, run anyway (a hook that fails open is worse).
let main = true;
try {
  main = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}
if (process.argv[1] && main) run();
`;
