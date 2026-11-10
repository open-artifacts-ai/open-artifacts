// #1856: doctor says when OpenCode's Open Artifacts entry runs a program that is gone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { fakeCtx } from "./fake.ts";

describe("doctor, OpenCode proxy entry (#1856)", () => {
  it("fails with the fix when the proxy's program is missing", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      which: (c) => c === "opencode",
      exec: vi.fn(async () => ({
        code: 0,
        stdout: "opencode v2.2.5\n",
        stderr: "",
      })),
    });
    const dir = join(ctx.userHome, ".config/opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: {
            "open-artifacts": {
              type: "local",
              command: [
                "/gone/oa-bus",
                "mcp-proxy",
                "--instance",
                "https://oa.example.com",
              ],
            },
          },
        },
      }),
    );
    expect(await doctor(ctx)).toBe(1);
    const all = ctx.all().join("\n");
    expect(all).toContain(
      "OpenCode's open-artifacts entry runs /gone/oa-bus, which is missing.",
    );
    expect(all).toContain(
      "Run npx @open-artifacts/bus install again, or npx @open-artifacts/bus uninstall to put your own entry back.",
    );
  });

  it("says nothing when there is no proxy entry", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      which: (c) => c === "opencode",
      exec: vi.fn(async () => ({
        code: 0,
        stdout: "opencode v2.2.5\n",
        stderr: "",
      })),
    });
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("which is missing");
  });
});
