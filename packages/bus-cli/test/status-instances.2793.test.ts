// #2793 S6: `oa-bus status` lists the instances and the folder map when there
// are two or more; with one, the output is exactly what it was.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstance, writeFolders } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { status as statusCmd } from "../src/commands/status.ts";
import { fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const OTHER = `oa_machine_${"b".repeat(28)}7f3a`;

function ctxWith(
  st: Parameters<typeof status>[0] = {},
  second = false,
  style = { color: "none", dark: true, utf8: true } as const,
) {
  const ctx = fakeCtx({ style, status: vi.fn(async () => status(st)) });
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
  if (second) {
    saveInstance(
      {
        name: "work",
        hub: "https://work.example.com",
        machine_id: "",
        label: "l",
        machine_token: OTHER,
      },
      ctx.home,
    );
    writeFolders(
      { map: { "/code/work": "work", "/code/main": "main" }, no: {}, seen: {} },
      ctx.home,
    );
  }
  return ctx;
}

describe("status: instances (#2793 S6)", () => {
  it("one instance: the output is unchanged, no Instances or Folders block", async () => {
    const ctx = ctxWith();
    expect(await statusCmd(ctx)).toBe(0);
    const text = ctx.all().join("\n");
    expect(text).not.toContain("Instances");
    expect(text).not.toContain("Folders");
    // The whole output, as it was before this slice.
    expect(ctx.all()).toMatchInlineSnapshot(`
      [
        "oa-bus 0.1.0",
        "",
        "Hub      bus.example.com  ● connected",
        "Machine  leo-macbook-pro",
        "!  Daemon running, but no service will restart it after a reboot.",
        "   Run npx @open-artifacts/bus install.",
        "",
        "No agents in namespace github.com/open-artifacts-ai/oa-bus yet.",
        "Start Claude Code, OpenCode, Pi, oh-my-pi, Codex, Hermes or OpenClaw",
        "in this folder. It joins.",
      ]
    `);
  });

  it("two instances: each with its address, state and agent count, then the folders", async () => {
    const ctx = ctxWith(
      {
        instances: [
          { name: "main", link: "connected", revoked: false, agents: 2 },
          { name: "work", link: "connected", revoked: true, agents: 0 },
        ],
      },
      true,
    );
    await statusCmd(ctx);
    const out = ctx.all();
    const at = out.indexOf("Instances");
    expect(out.slice(at, at + 3)).toEqual([
      "Instances",
      "  main (main)  https://bus.example.com  connected  2 agents",
      "  work  https://work.example.com  revoked  0 agents",
    ]);
    expect(out).toContain("Folders");
    expect(out).toContain("  /code/main -> main");
    expect(out).toContain("  /code/work -> work");
  });

  it("an instance the daemon does not list reads not connected", async () => {
    const ctx = ctxWith({}, true);
    await statusCmd(ctx);
    expect(ctx.all()).toContain(
      "  work  https://work.example.com  not connected  0 agents",
    );
  });
});

describe("doctor: a repo's instance key (#2840)", () => {
  it("says which bus reads it", async () => {
    const { doctor } = await import("../src/commands/doctor.ts");
    const { mkdtempSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ob-doc-")));
    writeFileSync(
      join(dir, ".oa-bus.json"),
      JSON.stringify({ instance: "https://x.example.com" }),
      { mode: 0o600 },
    );
    const ctx = ctxWith();
    ctx.cwd = dir;
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "has an instance key. This version reads it; oa-bus before 0.218.0 refuses the whole file.",
    );
    const plain = ctxWith();
    plain.cwd = realpathSync(mkdtempSync(join(tmpdir(), "ob-doc2-")));
    await doctor(plain);
    expect(plain.all().join("\n")).not.toContain("instance key");
  });
});
