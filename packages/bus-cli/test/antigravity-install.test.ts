// agy S1b: `oa-bus install` wires Antigravity (agy) behind OA_BUS_EXPERIMENTAL_AGY=1.
// A fake agy on PATH (deps.which) and a scratch HOME only: no real agy runs.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsoncValue } from "@oa/bus-adapter-mcp-json";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import {
  type AdapterDeps,
  agyProblem,
  checkAdapters,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { leftoverTargets } from "../src/steps/leftovers.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const ON = { OA_BUS_EXPERIMENTAL_AGY: "1" };

function setup(opts: { env?: Record<string, string>; onPath?: boolean } = {}): {
  h: string;
  deps: AdapterDeps;
  file: string;
} {
  const h = mkdtempSync(join(tmpdir(), "ob-agy-"));
  const deps: AdapterDeps = {
    home: h,
    env: opts.env ?? ON,
    busBin: BIN,
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => (opts.onPath ?? true) && cmd === "agy",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { h, deps, file: join(h, ".gemini/config/mcp_config.json") };
}

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");
/** Our entry, pinned to the bus home it was installed for, default too (agy S2b). */
const ours = (busHome: string) => ({
  command: BIN[0],
  args: [BIN[1], "mcp", "antigravity"],
  env: { OA_BUS_HOME: busHome },
});

// The shape `agy mcp add` writes, with comments and a trailing comma agy accepts.
const THEIRS = `{
  // mine
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"], /* keep */
    },
    "remote": { "url": "https://mcp.example.com/mcp" },
  },
  "other": true
}
`;

describe("Antigravity wiring (agy S1b)", () => {
  it("is off without OA_BUS_EXPERIMENTAL_AGY=1: nothing found, nothing written", async () => {
    const { deps, file } = setup({ env: {} });
    const r = await installAdapters(deps);
    expect(r.installed).not.toContain("antigravity");
    expect(r.absent).toContain("antigravity");
    expect(() => lstatSync(file)).toThrow();
    expect(checkAdapters(deps).antigravity).toBe("absent");
  });

  it("adds the oa_bus stdio entry when agy is on PATH", async () => {
    const { h, deps, file } = setup();
    const r = await installAdapters(deps);
    expect(r.installed).toEqual(["antigravity"]);
    expect(JSON.parse(read(file))).toEqual({
      mcpServers: { oa_bus: ours(join(h, ".oa-bus")) },
    });
    expect(checkAdapters(deps).antigravity).toBe("configured");
    expect(checkAdapters({ ...deps, busBin: undefined }).antigravity).toBe(
      "configured",
    );
  });

  it("finds agy by its folder when it is not on PATH", async () => {
    const { h, deps, file } = setup({ onPath: false });
    expect(checkAdapters(deps).antigravity).toBe("absent");
    mkdirSync(join(h, ".gemini/antigravity"), { recursive: true });
    expect(checkAdapters(deps).antigravity).toBe("missing");
    await installAdapters(deps);
    expect(JSON.parse(read(file)).mcpServers.oa_bus).toEqual(
      ours(join(h, ".oa-bus")),
    );
  });

  it("keeps every other key and entry byte for byte, and uninstall gives the file back", async () => {
    const { deps, file } = setup();
    put(file, THEIRS);
    await installAdapters(deps);
    const after = read(file);
    expect(after.startsWith(THEIRS.slice(0, THEIRS.indexOf('"remote"')))).toBe(
      true,
    );
    expect(after).toContain('"other": true');
    expect(after).toContain("/* keep */");
    expect(checkAdapters(deps).antigravity).toBe("configured");
    const r = await uninstallAdapters(deps);
    expect(r.removed).toEqual(["antigravity"]);
    expect(read(file)).toBe(THEIRS);
  });

  it("a second install changes nothing", async () => {
    const { deps, file } = setup();
    put(file, THEIRS);
    await installAdapters(deps);
    const text = read(file);
    const ino = statSync(file).ino;
    await installAdapters(deps);
    expect(read(file)).toBe(text);
    // Not rewritten: an atomic write would be a new inode.
    expect(statSync(file).ino).toBe(ino);
  });

  it("takes agy's empty file, and uninstall leaves {} for purge to see as empty", async () => {
    const { h, deps, file } = setup();
    put(file, "");
    await installAdapters(deps);
    expect(JSON.parse(read(file)).mcpServers.oa_bus).toEqual(
      ours(join(h, ".oa-bus")),
    );
    await uninstallAdapters(deps);
    expect(JSON.parse(read(file))).toEqual({});
    expect(leftoverTargets({ home: h, env: deps.env }).files).toContain(file);
  });

  it("keeps the user's own keys on our entry, like a server they turned off", async () => {
    const { h, deps, file } = setup();
    put(
      file,
      JSON.stringify({
        mcpServers: {
          oa_bus: {
            command: "/old/oa-bus",
            args: ["mcp", "antigravity"],
            disabled: true,
            env: { DEBUG: "1" },
          },
        },
      }),
    );
    await installAdapters(deps);
    expect(JSON.parse(read(file)).mcpServers.oa_bus).toEqual({
      ...ours(join(h, ".oa-bus")),
      disabled: true,
      env: { DEBUG: "1", OA_BUS_HOME: join(h, ".oa-bus") },
    });
    expect(agyProblem(deps)).toEqual({ file, problem: "disabled" });
  });

  it("a moved bus home goes in the entry's env, and back to the default pin", async () => {
    const { h, deps, file } = setup();
    const moved = { ...deps, busHome: join(h, "elsewhere") };
    await installAdapters(moved);
    expect(JSON.parse(read(file)).mcpServers.oa_bus.env).toEqual({
      OA_BUS_HOME: join(h, "elsewhere"),
    });
    expect(checkAdapters(moved).antigravity).toBe("configured");
    expect(checkAdapters(deps).antigravity).toBe("missing");
    await installAdapters(deps);
    expect(JSON.parse(read(file)).mcpServers.oa_bus).toEqual(
      ours(join(h, ".oa-bus")),
    );
  });

  it("writes through a symlink: the link stays a link", async () => {
    const { h, deps, file } = setup();
    const real = join(h, "dotfiles/mcp_config.json");
    put(real, THEIRS);
    mkdirSync(join(file, ".."), { recursive: true });
    symlinkSync(real, file);
    await installAdapters(deps);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(jsoncValue(read(real), ["mcpServers", "oa_bus"])).toEqual(
      ours(join(h, ".oa-bus")),
    );
    expect(realpathSync(file)).toBe(realpathSync(real));
  });

  it("keeps a byte-order mark agy wrote", async () => {
    const { deps, file } = setup();
    put(file, `﻿${THEIRS}`);
    await installAdapters(deps);
    expect(read(file).startsWith("﻿{")).toBe(true);
    expect(checkAdapters(deps).antigravity).toBe("configured");
    await uninstallAdapters(deps);
    expect(read(file)).toBe(`﻿${THEIRS}`);
  });

  it("skips a file that isn't JSON and leaves it untouched", async () => {
    const { deps, file } = setup();
    put(file, "{ not json");
    const r = await installAdapters(deps);
    expect(r.skipped.map((s) => s.harness)).toEqual(["antigravity"]);
    expect(read(file)).toBe("{ not json");
    expect(agyProblem(deps)).toEqual({ file, problem: "malformed" });
    expect(checkAdapters(deps).antigravity).toBe("missing");
  });

  it("uninstall removes only our entry, even with the switch off", async () => {
    const { deps, file } = setup();
    put(file, THEIRS);
    await installAdapters(deps);
    const r = await uninstallAdapters({ ...deps, env: {} });
    expect(r.removed).toEqual(["antigravity"]);
    expect(read(file)).toBe(THEIRS);
    expect((await uninstallAdapters(deps)).removed).toEqual([]);
  });
});

/** A ctx with agy on PATH and the switch on, approved on HUB. */
function make(second = false, over: Partial<Ctx> = {}): Fake {
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
  if (second) ctx.home = join(ctx.userHome, "second-bus");
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
const agyFile = (ctx: Ctx) =>
  join(ctx.userHome, ".gemini/config/mcp_config.json");

describe("install, doctor and uninstall commands (agy S1b)", () => {
  it("install wires it, doctor says so, uninstall takes it out", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(ctx.out().join("\n")).toContain("Configured Antigravity");
    expect(JSON.parse(read(agyFile(ctx))).mcpServers.oa_bus).toEqual(
      ours(ctx.home),
    );
    await doctor(ctx);
    expect(ctx.all()).toContain("[[success]]✓[[/success]]  Antigravity wired");
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.out().join("\n")).toContain("Removed the bus from Antigravity");
    expect(JSON.parse(read(agyFile(ctx)))).toEqual({});
  });

  it("doctor: not wired, and a file that isn't JSON, each with a fix", async () => {
    const ctx = make();
    await doctor(ctx);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  Antigravity is not wired",
        "   Run npx @open-artifacts/bus to wire it.",
      ]),
    );
    const bad = make();
    put(agyFile(bad), "{ nope");
    await doctor(bad);
    expect(bad.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  Antigravity is not wired: ~/.gemini/config/mcp_config.json isn't valid JSON",
        "   Fix that file, then run npx @open-artifacts/bus again.",
      ]),
    );
  });

  it("doctor says nothing about Antigravity with the switch off", async () => {
    const ctx = make(false, { env: {} });
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("Antigravity");
  });

  it("a second bus home (--home, --alongside) leaves agy's config alone", async () => {
    const ctx = make(true);
    put(agyFile(ctx), THEIRS);
    expect(
      await install({ label: LABEL, hub: HUB, alongside: true }, ctx),
    ).toBe(0);
    expect(read(agyFile(ctx))).toBe(THEIRS);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(read(agyFile(ctx))).toBe(THEIRS);
  });
});

describe("oa-bus mcp antigravity (agy S1b)", () => {
  it("loads the Antigravity server", async () => {
    const { mcp } = await import("../src/commands/mcp.ts");
    const load = vi.fn(async () => ({}));
    expect(await mcp("antigravity", fakeCtx(), load)).toBeUndefined();
    expect(load).toHaveBeenCalledWith("antigravity");
  });
});
