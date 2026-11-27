// #2793 S6: `oa-bus status` lists the instances and the folder map when there
// are two or more; with one, the output is exactly what it was.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstance, writeFolders } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { instanceBlocks, status as statusCmd } from "../src/commands/status.ts";
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

describe("status: instances (#2793 S6, #3328 S1)", () => {
  it("one instance: compact default screen with ✓ host", async () => {
    const ctx = ctxWith();
    expect(await statusCmd(ctx)).toBe(0);
    const text = ctx.all().join("\n");
    expect(text).not.toContain("Instances");
    expect(text).not.toContain("Folders");
    expect(ctx.all()).toEqual([
      "oa-bus 0.1.0 · ● working · this MacBook",
      "  ✓ bus.example.com",
      "",
      "Agents  0 named · this project",
      "",
      "More: --agents · --messages · --instances · --json",
      "      https://bus.example.com/settings/agents",
    ]);
  });

  it("two instances: default screen shows ✓/✗ per host; instanceBlocks keeps full table", async () => {
    const rows = [
      { name: "main", link: "connected" as const, revoked: false, agents: 2 },
      { name: "work", link: "connected" as const, revoked: true, agents: 0 },
    ];
    const ctx = ctxWith({ instances: rows }, true);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.out().slice(0, 3)).toEqual([
      "oa-bus 0.1.0 · ▲ degraded · this MacBook",
      "  ✓ bus.example.com",
      "  ✗ work.example.com (revoked)",
    ]);
    const blocks = instanceBlocks(ctx, rows);
    expect(blocks[0]).toEqual([
      "Instances",
      "  main (main)  https://bus.example.com  connected  2 agents",
      "  work  https://work.example.com  revoked  0 agents",
    ]);
    expect(blocks[1]).toEqual([
      "Folders",
      "  /code/main -> main",
      "  /code/work -> work",
    ]);
  });

  it("lists the guest sessions under their instance in instanceBlocks (#2793 S3b), with terminal controls removed", () => {
    const rows = [
      { name: "main", link: "connected" as const, revoked: false, agents: 2 },
      {
        name: "work",
        link: "connected" as const,
        revoked: false,
        agents: 0,
        guests: [{ name: "Visitor" }, { name: "Ev\u001b[31mil" }],
      },
    ];
    const ctx = ctxWith({ instances: rows }, true);
    expect(instanceBlocks(ctx, rows)[0]).toEqual([
      "Instances",
      "  main (main)  https://bus.example.com  connected  2 agents",
      "  work  https://work.example.com  connected  0 agents",
      "    guest session: Visitor",
      "    guest session: Evil",
    ]);
  });

  it("an instance the daemon does not list reads can't reach on status and not connected in instanceBlocks", async () => {
    const ctx = ctxWith({}, true);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.out()).toContain("  ✗ work.example.com (can't reach)");
    expect(instanceBlocks(ctx, [])[0]).toContain(
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
