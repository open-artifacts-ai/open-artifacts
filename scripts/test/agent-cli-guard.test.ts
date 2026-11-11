import * as cp from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AGENT_CLIS, BLOCK_EXIT, STUB_DIR } from "./agent-cli-guard";

const pi_ = () => "/usr/bin/pi";
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

  describe("a real executable pi outside any temp dir", () => {
    // Under node_modules/.cache (git-ignored, not a temp dir). The file
    // writes a marker if it ever runs.
    const dir = join(
      process.cwd().replace(/\/(apps|packages)\/.*$/, ""),
      "node_modules",
      ".cache",
      `agent-cli-guard-${process.pid}`,
    );
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
      expect(() => cp.spawnSync("pi", { env: { PATH: dir } })).toThrow(blocked);
    });

    it("throws when it hides behind another command or a shell", () => {
      expect(() => cp.spawnSync("timeout", ["5", pi])).toThrow(blocked);
      expect(() => cp.spawnSync("env", ["-u", "FOO", pi])).toThrow(blocked);
      expect(() => cp.spawnSync("sh", ["-c", pi])).toThrow(blocked);
      expect(() => cp.execSync(`cd / && ${pi}`)).toThrow(blocked);
      expect(() => cp.execSync(`echo hi; ${pi} x`)).toThrow(blocked);
    });
  });

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
    const unwired = testConfigs.filter(
      (f) =>
        !(f in skip) &&
        !readFileSync(join(root, f), "utf8").includes("agent-cli-guard"),
    );
    expect(unwired).toEqual([]);
    for (const f of Object.keys(skip))
      expect(files, `stale skip ${f}`).toContain(f);
  });
});
