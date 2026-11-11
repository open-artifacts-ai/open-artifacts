import * as cp from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CLIS, BLOCK_EXIT, STUB_DIR } from "./agent-cli-guard";

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

  it("throws on an absolute path to a real binary, without running it", () => {
    const real = ["/usr/bin/pi", "/usr/local/bin/codex"];
    for (const p of real) {
      expect(() => cp.spawnSync(p, ["--version"])).toThrow(
        /blocked by the test guard/,
      );
      expect(() => cp.execFileSync(p, [])).toThrow(/blocked by the test guard/);
      expect(() => cp.execSync(`${p} --version`)).toThrow(
        /blocked by the test guard/,
      );
      expect(() => cp.spawn(p, [])).toThrow(/blocked by the test guard/);
      expect(() => cp.execFile(p, [], () => {})).toThrow(
        /blocked by the test guard/,
      );
      expect(() => cp.exec(`${p} x`, () => {})).toThrow(
        /blocked by the test guard/,
      );
    }
  });

  it("leaves other commands and fakes in a temp dir alone", () => {
    expect(cp.spawnSync("echo", ["hi"], { encoding: "utf8" }).stdout).toBe(
      "hi\n",
    );
    expect(readFileSync(join(STUB_DIR, "pi"), "utf8")).toContain("exit 97");
  });
});
