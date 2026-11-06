// The Hermes step: the plugin folder is copied to <hermes home>/plugins/oa-bus and
// enabled through Hermes's own CLI. Temp homes and a fake exec; nothing real runs.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMES_PLUGIN } from "@oa/bus-adapter-hermes";
import { describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  checkAdapters,
  type Exec,
  installAdapters,
  readAssets,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import {
  HERMES_MARKER,
  hermesEnabled,
  hermesHome,
  hermesPluginDir,
} from "../src/steps/hermes.ts";
import { installSkill, skillDir, uninstallSkill } from "../src/steps/skill.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** A shipped plugin: package files, plus the junk a source tree carries. */
function shipped() {
  const d = tmp("oa-hermes-src-");
  put(join(d, "plugin.yaml"), "name: oa-bus\nversion: 0.0.0\n");
  put(join(d, "__init__.py"), "def register(ctx): pass\n");
  put(join(d, "bus.py"), "X = 1\n");
  put(join(d, "__pycache__/bus.cpython-312.pyc"), "junk");
  return d;
}

type Reply = { code: number; stdout?: string; stderr?: string };
function setup(
  opts: {
    present?: string[];
    replies?: Record<string, Reply>;
    env?: Record<string, string>;
  } = {},
) {
  const home = tmp("oa-hermes-home-");
  const calls: string[][] = [];
  const present = opts.present ?? ["hermes"];
  const dirAtCall: Record<string, boolean> = {};
  const deps: AdapterDeps = {
    home,
    env: opts.env ?? {},
    busBin: ["/usr/local/bin/oa-bus"],
    assets: { pi: "PI", opencodePlugin: "OC", hermes: shipped() },
    which: (c) => present.includes(c),
    exec: (async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push([cmd, ...args]);
      dirAtCall[key] = existsSync(hermesPluginDir(home, opts.env ?? {}));
      const hit = Object.entries(opts.replies ?? {}).find(([k]) =>
        key.startsWith(k),
      )?.[1];
      return { stdout: "", stderr: "", ...(hit ?? { code: 0 }) };
    }) as Exec,
  };
  return {
    home,
    deps,
    calls,
    dirAtCall,
    dest: hermesPluginDir(home, opts.env ?? {}),
  };
}

const ENABLE = [
  "hermes",
  "plugins",
  "enable",
  "--no-allow-tool-override",
  "oa-bus",
];
const DISABLE = ["hermes", "plugins", "disable", "oa-bus"];
const ls = (d: string) => readdirSync(d).sort();

describe("hermesHome", () => {
  it("honors HERMES_HOME, else ~/.hermes", () => {
    expect(hermesHome("/h", {})).toBe("/h/.hermes");
    expect(hermesHome("/h", { HERMES_HOME: "  " })).toBe("/h/.hermes");
    expect(hermesHome("/h", { HERMES_HOME: "/opt/data" })).toBe("/opt/data");
    expect(hermesHome("/h", { HERMES_HOME: "~/x" })).toBe("/h/x");
  });
});

