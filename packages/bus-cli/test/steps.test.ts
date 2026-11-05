import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAdapters, installAdapters } from "../src/steps/adapters.ts";
import {
  checkSteps,
  runSteps,
  type Step,
  updateInstallFile,
} from "../src/steps/step.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ob-steps-"));

describe("step runner", () => {
  const step = (name: string, ok: boolean, log: string[]): Step<null> => ({
    name,
    label: name,
    failed: `${name} failed`,
    action: "fix it",
    check: async () => (ok ? "done" : "todo"),
    apply: async () => {
      log.push(name);
      return ok;
    },
  });

  it("runs in order, records each, and stops at the first failure", async () => {
    const path = join(tmp(), "install.json");
    const log: string[] = [];
    const ok = await runSteps(
      [step("a", true, log), step("b", false, log), step("c", true, log)],
      null,
      { path, now: () => 0 },
    );
    expect(ok).toBe(false);
    expect(log).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(path, "utf8")).steps).toEqual({
      a: { status: "ok", at: "1970-01-01T00:00:00.000Z" },
      b: { status: "failed", at: "1970-01-01T00:00:00.000Z" },
    });
  });

  it("check runs every check and applies nothing", async () => {
    const log: string[] = [];
    const out = await checkSteps(
      [step("a", true, log), step("b", false, log)],
      null,
    );
    expect(out.map((r) => r.state)).toEqual(["done", "todo"]);
    expect(log).toEqual([]);
  });

  it("install.json keeps both writers' keys", async () => {
    const h = tmp();
    mkdirSync(join(h, ".config/opencode"), { recursive: true });
    updateInstallFile(join(h, ".oa-bus/install.json"), {
      steps: { login: 1 },
    });
    await installAdapters({
      home: h,
      busBin: ["ob"],
      assets: { pi: "P", opencodePlugin: "J" },
      which: (c) => c === "opencode",
      exec: async (_c, a) => ({
        code: 0,
        stdout: a[0] === "--version" ? "opencode v2.0.32" : "",
        stderr: "",
      }),
    });
    const rec = JSON.parse(
      readFileSync(join(h, ".oa-bus/install.json"), "utf8"),
    );
    expect(rec.steps).toEqual({ login: 1 });
    expect(Object.keys(rec.created).length).toBeGreaterThan(0);
  });
});

describe("checkAdapters", () => {
  it("reads each harness's config without changing anything", async () => {
    const h = tmp();
    mkdirSync(join(h, ".config/opencode"), { recursive: true });
    const all = (c: string) =>
      ["claude", "opencode", "pi", "omp", "codex"].includes(c);
    expect(checkAdapters({ home: h, which: all })).toEqual({
      claude: "missing",
      opencode: "missing",
      pi: "missing",
      omp: "missing",
      codex: "missing",
    });
    expect(checkAdapters({ home: h, which: () => false })).toEqual({
      claude: "absent",
      opencode: "absent",
      pi: "absent",
      omp: "absent",
      codex: "absent",
    });
    writeFileSync(join(h, ".claude.json"), "{ not json");
    expect(checkAdapters({ home: h, which: all }).claude).toBe("missing");
    await installAdapters({
      home: h,
      busBin: ["ob"],
      assets: { pi: "P", opencodePlugin: "J" },
      which: all,
      exec: async (c, a) => ({
        code: c === "claude" ? 1 : 0,
        stdout: a[0] === "--version" ? "opencode v2.0.32" : "",
        stderr: "",
      }),
    });
    writeFileSync(
      join(h, ".claude.json"),
      JSON.stringify({ mcpServers: { oa_bus: {} } }),
    );
    expect(checkAdapters({ home: h, which: all })).toEqual({
      claude: "configured",
      opencode: "configured",
      pi: "configured",
      omp: "configured",
      codex: "configured",
    });
  });
});
