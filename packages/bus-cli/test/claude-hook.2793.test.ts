import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "@oa/bus-adapter-mcp-json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_FILE,
  installClaudeHook,
  uninstallClaudeHook,
} from "../src/steps/claude-hook.ts";
import { HOOK_REASON } from "../src/steps/claude-hook-script.ts";

let root: string;
let home: string;
let busHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oa-hook-2793-"));
  home = join(root, "home");
  busHome = join(root, "bus");
  mkdirSync(home);
  mkdirSync(busHome);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settings = () => join(home, ".claude", "settings.json");
const where = () => ({ home, busHome, env: {}, execPath: process.execPath });
const script = () => join(busHome, "hooks", HOOK_FILE);

/** Runs the written script the way Claude Code does: JSON on stdin. */
const run = (input: string) => {
  const r = spawnSync(process.execPath, [script(), busHome], {
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(r.status).toBe(0);
  return r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout);
};
const bash = (command: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

const DENIED = [
  "oa-bus add",
  "oa-bus add https://x.example --name y",
  "oa-bus use work",
  "npx @open-artifacts/bus add",
  "npx -y @open-artifacts/bus@latest use home",
  "pnpm dlx @open-artifacts/bus add",
  "~/.local/bin/oa-bus add",
  "/home/u/.oa-bus/bin/1.2.3/dist/index.js use work",
  "OA_BUS_HOME=/tmp/x oa-bus add",
  "FOO=1 BAR=2 oa-bus use a",
  "node /home/u/code/open-artifacts/packages/bus-cli/dist/index.js add",
  "cd /tmp && oa-bus add",
  "true; oa-bus use x",
  "oa-bus status | oa-bus add",
  "false || oa-bus add",
  "sh -c 'oa-bus add'",
  'bash -c "oa-bus use home"',
  "eval 'oa-bus add'",
  'eval "oa-bus" "add"',
  "echo $(oa-bus add)",
  "echo `oa-bus use x`",
  "oa-'bus' add",
  'oa-bus "add"',
  "oa-bus\nadd",
  "script -qc 'oa-bus add' /dev/null",
  `${"/some/where"}/oa-bus use`,
];
const ALLOWED = [
  "oa-bus status",
  "oa-bus doctor",
  "git add .",
  "git add -A && git commit -m use",
  "npm run use-case",
  "ls -la",
  "npx vitest run",
  "echo adding the use of tools",
];

describe("the oa-bus add/use hook script (#2793 S5a)", () => {
  beforeEach(() => {
    expect(installClaudeHook(where()).changed).toBe(true);
  });

  it.each(DENIED)("denies %j", (cmd) => {
    const out = run(bash(cmd));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(HOOK_REASON);
    expect(HOOK_REASON).toBe(
      "oa-bus add and oa-bus use need you at your own terminal. An agent can't run them.",
    );
  });

  it.each(ALLOWED)("allows %j", (cmd) => {
    expect(run(bash(cmd))).toBeUndefined();
  });

  it("allows other tools", () => {
    expect(
      run(
        JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/x/oa-bus add" },
        }),
      ),
    ).toBeUndefined();
  });

  it("with unparseable input: allows plain text, denies one that names oa-bus add", () => {
    expect(run("not json at all")).toBeUndefined();
    expect(run("{ oa-bus add")?.hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    expect(run("")).toBeUndefined();
  });

  it("with a Bash input that has no string command, judges the whole input", () => {
    const j = (o: unknown) => JSON.stringify(o);
    expect(
      run(j({ tool_name: "Bash", tool_input: { command: ["oa-bus", "add"] } }))
        ?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
    expect(run(j({ tool_name: "Bash", tool_input: {} }))).toBeUndefined();
  });

  it("names the installed bin by the bus home", () => {
    const out = run(bash(`${busHome}/bin/9.9.9/dist/index.js use work`));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("exports the matcher without running when imported", async () => {
    const m = await import(pathToFileURL(script()).href);
    expect(m.refuses("oa-bus add")).toBe(true);
    expect(m.refuses("oa-bus status")).toBe(false);
  });

  it("is a plain node script that never waits for stdin to close beyond its timeout", () => {
    // Closed stdin with no data ends at once (above); here the JSON arrives and the stream ends.
    const r = execFileSync(process.execPath, [script()], {
      input: bash("ls"),
      encoding: "utf8",
    });
    expect(r).toBe("");
  });
});

describe("install and uninstall (#2793 S5a)", () => {
  const read = () =>
    parseJsonc(readFileSync(settings(), "utf8"), "settings") as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
        Stop: unknown[];
      };
      model?: string;
    };

  it("adds one PreToolUse Bash entry, idempotently", () => {
    installClaudeHook(where());
    const first = readFileSync(settings(), "utf8");
    const again = installClaudeHook(where());
    expect(again.changed).toBe(false);
    expect(readFileSync(settings(), "utf8")).toBe(first);
    const list = read().hooks.PreToolUse;
    expect(list).toHaveLength(1);
    expect(list[0].matcher).toBe("Bash");
    expect(list[0].hooks[0].type).toBe("command");
    expect(list[0].hooks[0].command).toContain(HOOK_FILE);
    expect(existsSync(script())).toBe(true);
  });

  it("leaves the person's own hooks and settings alone, and removes only ours", () => {
    mkdirSync(join(home, ".claude"));
    const mine = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "my-own-hook.sh" }],
    };
    const text = `{
  // my settings
  "model": "opus",
  "hooks": {
    "PreToolUse": [${JSON.stringify(mine)}],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bye" }] }]
  }
}
`;
    writeFileSync(settings(), text);
    installClaudeHook(where());
    let doc = read();
    expect(doc.model).toBe("opus");
    expect(doc.hooks.Stop).toHaveLength(1);
    expect(doc.hooks.PreToolUse).toHaveLength(2);
    expect(doc.hooks.PreToolUse[0]).toEqual(mine);
    expect(readFileSync(settings(), "utf8")).toContain("// my settings");

    uninstallClaudeHook({ home, busHome, env: {} });
    expect(readFileSync(settings(), "utf8")).toBe(text);
    doc = read();
    expect(doc.hooks.PreToolUse).toEqual([mine]);
    expect(existsSync(script())).toBe(false);
  });

  it("uninstall removes a settings.json that install created, and its empty folders", () => {
    installClaudeHook(where());
    uninstallClaudeHook({ home, busHome, env: {} });
    expect(existsSync(settings())).toBe(false);
  });

  it("uninstall keeps a settings.json that held other settings", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), '{ "model": "opus" }\n');
    installClaudeHook(where());
    uninstallClaudeHook({ home, busHome, env: {} });
    expect(read()).toEqual({ model: "opus" });
  });

  it("repoints our entry when the node path changes, without a second entry", () => {
    installClaudeHook(where());
    installClaudeHook({ ...where(), execPath: "/other/node" });
    const list = read().hooks.PreToolUse;
    expect(list).toHaveLength(1);
    expect(list[0].hooks[0].command).toContain("/other/node");
  });

  it("does not touch a settings.json that does not parse", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), "{ nope");
    const r = installClaudeHook(where());
    expect(r.changed).toBe(false);
    expect(r.notes[0]).toMatch(/Left .* alone/);
    expect(readFileSync(settings(), "utf8")).toBe("{ nope");
  });

  it("uninstall with nothing installed does nothing", () => {
    const r = uninstallClaudeHook({ home, busHome, env: {} });
    expect(r.changed).toBe(false);
    expect(existsSync(settings())).toBe(false);
  });
});
