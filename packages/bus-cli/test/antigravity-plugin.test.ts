// agy S2: the oa-bus agy plugin (SessionStart hook) and `oa-bus agy-hello`.
// A fake agy (deps.which, a fake process table) and a scratch HOME only.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busHome, readAgyConversation } from "@oa/bus-adapter-claude-code";
import { parseAgyPluginHome } from "@oa/bus-daemon";
import { HelloRefused } from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import { AGY_HELLO_EVENT, agyHello } from "../src/commands/agy-hello.ts";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { parse } from "../src/index.ts";
import {
  type AdapterDeps,
  checkAdapters,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import {
  AGY_PLUGIN_MARKER,
  agyHookCommand,
  agyPluginDir,
  agyPluginFiles,
  agyPluginProblem,
} from "../src/steps/antigravity.ts";
import { leftoverTargets } from "../src/steps/leftovers.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const ON = { OA_BUS_EXPERIMENTAL_AGY: "1" };
const REF = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
/** The default-home hook command an earlier build wrote: no pin, so it followed the agy process's OA_BUS_HOME. */
const LEGACY_HOOK = `f="\${OA_BUS_HOME:-$HOME/.oa-bus}/antigravity/$PPID.json"; if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ] && grep -qF "\\"conversationId\\":\\"$ANTIGRAVITY_CONVERSATION_ID\\"" "$f" 2>/dev/null; then echo '{}'; else exec '/opt/node/bin/node' '/h/.oa-bus/bin/oa-bus.js' 'agy-hello'; fi`;

function setup(env: Record<string, string> = ON): {
  h: string;
  deps: AdapterDeps;
  dir: string;
} {
  const h = mkdtempSync(join(tmpdir(), "ob-agyp-"));
  const deps: AdapterDeps = {
    home: h,
    env,
    busBin: BIN,
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => cmd === "agy",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { h, deps, dir: agyPluginDir(h) };
}
const read = (p: string) => readFileSync(p, "utf8");
const hooksOf = (dir: string) => JSON.parse(read(join(dir, "hooks.json")));

describe("the oa-bus agy plugin (agy S2)", () => {
  it("is off without OA_BUS_EXPERIMENTAL_AGY=1", async () => {
    const { deps, dir } = setup({});
    await installAdapters(deps);
    expect(existsSync(dir)).toBe(false);
  });

  it("install writes plugin.json and a root hooks.json whose SessionStart runs agy-hello", async () => {
    const { h, deps, dir } = setup();
    await installAdapters(deps);
    expect(JSON.parse(read(join(dir, "plugin.json")))).toMatchObject({
      name: "oa-bus",
      logo: "logo.svg",
    });
    expect(read(join(dir, "logo.svg"))).toContain("<svg");
    expect(existsSync(join(dir, AGY_PLUGIN_MARKER))).toBe(true);
    const handler = {
      type: "command",
      command: agyHookCommand(BIN, join(h, ".oa-bus")),
      timeout: 15,
    };
    expect(hooksOf(dir)).toEqual({
      "oa-bus": { SessionStart: [handler], PreInvocation: [handler] },
    });
    expect(checkAdapters(deps).antigravity).toBe("configured");
  });

  it("a second install writes nothing", async () => {
    const { deps, dir } = setup();
    await installAdapters(deps);
    const ino = statSync(join(dir, "hooks.json")).ino;
    await installAdapters(deps);
    expect(statSync(join(dir, "hooks.json")).ino).toBe(ino);
  });

  it("a moved bus home goes in the hook command, quoted for sh", async () => {
    const { h, deps, dir } = setup();
    const moved = join(h, "it's here");
    await installAdapters({ ...deps, busHome: moved });
    const cmd = hooksOf(dir)["oa-bus"].SessionStart[0].command as string;
    expect(cmd).toBe(agyHookCommand(BIN, moved));
    // sh reads it back: the home as one value, the argv as its words.
    const out = execFileSync(
      "/bin/sh",
      ["-c", cmd.replace(/exec '.*'; fi$/, "printenv OA_BUS_HOME; fi")],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: h } },
    );
    expect(out).toBe(`${moved}\n`);
    expect(checkAdapters({ ...deps, busHome: moved }).antigravity).toBe(
      "configured",
    );
    expect(checkAdapters(deps).antigravity).toBe("missing");
  });

  it("the hook pins the home it was installed for, default too: an agy started with another OA_BUS_HOME still joins there (agy S2b)", async () => {
    const { h, deps, dir } = setup();
    const alt = join(h, ".oa-bus-alt");
    const moved = join(h, ".oa-bus-moved");
    const home = (cmd: string) =>
      execFileSync(
        "/bin/sh",
        ["-c", cmd.replace(/exec '.*'; fi$/, "printenv OA_BUS_HOME; fi")],
        {
          encoding: "utf8",
          // The agy process's own environment, which the hook inherits.
          env: { PATH: "/usr/bin:/bin", HOME: h, OA_BUS_HOME: alt },
        },
      ).trim();
    await installAdapters(deps);
    expect(home(hooksOf(dir)["oa-bus"].SessionStart[0].command)).toBe(
      join(h, ".oa-bus"),
    );
    await installAdapters({ ...deps, busHome: moved });
    expect(home(hooksOf(dir)["oa-bus"].SessionStart[0].command)).toBe(moved);
  });

  it("an unpinned hook an earlier build wrote is stale: doctor says not wired, install pins it (agy S2b)", async () => {
    const { h, deps, dir } = setup();
    await installAdapters(deps);
    const legacy = JSON.stringify({
      "oa-bus": {
        SessionStart: [{ type: "command", command: LEGACY_HOOK, timeout: 15 }],
        PreInvocation: [{ type: "command", command: LEGACY_HOOK, timeout: 15 }],
      },
    });
    writeFileSync(join(dir, "hooks.json"), legacy);
    expect(parseAgyPluginHome(legacy)).toEqual({
      home: busHome({}),
      pinned: false,
    });
    expect(checkAdapters(deps).antigravity).toBe("missing");
    // The bus's argv unknown (doctor without it): still stale, not current.
    const argvUnknown = { ...deps, busBin: undefined };
    expect(checkAdapters(argvUnknown).antigravity).toBe("missing");
    await installAdapters(deps);
    expect(parseAgyPluginHome(read(join(dir, "hooks.json")))).toEqual({
      home: join(h, ".oa-bus"),
      pinned: true,
    });
    expect(checkAdapters(deps).antigravity).toBe("configured");
    expect(checkAdapters(argvUnknown).antigravity).toBe("configured");
  });

  it("default install, agy started with OA_BUS_HOME=alt: its oa_bus tools read the home its hook joined (agy S2b)", async () => {
    const { h, deps, dir } = setup();
    await installAdapters(deps);
    const alt = join(h, ".oa-bus-alt");
    // The agy process's own environment, which the hook and its MCP servers inherit.
    const agyEnv = { PATH: "/usr/bin:/bin", HOME: h, OA_BUS_HOME: alt };
    const cmd = hooksOf(dir)["oa-bus"].SessionStart[0].command as string;
    const joined = execFileSync(
      "/bin/sh",
      ["-c", cmd.replace(/exec '.*'; fi$/, "printenv OA_BUS_HOME; fi")],
      { encoding: "utf8", env: agyEnv },
    ).trim();
    expect(joined).toBe(join(h, ".oa-bus"));
    // agy starts the stdio server with its env, the entry's env on top.
    const entry = JSON.parse(read(join(h, ".gemini/config/mcp_config.json")))
      .mcpServers.oa_bus;
    const serverHome = busHome({ ...agyEnv, ...entry.env });
    expect(serverHome).toBe(joined);
    // What agy-hello records there is what the server reads.
    mkdirSync(join(joined, "antigravity"), { recursive: true });
    writeFileSync(
      join(joined, "antigravity", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        procStart: "t0",
        conversationId: REF,
        cwd: "/w",
      }),
    );
    expect(readAgyConversation(serverHome, process.pid)?.conversationId).toBe(
      REF,
    );
    expect(readAgyConversation(alt, process.pid)).toBeUndefined();
  });

  it("the hook text is the one the daemon's launch-and-join matrix runs", () => {
    // packages/bus-daemon/test/antigravity.starting.test.ts copies this shape
    // (pinnedHook); a change here must change it there.
    expect(agyHookCommand(["/bin/oa-bus"], "/tmp/it's here/.oa-bus")).toBe(
      `export OA_BUS_HOME='/tmp/it'\\''s here/.oa-bus'; d="$OA_BUS_HOME/antigravity"; if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ] && grep -qF "\\"conversationId\\":\\"$ANTIGRAVITY_CONVERSATION_ID\\"" "$d/$PPID.json" 2>/dev/null && p=$(sed -n 's/^{"pid":\\([0-9][0-9]*\\),.*/\\1/p' "$d/$PPID.watch.json" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo '{}'; else exec '/bin/oa-bus' 'agy-hello'; fi`,
    );
  });

  it("the hook's shell runs agy-hello unless the conversation is the one recorded and its watcher runs", () => {
    const h = mkdtempSync(join(tmpdir(), "ob-agyf-"));
    // A stand-in argv: prints its words instead of starting the bus.
    const cmd = agyHookCommand(["/bin/echo", "ran"], h);
    // sh -c's parent is this test process, as agy is the hook's.
    const run = (conv: string | undefined) =>
      execFileSync("/bin/sh", ["-c", cmd], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: h,
          ...(conv ? { ANTIGRAVITY_CONVERSATION_ID: conv } : {}),
        },
      }).trim();
    expect(run(REF)).toBe("ran agy-hello");
    mkdirSync(join(h, "antigravity"), { recursive: true });
    writeFileSync(
      join(h, "antigravity", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        procStart: "t0",
        conversationId: REF,
        cwd: "/w",
      }),
    );
    // agy S3: recorded, but no watcher yet: Node asks the session to start it.
    expect(run(REF)).toBe("ran agy-hello");
    const watch = (pid: number) =>
      writeFileSync(
        join(h, "antigravity", `${process.pid}.watch.json`),
        `${JSON.stringify({ pid, procStart: "w0", agyStart: "t0" })}\n`,
      );
    // A running watcher (this test process stands in for it): the shell answers.
    watch(process.pid);
    expect(run(REF)).toBe("{}");
    expect(run("5d1c9e2a-3b4f-4a6d-8e7f-0a1b2c3d4e5f")).toBe("ran agy-hello");
    expect(run(undefined)).toBe("ran agy-hello");
    // The watcher died without clearing its file (SIGKILL): Node again.
    const dead = Number(
      execFileSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }),
    );
    watch(dead);
    expect(run(REF)).toBe("ran agy-hello");
  });

  it("the daemon reads the home the hook sends sessions to: default, or the moved one (agy S2b)", () => {
    const hooks = (home: string) =>
      agyPluginFiles(BIN, home)["hooks.json"] as string;
    expect(parseAgyPluginHome(hooks(busHome({})))).toEqual({
      home: busHome({}),
      pinned: true,
    });
    expect(parseAgyPluginHome(hooks("/tmp/it's here/.oa-bus-2"))).toEqual({
      home: "/tmp/it's here/.oa-bus-2",
      pinned: true,
    });
  });

  it("an older plugin of ours is rewritten; doctor sees it as not wired until then", async () => {
    const { h, deps, dir } = setup();
    await installAdapters(deps);
    writeFileSync(join(dir, "hooks.json"), "{}\n");
    expect(checkAdapters(deps).antigravity).toBe("missing");
    await installAdapters(deps);
    expect(hooksOf(dir)).toEqual(
      JSON.parse(
        agyPluginFiles(BIN, join(h, ".oa-bus"))["hooks.json"] as string,
      ),
    );
  });

  it("a folder of that name that isn't ours is never touched, and doctor says so", async () => {
    const { h, deps, dir } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), '{"name":"mine"}');
    const r = await installAdapters(deps);
    expect(r.skipped.map((s) => s.harness)).toEqual(["antigravity"]);
    expect(read(join(dir, "plugin.json"))).toBe('{"name":"mine"}');
    expect(agyPluginProblem(h)).toEqual({ dir, problem: "foreign" });
    await uninstallAdapters(deps);
    expect(read(join(dir, "plugin.json"))).toBe('{"name":"mine"}');
  });

  it("uninstall removes only our files, even with the switch off; the user's stay", async () => {
    const { deps, dir } = setup();
    await installAdapters(deps);
    const r = await uninstallAdapters({ ...deps, env: {} });
    expect(r.removed).toEqual(["antigravity"]);
    expect(existsSync(dir)).toBe(false);
    await installAdapters(deps);
    writeFileSync(join(dir, "notes.txt"), "mine");
    await uninstallAdapters(deps);
    expect(read(join(dir, "notes.txt"))).toBe("mine");
    expect(existsSync(join(dir, "hooks.json"))).toBe(false);
  });

  it("doctor warns when agy has the plugin switched off", async () => {
    const { h, deps, dir } = setup();
    await installAdapters(deps);
    writeFileSync(
      join(h, ".gemini/config/config.json"),
      JSON.stringify({ plugins: { "oa-bus": { enabled: false } } }),
    );
    expect(agyPluginProblem(h)).toEqual({ dir, problem: "off" });
  });
});

