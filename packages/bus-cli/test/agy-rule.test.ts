// agy S3: install saves ONE always-allow rule in agy's settings, for exactly
// the watcher's command line; uninstall removes exactly it; doctor reports it.
// A scratch HOME only, with a fake agy (deps.which).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyHello } from "../src/commands/agy-hello.ts";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import {
  agyRuleState,
  agySettingsFile,
  agyWatchRule,
} from "../src/steps/agy-rule.ts";
import {
  AGY_WATCH_FILE,
  agyPluginDir,
  agyWatchCommand,
} from "../src/steps/antigravity.ts";
import { fakeCtx } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const LINE = "/opt/node/bin/node /h/.oa-bus/bin/oa-bus.js agy-watch";
const RULE =
  "command(regex:^/opt/node/bin/node /h/\\.oa-bus/bin/oa-bus\\.js agy-watch$)";

/** agy S2b: install pins the bus home in the watcher's line, default too. */
const pinnedLine = (h: string) => agyWatchCommand(BIN, join(h, ".oa-bus"));
const pinnedRule = (h: string) => agyWatchRule(pinnedLine(h));

function setup(): { h: string; deps: AdapterDeps; file: string } {
  const h = mkdtempSync(join(tmpdir(), "ob-agyr-"));
  const deps: AdapterDeps = {
    home: h,
    env: { OA_BUS_EXPERIMENTAL_AGY: "1" },
    busBin: BIN,
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => cmd === "agy",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { h, deps, file: agySettingsFile(h) };
}
const read = (p: string) => readFileSync(p, "utf8");
const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, { mode: 0o600 });
};
const allowOf = (p: string) =>
  (JSON.parse(read(p)) as { permissions?: { allow?: string[] } }).permissions
    ?.allow;

describe("the always-allow rule for the watcher (agy S3)", () => {
  it("is the fixed line, anchored and literal: nothing else matches it", () => {
    expect(agyWatchCommand(BIN)).toBe(LINE);
    expect(agyWatchRule(LINE)).toBe(RULE);
    const re = new RegExp(RULE.slice("command(regex:".length, -1));
    expect(re.test(LINE)).toBe(true);
    for (const other of [
      `${LINE} --home /tmp/x`,
      `${LINE}; rm -rf ~`,
      `/opt/node/bin/node /h/.oa-bus/bin/oa-bus.js agy-hello`,
      `/opt/node/bin/nodeX/h/.oa-bus/bin/oa-busXjs agy-watch`,
      `echo ${LINE}`,
    ])
      expect(re.test(other)).toBe(false);
    // A moved bus home is part of the one line.
    expect(agyWatchCommand(BIN, "/tmp/bus home")).toBe(
      `${LINE} --home '/tmp/bus home'`,
    );
  });

  it("install adds it to permissions.allow and keeps every other byte; uninstall puts the file back byte for byte", async () => {
    const { h, deps, file } = setup();
    const RULE = pinnedRule(h);
    const LINE = pinnedLine(h);
    const before =
      '{\n  "colorScheme": "dark",\n  "permissions": {\n    "allow": [\n      "command(git status)"\n    ],\n    "deny": ["command(sudo)"]\n  },\n  "trustedWorkspaces": ["/w"]\n}\n';
    put(file, before);
    await installAdapters(deps);
    const after = read(file);
    expect(allowOf(file)).toEqual(["command(git status)", RULE]);
    // Only our string went in.
    expect(after.replace(`,\n      ${JSON.stringify(RULE)}`, "")).toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Idempotent.
    await installAdapters(deps);
    expect(read(file)).toBe(after);
    // The plugin carries the same line, for the hook to hand the session.
    expect(read(join(agyPluginDir(h), AGY_WATCH_FILE))).toBe(`${LINE}\n`);
    await uninstallAdapters(deps);
    expect(read(file)).toBe(before);
  });

  it("creates the settings file when there is none, and uninstall leaves no permissions key behind", async () => {
    const { h, deps, file } = setup();
    const RULE = pinnedRule(h);
    await installAdapters(deps);
    expect(JSON.parse(read(file))).toEqual({ permissions: { allow: [RULE] } });
    await uninstallAdapters(deps);
    expect(JSON.parse(read(file))).toEqual({});
  });

  it("replaces the rule an earlier install saved for another line, and touches no rule of the user's", async () => {
    const { h, deps, file } = setup();
    const RULE = pinnedRule(h);
    put(file, '{"permissions":{"allow":["command(git)"]}}\n');
    await installAdapters({ ...deps, busBin: ["/old/oa-bus"] });
    expect(allowOf(file)).toEqual([
      "command(git)",
      agyWatchRule(agyWatchCommand(["/old/oa-bus"], join(h, ".oa-bus"))),
    ]);
    await installAdapters(deps);
    expect(allowOf(file)).toEqual(["command(git)", RULE]);
    await uninstallAdapters(deps);
    expect(allowOf(file)).toEqual(["command(git)"]);
  });

  it("doctor says present, missing or altered, with the fix", async () => {
    const { h, deps, file } = setup();
    const RULE = pinnedRule(h);
    const LINE = pinnedLine(h);
    const busDir = join(h, ".oa-bus");
    expect(agyRuleState(h, busDir, LINE).state).toBe("missing");
    await installAdapters(deps);
    expect(agyRuleState(h, busDir, LINE).state).toBe("present");
    // Broadened by hand: not ours any more.
    put(
      file,
      read(file).replace(
        RULE.replace(/\\/g, "\\\\"),
        "command(regex:.*agy-watch.*)",
      ),
    );
    expect(agyRuleState(h, busDir, LINE).state).toBe("altered");
    // Ours, but also asked about: altered too.
    put(file, JSON.stringify({ permissions: { allow: [RULE], ask: [RULE] } }));
    expect(agyRuleState(h, busDir, LINE).state).toBe("altered");
  });

  it("the hook asks the session to start the watcher only while none runs for its agy process", async () => {
    const payload = JSON.stringify({
      conversationId: "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21",
      cwd: "/w/app",
      workspacePaths: ["/w/app"],
    });
    const run = async (live: boolean) => {
      const ctx = fakeCtx();
      await agyHello(ctx, {
        stdin: async () => payload,
        proc: (pid) =>
          pid === 300
            ? { ppid: 200, name: "sh" }
            : pid === 200
              ? { ppid: 1, name: "agy" }
              : null,
        procStart: () => "t0",
        title: async () => undefined,
        hello: async () => "agy",
        ppid: 300,
        watcherLive: () => live,
        watchLine: () => LINE,
      });
      return ctx.out();
    };
    const asked = JSON.parse((await run(false))[0] as string);
    expect(asked.injectSteps[0].systemMessage.systemMessage).toMatch(
      new RegExp(`BypassSandbox: true.*${LINE.replace(/\./g, "\\.")}$`),
    );
    expect(await run(true)).toEqual(["{}"]);
  });
});
