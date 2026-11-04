import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  checkAdapters,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import {
  findCodexBin,
  removeCodexEntry,
  sandboxRisk,
  upsertCodexEntry,
} from "../src/steps/codex.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/dist/index.js"];
const FIXTURE = readFileSync(
  new URL("./fixtures/codex-config.toml", import.meta.url),
  "utf8",
);
const OURS = [
  "[mcp_servers.oa-bus]",
  `command = "${BIN[0]}"`,
  `args = ["${BIN[1]}", "mcp", "codex"]`,
  'default_tools_approval_mode = "approve"',
];

const tmp = () => mkdtempSync(join(tmpdir(), "ob-codex-"));

/** A temp HOME and CODEX_HOME; Codex is found by its home unless a test says otherwise. */
function setup(over: Partial<AdapterDeps> = {}, config?: string) {
  const h = tmp();
  const codexHome = join(h, "codex-home");
  mkdirSync(codexHome);
  if (config !== undefined)
    writeFileSync(join(codexHome, "config.toml"), config);
  const deps: AdapterDeps = {
    home: h,
    env: { CODEX_HOME: codexHome, PATH: "" },
    busBin: BIN,
    assets: { pi: "P", opencodePlugin: "J" },
    which: () => false,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...over,
  };
  const config_ = join(codexHome, "config.toml");
  return {
    h,
    codexHome,
    deps,
    config: config_,
    read: () => readFileSync(config_, "utf8"),
  };
}

/** An executable `codex` in a fresh folder. */
function fakeCodex(): { dir: string; bin: string } {
  const dir = tmp();
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** An app bundle with this bundle id and a bundled codex. */
function fakeApp(id: string): string {
  const app = join(tmp(), "ChatGPT.app");
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0"?>\n<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>${id}</string>\n</dict></plist>\n`,
  );
  writeFileSync(join(app, "Contents/Resources/codex"), "#!/bin/sh\n");
  chmodSync(join(app, "Contents/Resources/codex"), 0o755);
  return app;
}