function make(over: Partial<Ctx> = {}): Fake {
  const ctx = fakeCtx({
    which: (c) => c === "agy",
    env: { ...ON },
    service: {
      kind: "launchd" as const,
      ensure: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ unit: "launchd" as const })),
      cli: () => BIN,
      argv: () => BIN,
    },
    status: vi.fn(async () => status()),
    ...over,
  });
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
    { mode: 0o600 },
  );
  return ctx;
}

describe("install, doctor and uninstall --purge with the plugin (agy S2)", () => {
  it("doctor reports the plugin; purge leaves no agy folder install made", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(existsSync(join(agyPluginDir(ctx.userHome), "hooks.json"))).toBe(
      true,
    );
    await doctor(ctx);
    expect(ctx.all()).toContain("[[success]]✓[[/success]]  Antigravity wired");
    // agy S3: and the one rule that lets the session start its watcher.
    expect(ctx.all()).toContain(
      "[[success]]✓[[/success]]  Antigravity may start the bus watcher without asking",
    );
    const none = make();
    await install({ label: LABEL, hub: HUB }, none);
    writeFileSync(
      join(none.userHome, ".gemini/antigravity-cli/settings.json"),
      "{}\n",
    );
    await doctor(none);
    expect(none.all()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Antigravity will ask before it starts the bus watcher",
      ]),
    );
    const off = make();
    await install({ label: LABEL, hub: HUB }, off);
    writeFileSync(
      join(off.userHome, ".gemini/config/config.json"),
      JSON.stringify({ plugins: { "oa-bus": { enabled: false } } }),
    );
    await doctor(off);
    expect(off.all()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Antigravity has the oa-bus plugin turned off",
        "   Turn it on with: agy plugin enable oa-bus",
      ]),
    );
    await uninstall({ purge: false }, ctx);
    expect(existsSync(agyPluginDir(ctx.userHome))).toBe(false);
    // --purge removes the plugins folder once empty, when install made it.
    expect(leftoverTargets({ home: ctx.userHome }).dirs).toContain(
      join(ctx.userHome, ".gemini/config/plugins"),
    );
  });

  it("doctor fails a plugin folder that isn't ours, with the fix", async () => {
    const ctx = make();
    await install({ label: LABEL, hub: HUB }, ctx);
    const dir = agyPluginDir(ctx.userHome);
    for (const f of ["plugin.json", "hooks.json", AGY_PLUGIN_MARKER])
      writeFileSync(join(dir, f), "");
    execFileSync("rm", [join(dir, AGY_PLUGIN_MARKER)]);
    await doctor(ctx);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  Antigravity is not wired: ~/.gemini/config/plugins/oa-bus isn't oa-bus's",
      ]),
    );
  });
});