describe("installAdapters: hermes", () => {
  it("is absent without a hermes binary and touches nothing", async () => {
    const { deps, home, calls } = setup({ present: [] });
    const out = await installAdapters(deps);
    expect(out.absent).toContain("hermes");
    expect(out.hermesRestart).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });

  it("copies package files only, marks the folder ours, and enables non-interactively", async () => {
    const { deps, dest, calls, home } = setup({ present: ["hermes"] });
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["hermes"]);
    expect(out.hermesRestart).toBe(true);
    expect(ls(dest)).toEqual([
      HERMES_MARKER,
      "__init__.py",
      "bus.py",
      "plugin.yaml",
    ]);
    expect(dest).toBe(join(home, ".hermes/plugins/oa-bus"));
    expect(readFileSync(join(dest, HERMES_MARKER), "utf8")).toMatch(
      /^managed by the Open Artifacts bus installer: .* [0-9a-f]{16}\n$/,
    );
    expect(calls).toEqual([ENABLE]);
    // Nothing else appears in the Hermes home.
    expect(ls(join(home, ".hermes"))).toEqual(["plugins"]);
    expect(ls(join(home, ".hermes/plugins"))).toEqual(["oa-bus"]);
  });

  it("puts the plugin under HERMES_HOME when set", async () => {
    const root = tmp("oa-hermes-root-");
    const { deps, dest } = setup({ env: { HERMES_HOME: root } });
    await installAdapters(deps);
    expect(dest).toBe(join(root, "plugins/oa-bus"));
    expect(existsSync(join(dest, "plugin.yaml"))).toBe(true);
  });

  it("is idempotent: a current folder is left as is, enable runs again", async () => {
    const { deps, dest, calls } = setup();
    await installAdapters(deps);
    const inode = lstatSync(dest).ino;
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["hermes"]);
    expect(lstatSync(dest).ino).toBe(inode);
    expect(calls).toEqual([ENABLE, ENABLE]);
  });

  it("replaces a stale folder of ours, dropping files the plugin no longer has", async () => {
    const { deps, dest } = setup();
    await installAdapters(deps);
    put(join(dest, "bus.py"), "X = 'edited'\n");
    put(join(dest, "old.py"), "gone\n");
    await installAdapters(deps);
    expect(readFileSync(join(dest, "bus.py"), "utf8")).toBe("X = 1\n");
    expect(existsSync(join(dest, "old.py"))).toBe(false);
  });

  it("never replaces a folder it did not write", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "plugin.yaml"), "name: oa-bus\nmine: true\n");
    const out = await installAdapters(deps);
    expect(out.installed).toEqual([]);
    expect(out.skipped).toEqual([
      {
        harness: "hermes",
        reason: expect.stringContaining("not Open Artifacts bus's"),
      },
    ]);
    expect(readFileSync(join(dest, "plugin.yaml"), "utf8")).toContain(
      "mine: true",
    );
    expect(ls(dest)).toEqual(["plugin.yaml"]);
    expect(calls).toEqual([]);
  });

  it("refuses a symlinked folder", async () => {
    const { deps, dest } = setup();
    mkdirSync(join(dest, ".."), { recursive: true });
    const other = tmp("oa-hermes-other-");
    (await import("node:fs")).symlinkSync(other, dest);
    const out = await installAdapters(deps);
    expect(out.skipped.map((s) => s.harness)).toEqual(["hermes"]);
    expect(readdirSync(other)).toEqual([]);
  });

  it("is skipped, not installed, when enable fails", async () => {
    const { deps } = setup({
      replies: { "hermes plugins enable": { code: 1, stderr: "boom\nmore" } },
    });
    const out = await installAdapters(deps);
    expect(out.installed).toEqual([]);
    expect(out.hermesRestart).toBe(false);
    expect(out.skipped[0]?.reason).toContain(
      "`hermes plugins enable oa-bus` failed (boom)",
    );
  });

  it("ships the real plugin folder without bytecode or tests", async () => {
    const { deps, dest } = setup();
    deps.assets = readAssets();
    expect(deps.assets.hermes).toBe(HERMES_PLUGIN);
    await installAdapters(deps);
    const names = ls(dest);
    expect(names).toContain("plugin.yaml");
    expect(names).toContain("plugin.py");
    expect(names).not.toContain("__pycache__");
    expect(names).not.toContain("tests");
    expect(readFileSync(join(dest, "plugin.yaml"), "utf8")).toContain(
      "name: oa-bus",
    );
  });
});