describe("Codex install (C26e)", () => {
  it("appends only our table: every other byte of the config is kept", async () => {
    const s = setup({}, FIXTURE);
    const out = await installAdapters(s.deps);
    expect(out.installed).toEqual(["codex"]);
    expect(s.read()).toBe(`${FIXTURE}\n${OURS.join("\n")}\n`);
    const doc = parse(s.read()) as {
      mcp_servers: Record<string, unknown>;
      desktop: unknown;
    };
    expect(Object.keys(doc.mcp_servers)).toEqual([
      "github",
      "docs.local",
      "oa_bus",
    ]);
    expect(doc.desktop).toMatchObject({ followUpQueueMode: "queue" });
  });

  it("keeps a .oa-bus.bak of the first config, once", async () => {
    const s = setup({}, FIXTURE);
    await installAdapters(s.deps);
    const bak = `${s.config}.oa-bus.bak`;
    expect(readFileSync(bak, "utf8")).toBe(FIXTURE);
    // A later change of ours never replaces the backup.
    s.deps.busBin = ["/other/oa-bus"];
    await installAdapters(s.deps);
    expect(readFileSync(bak, "utf8")).toBe(FIXTURE);
    expect(readdirSync(s.codexHome).sort()).toEqual([
      "config.toml",
      "config.toml.oa-bus.bak",
    ]);
  });

  it("is idempotent: a second install changes no byte", async () => {
    const s = setup({}, FIXTURE);
    await installAdapters(s.deps);
    const once = s.read();
    const mtime = statSync(s.config).mtimeMs;
    const again = await installAdapters(s.deps);
    expect(again.installed).toEqual(["codex"]);
    expect(s.read()).toBe(once);
    expect(statSync(s.config).mtimeMs).toBe(mtime);
  });

  it("replaces a stale entry in place, its neighbours untouched", async () => {
    const before = [
      "# top",
      "[mcp_servers.oa-bus]",
      'command = "/old/oa-bus"',
      'args = ["mcp", "claude"]',
      "startup_timeout_sec = 5 # old",
      "",
      "[mcp_servers.oa-bus.env]",
      'X = "1"',
      "",
      "# about desktop",
      "[desktop]",
      'followUpQueueMode = "steer"',
      "",
    ].join("\n");
    const s = setup({}, before);
    await installAdapters(s.deps);
    expect(s.read()).toBe(
      [
        "# top",
        ...OURS,
        "",
        "# about desktop",
        "[desktop]",
        'followUpQueueMode = "steer"',
        "",
      ].join("\n"),
    );
  });

  it("creates the config when Codex has none", async () => {
    const s = setup();
    await installAdapters(s.deps);
    expect(s.read()).toBe(`${OURS.join("\n")}\n`);
    expect(existsSync(`${s.config}.oa-bus.bak`)).toBe(false);
  });

  it("keeps CRLF line ends", async () => {
    const s = setup({}, 'model = "x"\r\n');
    await installAdapters(s.deps);
    expect(s.read()).toBe(`model = "x"\r\n\r\n${OURS.join("\r\n")}\r\n`);
  });

  it("passes a moved Open Artifacts bus home in the entry's env: Codex filters it", async () => {
    const s = setup({}, "");
    s.deps.busHome = join(s.h, "elsewhere");
    await installAdapters(s.deps);
    expect(s.read()).toContain(
      `env = { OA_BUS_HOME = "${join(s.h, "elsewhere")}" }`,
    );
  });

  it("leaves a config that is not TOML untouched and says why", async () => {
    const bad = "[mcp_servers.oa-bus\ncommand = 1\n";
    const s = setup({}, bad);
    const out = await installAdapters(s.deps);
    expect(out.installed).toEqual([]);
    expect(out.skipped).toEqual([
      {
        harness: "codex",
        reason: `${s.config} is not valid TOML`,
      },
    ]);
    expect(s.read()).toBe(bad);
    expect(existsSync(`${s.config}.oa-bus.bak`)).toBe(false);
  });

  it("refuses an entry written as an inline table or dotted keys", async () => {
    for (const text of [
      'mcp_servers = { oa_bus = { command = "x" } }\n',
      '[mcp_servers]\noa_bus.command = "x"\n',
    ]) {
      const s = setup({}, text);
      const out = await installAdapters(s.deps);
      expect(out.skipped[0]?.reason).toMatch(/in a form install can't edit/);
      expect(s.read()).toBe(text);
    }
  });

  it("install --check's read writes nothing", async () => {
    const s = setup({}, FIXTURE);
    expect(checkAdapters(s.deps).codex).toBe("missing");
    expect(readdirSync(s.codexHome)).toEqual(["config.toml"]);
    expect(s.read()).toBe(FIXTURE);
    await installAdapters(s.deps);
    expect(checkAdapters(s.deps).codex).toBe("configured");
  });

  it("an entry without approval, or not ours, is not wired", () => {
    const s = setup(
      {},
      `${OURS.slice(0, 3).join("\n")}\ndefault_tools_approval_mode = "prompt"\n`,
    );
    expect(checkAdapters(s.deps).codex).toBe("missing");
    writeFileSync(
      s.config,
      '[mcp_servers.oa-bus]\ncommand = "x"\nargs = []\n',
    );
    expect(checkAdapters(s.deps).codex).toBe("missing");
  });
});

describe("Codex detection", () => {
  it("is found by PATH, by CODEX_HOME, or by the app; else absent", async () => {
    const h = tmp();
    const base = {
      home: h,
      busBin: BIN,
      assets: { pi: "P", opencodePlugin: "J" },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const none = { ...base, env: {}, which: () => false };
    expect(checkAdapters(none).codex).toBe("absent");
    expect((await installAdapters(none)).absent).toContain("codex");
    expect(existsSync(join(h, ".codex"))).toBe(false);
    // The app only when its bundle id is Codex's.
    expect(
      checkAdapters({ ...none, codexApp: fakeApp("com.openai.chat") }).codex,
    ).toBe("absent");
    expect(
      checkAdapters({ ...none, codexApp: fakeApp("com.openai.codex") }).codex,
    ).toBe("missing");
    expect(
      checkAdapters({ ...none, which: (c: string) => c === "codex" }).codex,
    ).toBe("missing");
    mkdirSync(join(h, ".codex"));
    expect(checkAdapters(none).codex).toBe("missing");
  });
});

describe("Codex wake binary", () => {
  it("pins codex from PATH for the daemon", async () => {
    const { dir, bin } = fakeCodex();
    const s = setup({}, "");
    s.deps.env = { ...s.deps.env, PATH: `relative:${dir}` };
    const out = await installAdapters(s.deps);
    expect(out.codexNoWake).toBe(false);
    const pin = join(s.h, ".oa-bus/codex.json");
    expect(JSON.parse(readFileSync(pin, "utf8"))).toEqual({ bin });
    expect(statSync(pin).mode & 0o777).toBe(0o600);
  });

  it("falls back to the app's bundled codex", () => {
    const app = fakeApp("com.openai.codex");
    expect(findCodexBin({ path: "", app })).toBe(
      join(app, "Contents/Resources/codex"),
    );
    expect(findCodexBin({ path: "", app: fakeApp("x.y") })).toBeUndefined();
  });

  it("without one, install still succeeds, says so, and drops a stale pin", async () => {
    const s = setup({}, "");
    const pin = join(s.h, ".oa-bus/codex.json");
    mkdirSync(join(s.h, ".oa-bus"));
    writeFileSync(pin, '{"bin":"/gone/codex"}\n');
    const out = await installAdapters(s.deps);
    expect(out.installed).toEqual(["codex"]);
    expect(out.codexNoWake).toBe(true);
    expect(existsSync(pin)).toBe(false);
  });
});

describe("Codex uninstall", () => {
  it("removes only our table and the pin: the config reads as before", async () => {
    const { dir } = fakeCodex();
    const s = setup({}, FIXTURE);
    s.deps.env = { ...s.deps.env, PATH: dir };
    await installAdapters(s.deps);
    expect(existsSync(join(s.h, ".oa-bus/codex.json"))).toBe(true);
    const out = await uninstallAdapters(s.deps);
    expect(out.removed).toEqual(["codex"]);
    expect(s.read()).toBe(FIXTURE);
    expect(existsSync(join(s.h, ".oa-bus/codex.json"))).toBe(false);
    // The user's backup stays.
    expect(existsSync(`${s.config}.oa-bus.bak`)).toBe(true);
    expect((await uninstallAdapters(s.deps)).removed).toEqual([]);
  });

  it("works on a config whose Codex is gone, and leaves other tables", async () => {
    const s = setup({}, "");
    await installAdapters(s.deps);
    writeFileSync(
      s.config,
      `[a]\nx = 1\n\n${OURS.join("\n")}\n\n# b\n[b]\ny = 2\n`,
    );
    s.deps.env = { CODEX_HOME: s.codexHome };
    const out = await uninstallAdapters({ ...s.deps, which: () => false });
    expect(out.removed).toEqual(["codex"]);
    expect(s.read()).toBe("[a]\nx = 1\n\n# b\n[b]\ny = 2\n");
  });

  it("leaves a config that is not TOML untouched", async () => {
    const s = setup({}, "[[[\n");
    const out = await uninstallAdapters(s.deps);
    expect(out.skipped[0]).toMatchObject({ harness: "codex" });
    expect(s.read()).toBe("[[[\n");
  });
});

describe("the TOML edit", () => {
  const doc = (t: string) => parse(t) as Record<string, unknown>;
  const entry = {
    command: "c",
    args: ["mcp", "codex"],
    default_tools_approval_mode: "approve" as const,
  };

  it("is never fooled by a header inside a multi-line string", () => {
    const text = `a = '''\n[mcp_servers.oa-bus]\n'''\n`;
    const next = upsertCodexEntry("f", text, doc(text), entry);
    expect(next.startsWith(text)).toBe(true);
    expect(removeCodexEntry("f", next, doc(next))).toBe(text);
  });

  it("finds a quoted table name", () => {
    const text = `[mcp_servers."oa_bus"]\ncommand = "old"\n\n[z]\n`;
    expect(upsertCodexEntry("f", text, doc(text), entry)).toBe(
      `[mcp_servers.oa-bus]\ncommand = "c"\nargs = ["mcp", "codex"]\ndefault_tools_approval_mode = "approve"\n\n[z]\n`,
    );
  });

  it("escapes values as TOML strings", () => {
    const e = { ...entry, command: 'C:\\a "b"' };
    const next = upsertCodexEntry("f", "", {}, e);
    expect((doc(next).mcp_servers as Record<string, unknown>).oa-bus).toEqual(
      e,
    );
  });
});

describe("review fixes", () => {
  const doc = (t: string) => parse(t) as Record<string, unknown>;
  const entry = {
    command: "c",
    args: ["mcp", "codex"],
    default_tools_approval_mode: "approve" as const,
  };
  const block = `[mcp_servers.oa-bus]\ncommand = "c"\nargs = ["mcp", "codex"]\ndefault_tools_approval_mode = "approve"\n`;

  it("I1: ours first, then [projects.*] and [desktop], then another server", () => {
    const text = `model = "o3"\n\n${block}\n[projects."/Users/x/code"]\ntrust_level = "trusted"\n\n[desktop]\nfollowUpQueueMode = "queue"\n\n[mcp_servers.foo]\ncommand = "f"\n`;
    expect(upsertCodexEntry("f", text, doc(text), entry)).toBe(text);
    expect(removeCodexEntry("f", text, doc(text))).toBe(
      `model = "o3"\n\n[projects."/Users/x/code"]\ntrust_level = "trusted"\n\n[desktop]\nfollowUpQueueMode = "queue"\n\n[mcp_servers.foo]\ncommand = "f"\n`,
    );
  });

  it("M4: an escaped quote inside a multi-line basic string does not close it", () => {
    const text = `p = """a \\""" b"""\n\n${block}`;
    expect(doc(text).p).toBe('a """ b');
    expect(upsertCodexEntry("f", text, doc(text), entry)).toBe(text);
    expect(removeCodexEntry("f", text, doc(text))).toBe(
      `p = """a \\""" b"""\n`,
    );
  });

  it("M1: mixed line endings: no byte outside our table changes", () => {
    const text = "a = 1\r\nb = 2\n[desktop]\nc = 3\r\n";
    const once = upsertCodexEntry("f", text, doc(text), entry);
    // Appended with the file's last ending, after one blank line.
    expect(once).toBe(`${text}\r\n${block.replaceAll("\n", "\r\n")}`);
    expect(upsertCodexEntry("f", once, doc(once), entry)).toBe(once);
    expect(removeCodexEntry("f", once, doc(once))).toBe(text);
    // In the middle: replaced in place, its neighbours' endings kept.
    const mid = `a = 1\r\n[mcp_servers.oa-bus]\r\ncommand = "old"\n\n[desktop]\r\nc = 3\n`;
    const set = upsertCodexEntry("f", mid, doc(mid), entry);
    expect(set).toBe(
      `a = 1\r\n${block.trimEnd().replaceAll("\n", "\r\n")}\n\n[desktop]\r\nc = 3\n`,
    );
    expect(upsertCodexEntry("f", set, doc(set), entry)).toBe(set);
    expect(removeCodexEntry("f", set, doc(set))).toBe(
      "a = 1\r\n[desktop]\r\nc = 3\n",
    );
  });

  it("M1: LF after CRLF appends with LF, no stray CRLF", () => {
    const text = "a = 1\r\nb = 2\n";
    const once = upsertCodexEntry("f", text, doc(text), entry);
    expect(once).toBe(`${text}\n${block}`);
    expect(removeCodexEntry("f", once, doc(once))).toBe(text);
  });

  it("M5: a subtable set apart from ours is ours too, for install and uninstall", () => {
    const text = `a = 1\n\n[mcp_servers.oa-bus]\ncommand = "old"\n\n[desktop]\nx = 1\n\n[mcp_servers.oa-bus.env]\nK = "v"\n\n[b]\ny = 2\n`;
    const once = upsertCodexEntry("f", text, doc(text), entry);
    expect(once).toBe(`a = 1\n\n${block}\n[desktop]\nx = 1\n\n[b]\ny = 2\n`);
    expect(upsertCodexEntry("f", once, doc(once), entry)).toBe(once);
    expect(removeCodexEntry("f", text, doc(text))).toBe(
      "a = 1\n\n[desktop]\nx = 1\n\n[b]\ny = 2\n",
    );
  });

  it("M3: configured means the entry install would write, env included", async () => {
    const s = setup({}, "");
    s.deps.busHome = join(s.h, "moved");
    await installAdapters(s.deps);
    expect(checkAdapters(s.deps).codex).toBe("configured");
    expect(checkAdapters({ ...s.deps, busBin: BIN }).codex).toBe(
      "configured",
    );
    // A stale home in the entry's env, or none when one is needed.
    s.deps.busHome = join(s.h, "moved again");
    expect(checkAdapters(s.deps).codex).toBe("missing");
    s.deps.busHome = undefined;
    expect(checkAdapters(s.deps).codex).toBe("missing");
    await installAdapters(s.deps);
    expect(checkAdapters(s.deps).codex).toBe("configured");
    // A known argv must match too.
    expect(
      checkAdapters({ ...s.deps, busBin: ["/other/node", "x.js"] }).codex,
    ).toBe("missing");
  });

  it("M2: the active profile's sandbox, and writable_roots over CODEX_HOME", () => {
    const home = "/u";
    const dir = "/u/.codex";
    const risk = (t: string) => sandboxRisk(doc(t), home, dir);
    expect(risk('sandbox_mode = "danger-full-access"\n')).toBe("full-access");
    expect(risk('sandbox_mode = "workspace-write"\n')).toBeUndefined();
    const prof = (mode: string) =>
      `profile = "p"\nsandbox_mode = "workspace-write"\n[profiles.p]\nsandbox_mode = "${mode}"\n`;
    expect(risk(prof("danger-full-access"))).toBe("full-access");
    expect(risk(prof("read-only"))).toBeUndefined();
    // A profile not chosen does not count.
    expect(
      risk('[profiles.yolo]\nsandbox_mode = "danger-full-access"\n'),
    ).toBeUndefined();
    const roots = (r: string, mode = "workspace-write") =>
      `sandbox_mode = "${mode}"\n[sandbox_workspace_write]\nwritable_roots = [${r}]\n`;
    expect(risk(roots('"/tmp", "~"'))).toBe("writable-root");
    expect(risk(roots('"~/.codex"'))).toBe("writable-root");
    // Inside the home: a thread could append to its rollouts.
    expect(risk(roots('"/u/.codex/sessions"'))).toBe("writable-root");
    expect(risk(roots('"~/.codex/sessions/2026"'))).toBe("writable-root");
    expect(risk(roots('"/u/work"'))).toBeUndefined();
    expect(risk(roots('"/u/.codexx"'))).toBeUndefined();
    expect(risk(roots('"/"', "read-only"))).toBeUndefined();
    expect(
      risk(
        `profile = "p"\n[profiles.p.sandbox_workspace_write]\nwritable_roots = ["/u"]\n`,
      ),
    ).toBe("writable-root");
  });

  it("R1: a leading BOM stays in front, and our first-line table is found", () => {
    const bom = "\uFEFF";
    const first = `${bom}${block}\n[desktop]\nx = 1\n`;
    expect(upsertCodexEntry("f", first, doc(first), entry)).toBe(first);
    expect(removeCodexEntry("f", first, doc(first))).toBe(
      `${bom}[desktop]\nx = 1\n`,
    );
    const stale = `${bom}[mcp_servers.oa-bus]\ncommand = "old"\n`;
    expect(upsertCodexEntry("f", stale, doc(stale), entry)).toBe(
      `${bom}${block}`,
    );
    const other = `${bom}a = 1\n`;
    const once = upsertCodexEntry("f", other, doc(other), entry);
    expect(once).toBe(`${other}\n${block}`);
    expect(removeCodexEntry("f", once, doc(once))).toBe(other);
  });
});
