import * as cp from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_CLIS,
  BLOCK_EXIT,
  guardEntriesOn,
  inTmp,
  STUB_DIR,
} from "./agent-cli-guard";

const pi_ = () => "/usr/bin/pi";

// The "real CLI" cases need a dir outside every temp root, since the guard
// trusts temp dirs. The repo's node_modules/.cache is that dir, except when
// the repo itself was cloned under /tmp (scripts/ci/public-only.sh does
// this); then fall back to the runner's RUNNER_TEMP, else skip.
const REPO = process.cwd().replace(/\/(apps|packages|scripts)\/.*$/, "");
const FAKE_ROOT = [
  join(REPO, "node_modules", ".cache"),
  process.env.RUNNER_TEMP,
].find((d): d is string => !!d && !inTmp(d));
const MSG = (n: string) => `real ${n} blocked by the test guard (#2168)`;

describe("agent CLI guard (#2168)", () => {
  it("puts the stub dir first on PATH", () => {
    expect(process.env.PATH?.split(delimiter)[0]).toBe(STUB_DIR);
  });

  it("moves every harness home into a temp dir", () => {
    for (const k of [
      "HOME",
      "XDG_CONFIG_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "OA_BUS_HOME",
      "PI_CODING_AGENT_DIR",
      "HERMES_HOME",
    ])
      expect(process.env[k]?.startsWith(tmpdir()), k).toBe(true);
  });

  it("blocks `pi --version`", () => {
    const r = cp.spawnSync("pi", ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(BLOCK_EXIT);
    expect(r.stderr).toContain(MSG("pi"));
  });

  it("blocks `/usr/bin/env claude --version`", () => {
    const r = cp.spawnSync("/usr/bin/env", ["claude", "--version"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(BLOCK_EXIT);
    expect(r.stderr).toContain(MSG("claude"));
  });

  it.each(AGENT_CLIS)("stub %s blocks, also inside bash", (name) => {
    const r = cp.spawnSync("bash", ["-c", `${name} mcp add x`], {
      encoding: "utf8",
    });
    expect(r.status).toBe(BLOCK_EXIT);
    expect(r.stderr).toContain(MSG(name));
  });

  describe.skipIf(!FAKE_ROOT)(
    "a real executable pi outside any temp dir",
    () => {
      // Under FAKE_ROOT (not a temp dir). The file writes a marker if it
      // ever runs.
      const dir = join(FAKE_ROOT ?? "", `agent-cli-guard-${process.pid}`);
      const marker = join(dir, "ran");
      const pi = join(dir, "pi");
      beforeAll(() => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(pi, `#!/bin/sh\ntouch "${marker}"\n`);
        chmodSync(pi, 0o755);
      });
      afterAll(() => rmSync(dir, { recursive: true, force: true }));
      afterEach(() => expect(existsSync(marker)).toBe(false));
      const blocked = /blocked by the test guard/;

      it("throws on its absolute path for all six functions", () => {
        expect(() => cp.spawnSync(pi, ["--version"])).toThrow(blocked);
        expect(() => cp.execFileSync(pi, [])).toThrow(blocked);
        expect(() => cp.execSync(`${pi} --version`)).toThrow(blocked);
        expect(() => cp.spawn(pi, [])).toThrow(blocked);
        expect(() => cp.execFile(pi, [], () => {})).toThrow(blocked);
        expect(() => cp.exec(`${pi} x`, () => {})).toThrow(blocked);
      });

      it("throws when a bare `pi` resolves to it through options.env.PATH", () => {
        expect(() => cp.spawn("pi", { env: { PATH: dir } })).toThrow(blocked);
        expect(() => cp.spawnSync("pi", { env: { PATH: dir } })).toThrow(
          blocked,
        );
      });

      it("throws when it hides behind another command or a shell", () => {
        expect(() => cp.spawnSync("timeout", ["5", pi])).toThrow(blocked);
        expect(() => cp.spawnSync("env", ["-u", "FOO", pi])).toThrow(blocked);
        expect(() => cp.spawnSync("sh", ["-c", pi])).toThrow(blocked);
        expect(() => cp.execSync(`cd / && ${pi}`)).toThrow(blocked);
        expect(() => cp.execSync(`echo hi; ${pi} x`)).toThrow(blocked);
      });
    },
  );

  describe.skipIf(!FAKE_ROOT)(
    "a guarded CLI run through its JS entry (#2207)",
    () => {
      // Like a global install: bin/pi is a symlink to lib/.../cli.js, outside
      // any temp dir. The marker proves it never ran.
      const dir = join(FAKE_ROOT ?? "", `agent-cli-guard-js-${process.pid}`);
      const cli = join(dir, "lib", "cli.js");
      const marker = join(dir, "ran");
      beforeAll(() => {
        mkdirSync(join(dir, "lib"), { recursive: true });
        mkdirSync(join(dir, "bin"));
        writeFileSync(
          cli,
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
        );
        symlinkSync(cli, join(dir, "bin", "pi"));
        guardEntriesOn(join(dir, "bin"));
      });
      afterAll(() => rmSync(dir, { recursive: true, force: true }));
      afterEach(() => expect(existsSync(marker)).toBe(false));
      const blocked = /blocked by the test guard/;

      it("throws on `node <abs>/cli.js` and `bun <abs>/cli.js`", () => {
        expect(() => cp.spawnSync("node", [cli])).toThrow(blocked);
        expect(() =>
          cp.execFileSync(process.execPath, ["--no-warnings", cli]),
        ).toThrow(blocked);
        expect(() => cp.spawn("bun", [cli])).toThrow(blocked);
        expect(() => cp.execSync(`node ${cli} mcp add x`)).toThrow(blocked);
        expect(() => cp.spawnSync("sh", ["-c", `exec node ${cli}`])).toThrow(
          blocked,
        );
      });

      it("also throws through the symlink path", () => {
        expect(() => cp.spawnSync("node", [join(dir, "bin", "pi")])).toThrow(
          blocked,
        );
      });

      it("scans `--flag=<abs>` words too", () => {
        expect(() =>
          cp.spawnSync("node", [`--require=${cli}`, "-e", "0"]),
        ).toThrow(blocked);
      });

      it("ignores a shared shim and its siblings", () => {
        const shim = mkdtempSync(join(tmpdir(), "oa-shim-"));
        const out = join(dir, "shim-bin");
        mkdirSync(out);
        // volta-style: pi and node both point at one shim; pi also -> a .txt
        writeFileSync(join(out, "volta-shim"), "#!/bin/sh\n");
        chmodSync(join(out, "volta-shim"), 0o755);
        symlinkSync(join(out, "volta-shim"), join(out, "pi"));
        symlinkSync(join(out, "volta-shim"), join(out, "node"));
        // a JS entry that a non-guarded tool in the same dir also resolves to
        writeFileSync(join(out, "tool.js"), "");
        chmodSync(join(out, "tool.js"), 0o755);
        symlinkSync(join(out, "tool.js"), join(out, "codex"));
        symlinkSync(join(out, "tool.js"), join(out, "npx"));
        guardEntriesOn(out);
        expect(cp.spawnSync("echo", [join(out, "volta-shim")]).status).toBe(0);
        expect(cp.spawnSync("echo", [join(out, "tool.js")]).status).toBe(0);
        rmSync(shim, { recursive: true, force: true });
      });

      it("leaves other node scripts alone", () => {
        const r = cp.spawnSync(
          process.execPath,
          ["-e", "process.stdout.write('ok')"],
          { encoding: "utf8" },
        );
        expect(r.stdout).toBe("ok");
      });
    },
  );

  it("keeps the exact makeExec call shape: promisify(execFile) with a timeout and a child holding stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-guard-shape-"));
    const sh = join(dir, "opencode");
    writeFileSync(sh, "#!/bin/sh\nsleep 30\necho 9.9.9\n");
    chmodSync(sh, 0o755);
    const t0 = Date.now();
    const p = promisify(cp.execFile)(sh, ["--version"], {
      maxBuffer: 1 << 20,
      timeout: 500,
      killSignal: "SIGKILL",
    });
    expect(p.child?.stdin).toBeDefined(); // the child rides on the promise
    await expect(p).rejects.toMatchObject({ killed: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    // callback form returns the ChildProcess; sync forms return their result
    const child = cp.execFile("echo", ["x"], () => {});
    expect(child.stdin).toBeDefined();
    expect(cp.spawnSync("echo", ["x"], { encoding: "utf8" }).stdout).toBe(
      "x\n",
    );
    expect(cp.execFileSync("echo", ["y"], { encoding: "utf8" })).toBe("y\n");
    expect(cp.execSync("echo z", { encoding: "utf8" })).toBe("z\n");
    expect(cp.spawn("echo", ["x"]).pid).toBeGreaterThan(0);
    // and the promisified forms still refuse a real binary
    await expect(async () => promisify(cp.execFile)(pi_(), [])).rejects.toThrow(
      /blocked by the test guard/,
    );
  }, 15_000);

  it("leaves other commands and fakes in a temp dir alone", () => {
    expect(cp.spawnSync("echo", ["hi"], { encoding: "utf8" }).stdout).toBe(
      "hi\n",
    );
    expect(readFileSync(join(STUB_DIR, "pi"), "utf8")).toContain("exit 97");
  });

  it("every Node vitest config wires the guard, or is allowlisted with a reason", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) =>
        /(^|\/)(vitest\.[\w.]*config\.ts|vite\.config\.ts)$/.test(f),
      );
    // A vite.config.ts is a vitest config only when it has a `test:` block
    // (vitest.config.ts wins over it when both exist).
    const isTestConfig = (f: string) =>
      !f.endsWith("vite.config.ts") ||
      /\btest:\s*\{/.test(readFileSync(join(root, f), "utf8"));
    const skip: Record<string, string> = {
      "apps/auth-broker/vitest.config.ts": "workerd pool",
      "apps/directory-broker/vitest.config.ts": "workerd pool",
      "apps/server/vitest.config.ts": "workerd pool",
      "apps/server/vitest.authz.config.ts": "workerd pool",
      "apps/server/vitest.cpu.config.ts": "workerd pool",
      "packages/provisioning-contract/vitest.workerd.config.ts": "workerd pool",
      "apps/server/vitest.bench.config.ts": "CPU bench",
      "apps/server/vitest.codecpu.config.ts": "CPU bench",
      "apps/server/vitest.smoke.config.ts": "live staging",
      "apps/server/vitest.xt.config.ts":
        "live staging, reads 0600 credential files",
      "apps/landing/vitest.browser.config.ts": "Playwright needs the real HOME",
      "packages/ui/vitest.browser.config.ts": "Playwright needs the real HOME",
    };
    expect(files.length).toBeGreaterThan(20);
    const testConfigs = files.filter(isTestConfig);
    // Parse every `setupFiles: [...]` array (comments stripped): the guard
    // must be its LAST entry, since a later file could reset HOME.
    const lastSetup = (f: string): string[] => {
      const src = readFileSync(join(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const arrays = [
        ...src.matchAll(/setupFiles:\s*\[([^\]]*(?:\([^)]*\)[^\]]*)*)\]/g),
      ];
      // A projects config needs one array per project: a new block without
      // setupFiles would otherwise ride on a sibling's.
      const projects = (src.match(/\binclude:/g) ?? []).length;
      return arrays.length === 0 || arrays.length < projects
        ? ["<missing setupFiles>"]
        : arrays.map((m) => {
            const entries = (m[1] ?? "")
              .split(/,(?![^(]*\))/)
              .map((e) => e.trim())
              .filter(Boolean);
            return entries[entries.length - 1] ?? "<empty>";
          });
    };
    const unwired = testConfigs.filter(
      (f) =>
        !(f in skip) &&
        !lastSetup(f).every((e) =>
          /scripts\/test\/agent-cli-guard\.ts["']|\.\.\/test\/agent-cli-guard\.ts["']/.test(
            e,
          ),
        ),
    );
    expect(unwired).toEqual([]);
    for (const f of Object.keys(skip))
      expect(files, `stale skip ${f}`).toContain(f);
  });
});