describe("uninstallAdapters: hermes", () => {
  it("disables first, then removes our folder only", async () => {
    const { deps, dest, calls, dirAtCall, home } = setup();
    await installAdapters(deps);
    put(join(home, ".hermes/config.yaml"), "keep: me\n");
    calls.length = 0;
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual(["hermes"]);
    expect(calls).toEqual([DISABLE]);
    // Hermes refuses to disable a plugin it cannot find.
    expect(dirAtCall[DISABLE.join(" ")]).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect(readFileSync(join(home, ".hermes/config.yaml"), "utf8")).toBe(
      "keep: me\n",
    );
  });

  it("does nothing when there is no folder", async () => {
    const { deps, calls } = setup();
    const out = await uninstallAdapters(deps);
    expect(out.removed).not.toContain("hermes");
    expect(out.skipped).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("leaves a folder it did not write, and does not disable it", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "plugin.yaml"), "name: oa-bus\n");
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual([]);
    expect(out.skipped[0]?.harness).toBe("hermes");
    expect(existsSync(join(dest, "plugin.yaml"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("removes the folder without hermes on PATH, running nothing", async () => {
    const { deps, dest, calls } = setup();
    await installAdapters(deps);
    calls.length = 0;
    deps.which = () => false;
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual(["hermes"]);
    expect(calls).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it("keeps the folder when disable fails, so a rerun can finish", async () => {
    const { deps, dest } = setup();
    await installAdapters(deps);
    deps.exec = async () => ({ code: 2, stdout: "", stderr: "no" });
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual([]);
    expect(out.skipped[0]?.reason).toContain("failed (no)");
    expect(existsSync(dest)).toBe(true);
  });
});

describe("checkAdapters: hermes", () => {
  const check = (s: ReturnType<typeof setup>, present = ["hermes"]) =>
    checkAdapters({
      home: s.home,
      env: s.deps.env,
      which: (c) => present.includes(c),
      hermesPlugin: s.deps.assets.hermes,
    }).hermes;

  it("is absent, missing, configured, missing again when edited", async () => {
    const s = setup();
    expect(check(s, [])).toBe("absent");
    expect(check(s)).toBe("missing");
    await installAdapters(s.deps);
    expect(check(s)).toBe("configured");
    put(join(s.dest, "bus.py"), "X = 2\n");
    expect(check(s)).toBe("missing");
  });

  it("is missing for a folder that is not ours, and never execs", async () => {
    const s = setup();
    put(join(s.dest, "plugin.yaml"), "name: oa-bus\n");
    expect(check(s)).toBe("missing");
    expect(s.calls).toEqual([]);
  });
});

describe("hermesEnabled", () => {
  const list = (stdout: string, code = 0) => ({
    exec: (async () => ({ code, stdout, stderr: "" })) as Exec,
  });
  it("reads `hermes plugins list --json`", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (c, a) => {
      seen.push([c, ...a]);
      return {
        code: 0,
        stdout: JSON.stringify([{ name: "oa-bus", status: "enabled" }]),
        stderr: "",
      };
    };
    expect(await hermesEnabled({ exec })).toBe(true);
    expect(seen).toEqual([["hermes", "plugins", "list", "--json", "--user"]]);
  });
  it("is false for disabled, not enabled, absent, errors and non-JSON", async () => {
    for (const status of ["disabled", "not enabled"])
      expect(
        await hermesEnabled(list(JSON.stringify([{ name: "oa-bus", status }]))),
      ).toBe(false);
    expect(
      await hermesEnabled(
        list(JSON.stringify([{ name: "other", status: "enabled" }])),
      ),
    ).toBe(false);
    expect(await hermesEnabled(list("No plugins installed."))).toBe(false);
    expect(await hermesEnabled(list("[]", 1))).toBe(false);
    expect(
      await hermesEnabled({
        exec: async () => {
          throw new Error("x");
        },
      }),
    ).toBe(false);
  });
});

describe("the Hermes skill", () => {
  const SKILL = `---\nname: open-artifacts-oa-example\n---\n\n# Open Artifacts\n`;
  const fetchSkill = async () => SKILL;

  it("goes under <hermes home>/skills and comes out again", async () => {
    const home = tmp("oa-hermes-skill-");
    const root = tmp("oa-hermes-root-");
    for (const env of [{}, { HERMES_HOME: root }]) {
      const base = hermesHome(home, env);
      expect(skillDir({ home, env }, "hermes")).toBe(join(base, "skills"));
      const r = await installSkill(
        { home, env, fetchSkill },
        "https://oa.example",
        ["hermes"],
      );
      const file = join(base, "skills/open-artifacts-oa-example/SKILL.md");
      expect(r.written).toEqual([file]);
      expect(existsSync(file)).toBe(true);
      put(
        join(base, "skills/theirs/SKILL.md"),
        "---\nname: theirs\n---\nmine\n",
      );
      uninstallSkill({ home, env }, ["hermes"]);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(base, "skills/theirs/SKILL.md"))).toBe(true);
    }
  });
});
