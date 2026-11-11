// #1856: doctor says when Codex's swapped Open Artifacts entry runs a program that is gone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { fakeCtx } from "./fake.ts";

const entry = (cmd: string) =>
  [
    "[mcp_servers.open-artifacts]",
    `command = "${cmd}"`,
    'args = ["mcp-proxy", "--instance", "https://oa.example.com", "--for", "codex", "--token-env", "OA_TOKEN"]',
    'env_vars = ["OA_TOKEN"]',
    "",
  ].join("\n");

function ctxWith(config: string) {
  const ctx = fakeCtx({
    nodeVersion: "v22.11.0",
    which: (c) => c === "codex",
    exec: vi.fn(async () => ({
      code: 0,
      stdout: "codex-cli 0.167.0\n",
      stderr: "",
    })),
  });
  const dir = ctx.env.CODEX_HOME ?? join(ctx.userHome, ".codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), config);
  return ctx;
}

describe("doctor, Codex proxy entry (#1856)", () => {
  it("fails with the fix when the proxy's program is missing", async () => {
    const ctx = ctxWith(entry("/gone/oa-bus"));
    expect(await doctor(ctx)).toBe(1);
    const all = ctx.all().join("\n");
    expect(all).toContain(
      "Codex's open-artifacts entry runs /gone/oa-bus, which is missing.",
    );
    expect(all).toContain(
      "Run npx @open-artifacts/bus install again, or npx @open-artifacts/bus uninstall to put your own entry back.",
    );
  });

  it("says nothing when the program is there or there is no proxy entry", async () => {
    for (const cfg of [entry(process.execPath), 'model = "x"\n']) {
      const ctx = ctxWith(cfg);
      await doctor(ctx);
      expect(ctx.all().join("\n")).not.toContain("which is missing");
    }
  });
});