/** sh (300) under agy (200) under zsh (100). */
const TABLE: Record<number, { ppid: number; name: string }> = {
  100: { ppid: 1, name: "-zsh" },
  200: { ppid: 100, name: "/Users/u/.local/bin/agy" },
  300: { ppid: 200, name: "/bin/sh" },
};
const payload = JSON.stringify({
  conversationId: REF,
  cwd: "/w/app",
  workspacePaths: ["/w"],
  transcriptPath: "/t",
  hookEventName: "SessionStart",
});
const events = (ctx: Ctx) =>
  read(join(ctx.home, "logs", "events.log"))
    .trim()
    .split("\n")
    .map((l) => {
      const [, event, ...kv] = l.split(" ");
      const f: Record<string, unknown> = { event };
      for (const p of kv) {
        const i = p.indexOf("=");
        const v = p.slice(i + 1);
        f[p.slice(0, i)] = /^\d+$/.test(v) ? Number(v) : v;
      }
      return f;
    });

describe("oa-bus agy-hello (agy S2)", () => {
  it("parses as its own command", () => {
    expect(parse(["agy-hello"])).toMatchObject({ cmd: "agy-hello" });
  });

  it("says hello for the agy above it, records the conversation, and prints {}", async () => {
    const ctx = fakeCtx();
    const hellos: unknown[] = [];
    expect(
      await agyHello(ctx, {
        stdin: async () => payload,
        proc: (pid) => TABLE[pid] ?? null,
        procStart: (pid) => (pid === 200 ? "t0" : null),
        title: async () => undefined,
        hello: async (h) => {
          hellos.push(h);
          return "agy";
        },
        ppid: 300,
      }),
    ).toBe(0);
    expect(ctx.out()).toEqual(["{}"]);
    expect(hellos).toEqual([
      expect.objectContaining({
        kind: "antigravity",
        agent_ref: REF,
        pid: 200,
        cwd: "/w/app",
        proposed_name: "agy",
        attest: { proc_start: "t0" },
      }),
    ]);
    expect(readAgyConversation(ctx.home, 200)).toEqual({
      pid: 200,
      procStart: "t0",
      conversationId: REF,
      cwd: "/w/app",
    });
    expect(events(ctx).at(-1)).toMatchObject({
      event: AGY_HELLO_EVENT,
      state: "joined",
      pid: 200,
      ref: REF,
      name: "agy",
    });
  });

  it("names the session from agy's title when there is one", async () => {
    const ctx = fakeCtx();
    let name: unknown;
    await agyHello(ctx, {
      stdin: async () => payload,
      proc: (pid) => TABLE[pid] ?? null,
      procStart: () => "t0",
      title: async () => "Bus Check",
      hello: async (h) => {
        name = h.proposed_name;
        return "bus-check";
      },
      ppid: 300,
    });
    expect(name).toBe("bus-check");
  });

  it("never says hello without an agy above it; still prints {} and exits 0", async () => {
    const ctx = fakeCtx();
    const hello = vi.fn(async () => "x");
    expect(
      await agyHello(ctx, {
        stdin: async () => payload,
        proc: (pid) => TABLE[pid] ?? null,
        procStart: () => "t0",
        title: async () => undefined,
        hello,
        ppid: 100,
      }),
    ).toBe(0);
    expect(hello).not.toHaveBeenCalled();
    expect(ctx.out()).toEqual(["{}"]);
    expect(events(ctx).at(-1)).toMatchObject({ reason: "no_agy_ancestor" });
  });

  it("a bad payload or a refusal is logged, never thrown", async () => {
    const bad = fakeCtx();
    await agyHello(bad, {
      stdin: async () => "nope",
      proc: (pid) => TABLE[pid] ?? null,
      procStart: () => "t0",
      title: async () => undefined,
      hello: async () => "x",
      ppid: 300,
    });
    expect(events(bad).at(-1)).toMatchObject({ reason: "bad_payload" });
    const refused = fakeCtx();
    expect(
      await agyHello(refused, {
        stdin: async () => payload,
        proc: (pid) => TABLE[pid] ?? null,
        procStart: () => "t0",
        title: async () => undefined,
        hello: async () => {
          throw new HelloRefused({
            v: 1,
            id: "hello",
            type: "error",
            code: "unauthorized",
            message: "antigravity pid does not run agy",
          });
        },
        ppid: 300,
      }),
    ).toBe(0);
    expect(refused.out()).toEqual(["{}"]);
    expect(events(refused).at(-1)).toMatchObject({ reason: "refused" });
    // Not recorded: the hook's shell tries again at the next model call.
    expect(readAgyConversation(refused.home, 200)).toBeUndefined();
  });
});
