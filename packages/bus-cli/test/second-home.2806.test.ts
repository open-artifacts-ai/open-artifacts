// #2806: a second bus (--alongside) adds only its own proof helper to the Claude
// entries for its instance, and uninstall takes back only that.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { claudeProofChecks } from "../src/steps/claude-proof-check.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const OTHER = "https://a.example.org";
const A_HELPER = "oa-bus mcp-proof";

function make(): Fake {
  const ctx = fakeCtx({
    which: (c) => c === "claude",
    service: {
      kind: "launchd" as const,
      ensure: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ unit: "launchd" as const })),
      cli: () => ["oa-bus"],
    },
    status: vi.fn(async () => status()),
  });
  ctx.home = join(ctx.userHome, "second-bus");
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
  writeFileSync(
    join(ctx.userHome, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "open-artifacts": {
          type: "http",
          url: `${OTHER}/mcp`,
          headersHelper: A_HELPER,
        },
        "open-artifacts-b": { type: "http", url: `${HUB}/mcp` },
      },
    }),
  );
  return ctx;
}

const servers = (ctx: Ctx) =>
  JSON.parse(readFileSync(join(ctx.userHome, ".claude.json"), "utf8"))
    .mcpServers as Record<string, { headersHelper?: string }>;

describe("install --alongside adds its own proof helper (#2806)", () => {
  it("writes it with OA_BUS_HOME on its instance's entry only, and reruns change nothing", async () => {
    const ctx = make();
    expect(await install({ hub: HUB, alongside: true }, ctx)).toBe(0);
    expect(servers(ctx)["open-artifacts-b"]?.headersHelper).toBe(
      `OA_BUS_HOME=${ctx.home} oa-bus mcp-proof`,
    );
    expect(servers(ctx)["open-artifacts"]?.headersHelper).toBe(A_HELPER);
    const once = readFileSync(join(ctx.userHome, ".claude.json"), "utf8");
    expect(await install({ hub: HUB, alongside: true }, ctx)).toBe(0);
    expect(readFileSync(join(ctx.userHome, ".claude.json"), "utf8")).toBe(once);
    // No skills, plugins, or MCP entries for the second home.
    expect(Object.keys(servers(ctx)).sort()).toEqual([
      "open-artifacts",
      "open-artifacts-b",
    ]);
    expect(ctx.exec).not.toHaveBeenCalledWith("claude", expect.anything());
  });

  it("--check says todo before and done after; doctor-side check passes", async () => {
    const ctx = make();
    expect(await install({ hub: HUB, alongside: true, check: true }, ctx)).toBe(
      1,
    );
    await install({ hub: HUB, alongside: true }, ctx);
    expect(await install({ hub: HUB, alongside: true, check: true }, ctx)).toBe(
      0,
    );
    const lines = claudeProofChecks(ctx, HUB).map((c) => c.level);
    expect(lines).toEqual(["pass"]);
  });

  it("uninstall removes only its own helper", async () => {
    const ctx = make();
    await install({ hub: HUB, alongside: true }, ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(servers(ctx)["open-artifacts-b"]?.headersHelper).toBeUndefined();
    expect(servers(ctx)["open-artifacts"]?.headersHelper).toBe(A_HELPER);
  });
});
