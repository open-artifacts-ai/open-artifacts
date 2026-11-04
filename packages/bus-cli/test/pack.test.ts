import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCli } from "../src/steps/service.ts";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "ob-pack-"));
const home = join(work, "home");
const obHome = join(home, ".oa-bus");
// Nothing reaches the real home, npm cache or harnesses; no network.
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  OA_BUS_HOME: obHome,
  npm_config_cache: join(work, "npm-cache"),
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  NO_COLOR: "1",
};
const run = (args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(args[0] as string, args.slice(1), {
    env,
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });

let tarball = "";
let files: string[] = [];
let entry = "";
const children: ChildProcess[] = [];

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  // prepack bundles first.
  run(["npm", "pack", "--pack-destination", work], { cwd: root });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  tarball = join(work, tgz as string);
  files = run(["tar", "-tzf", tarball]).trim().split("\n");
  const out = join(work, "x");
  mkdirSync(out);
  run(["tar", "-xzf", tarball, "-C", out]);
  entry = join(out, "package/dist/index.js");
}, 180_000);

afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) c.kill();
});

describe("the published oa-bus package", () => {
  it("ships dist and assets only", () => {
    expect(files.sort()).toEqual([
      "package/assets/oa-bus.ts",
      "package/assets/opencode-tui/tui.js",
      "package/dist/index.js",
      "package/package.json",
    ]);
  });

  it("stamps the Pi extension's IPC marker with the package version", () => {
    const pi = readFileSync(
      join(dirname(dirname(entry)), "assets/oa-bus.ts"),
      "utf8",
    );
    expect(pi).toContain(
      `const CLIENT_VERSION = ${JSON.stringify(pkg.version)};`,
    );
  });

  it("ships one extension for Pi and oh-my-pi, told apart at load (C23b)", () => {
    const pi = readFileSync(
      join(dirname(dirname(entry)), "assets/oa-bus.ts"),
      "utf8",
    );
    expect(pi).toContain('ctx.agent !== undefined ? "omp" : "pi"');
  });

  it("has the fields the publish needs and no runtime dependencies", () => {
    const shipped = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
    );
    expect(shipped.name).toBe("@open-artifacts/bus");
    expect(shipped.publishConfig).toEqual({ access: "public" });
    expect(shipped.private).toBeUndefined();
    expect(shipped.bin).toEqual({ "oa-bus": "dist/index.js" });
    expect(shipped.files).toEqual(["dist", "assets"]);
    expect(shipped.engines.node).toBe(">=22");
    expect(shipped.repository).toEqual({
      type: "git",
      url: "https://github.com/open-artifacts-ai/open-artifacts",
      directory: "packages/cli",
    });
    expect(shipped.scripts.build).toBeTruthy();
    expect(shipped.dependencies ?? {}).toEqual({});
  });

  it("is one self-contained ESM file", () => {
    const dist = readFileSync(entry, "utf8");
    expect(dist.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(dist.length).toBeLessThan(2 * 1024 * 1024);
    // Real imports only: not in comments, nor in strings of generated code
    // (ajv's `'require("ajv/dist/runtime/uri")'`).
    const specifiers = dist
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .flatMap((line) => [
        ...line.matchAll(
          /(?<!['"`])\b(?:require|import)\s*\(\s*["']([^"']+)["']|^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/g,
        ),
      ])
      .map((m) => (m[1] ?? m[2] ?? m[3]) as string);
    expect(specifiers).toContain("node:module");
    const builtins = new Set(builtinModules);
    const foreign = specifiers.filter(
      (s) =>
        !s.startsWith("node:") &&
        !builtins.has(s) &&
        // ws's optional native add-ons, each required in a try.
        s !== "bufferutil" &&
        s !== "utf-8-validate",
    );
    expect(foreign).toEqual([]);
    expect(dist).not.toMatch(/["']@ob\//);
  });

  it("ships an executable entry", () => {
    expect(statSync(entry).mode & 0o111).toBe(0o111);
    expect(statSync(join(root, "dist/index.js")).mode & 0o111).toBe(0o111);
  });

  it("prints its version from the tarball", () => {
    expect(run([process.execPath, entry, "version"])).toBe(
      `oa-bus ${pkg.version}\n`,
    );
  });

  it("runs through npm exec from the tarball, offline", () => {
    const cwd = join(work, "exec");
    mkdirSync(cwd);
    expect(
      run(
        [
          "npm",
          "exec",
          "--yes",
          `--package=${tarball}`,
          "--",
          "oa-bus",
          "version",
        ],
        {
          cwd,
        },
      ),
    ).toBe(`oa-bus ${pkg.version}\n`);
  }, 60_000);

  it("mcp pi explains the extension", () => {
    let out = "";
    let status = 0;
    try {
      run([process.execPath, entry, "mcp", "pi"]);
    } catch (e) {
      const err = e as { stdout: string; status: number };
      out = err.stdout;
      status = err.status;
    }
    expect(status).toBe(1);
    expect(out).toMatch(/Pi uses the Open Artifacts bus extension/);
  });

  it.each([
    // Neither has a session here, and each says so in its own words.
    ["claude", /no Claude session or daemon found/],
    ["opencode", /did not send a session id/],
    // No `_meta` here: no thread, so no hello.
    ["codex", /did not send the thread's identity/],
  ])(
    "mcp %s answers MCP over stdio as its own server",
    async (harness, says) => {
      const child = spawn(process.execPath, [entry, "mcp", harness as string], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      const waiters = new Map<number, (m: Record<string, unknown>) => void>();
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          waiters.get(msg.id)?.(msg);
          nl = buf.indexOf("\n");
        }
      });
      const exited = new Promise<never>((_, reject) =>
        child.on("exit", (code) => reject(new Error(`exited ${code}`))),
      );
      const call = (id: number, method: string, params: unknown) => {
        const reply = new Promise<Record<string, unknown>>((resolve) =>
          waiters.set(id, resolve),
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
        return Promise.race([reply, exited]);
      };
      const init = (await call(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pack-test", version: "0" },
      })) as {
        result: {
          serverInfo: { name: string };
          capabilities: { tools?: unknown };
        };
      };
      expect(init.result.serverInfo.name).toBe("oa_bus");
      expect(init.result.capabilities.tools).toBeDefined();
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const res = (await call(2, "tools/call", {
        name: "list_agents",
        arguments: {},
      })) as { result: { content: { text: string }[] } };
      expect(res.result.content[0]?.text).toMatch(says);
      child.kill();
    },
    30_000,
  );

  it("doctor runs its checks in a fresh home", () => {
    const r = spawnSync(process.execPath, [entry, "doctor"], {
      env,
      encoding: "utf8",
    });
    // A fresh home fails checks; a crash would end without the summary.
    expect(r.stdout).toMatch(/passed\.\n$/);
    expect(r.stderr).not.toMatch(/doctor to see why/);
  });

  it("doctor reads Codex's config.toml from the bundle (C26e)", () => {
    const codexHome = join(work, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      'sandbox_mode = "danger-full-access"\n',
    );
    const r = spawnSync(process.execPath, [entry, "doctor"], {
      env: { ...env, CODEX_HOME: codexHome },
      encoding: "utf8",
    });
    expect(r.stderr).toMatch(/Codex is not wired/);
    expect(r.stdout).toMatch(/Codex runs with danger-full-access/);
  });

  it("install's stable copy carries the bundle and its assets", () => {
    const copyHome = join(work, "stable");
    const copied = installCli(copyHome, { kind: "bundle", file: entry });
    expect(copied).toBe(join(copyHome, "bin/dist/index.js"));
    expect(existsSync(join(copyHome, "bin/assets/oa-bus.ts"))).toBe(true);
    expect(existsSync(join(copyHome, "bin/assets/opencode-tui/tui.js"))).toBe(
      true,
    );
    expect(run([process.execPath, copied, "version"])).toBe(
      `oa-bus ${pkg.version}\n`,
    );
  });
});
