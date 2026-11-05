// #1527: status and doctor show a refused or noted config file with its fix.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StatusReply } from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

function setup() {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  const proj = join(ctx.userHome, "x");
  mkdirSync(proj, { recursive: true });
  ctx.cwd = proj;
  const file = join(proj, ".oa-bus.json");
  writeFileSync(file, JSON.stringify({ namespace: "mine" }));
  return { ctx, proj, file };
}

const approve = (ctx: ReturnType<typeof fakeCtx>) => {
  mkdirSync(ctx.home, { recursive: true });
  const f = join(ctx.home, "machine.json");
  writeFileSync(
    f,
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
  );
  chmodSync(f, 0o600);
};

describe("doctor", () => {
  it("prints a world-writable .oa-bus.json with its fix", async () => {
    const { ctx, file } = setup();
    chmodSync(file, 0o666);
    await doctor(ctx);
    const out = ctx.all().join("\n");
    expect(out).toContain(
      "~/x/.oa-bus.json is writable by everyone, so it is ignored.",
    );
    expect(out).toContain("Fix: run chmod o-w ~/x/.oa-bus.json");
  });

  it("notes a group-writable one as still used", async () => {
    const { ctx, file } = setup();
    chmodSync(file, 0o664);
    await doctor(ctx);
    const out = ctx.all().join("\n");
    expect(out).toContain(
      "~/x/.oa-bus.json is writable by its group; it is still used.",
    );
    expect(out).toContain("Fix: optional: run chmod g-w ~/x/.oa-bus.json");
  });

  it("prints nothing for a 0600 file", async () => {
    const { ctx, file } = setup();
    chmodSync(file, 0o600);
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain(".oa-bus.json");
  });
});

describe("status", () => {
  it("prints each config file the daemon reports, with its fix", async () => {
    const ctx = fakeCtx();
    const f = `${ctx.userHome}/x/.oa-bus.json`;
    ctx.status = vi.fn(async () =>
      status({
        config_files: [
          {
            file: f,
            state: "refused",
            reason: "belongs to another user",
            fix: `remove it (rm ${f}) or take it over (chown "$USER" ${f})`,
          },
        ],
      }),
    );
    approve(ctx);
    await statusCmd(ctx);
    const out = ctx.all().join("\n");
    expect(out).toContain(
      "~/x/.oa-bus.json belongs to another user, so it is ignored.",
    );
    expect(out).toContain(
      'Fix: remove it (rm ~/x/.oa-bus.json) or take it over (chown "$USER" ~/x/.oa-bus.json)',
    );
  });

  it("prints nothing extra from an older daemon", async () => {
    const ctx = fakeCtx({ status: vi.fn(async () => status()) });
    approve(ctx);
    await statusCmd(ctx);
    expect(ctx.all().join("\n")).not.toContain("Fix:");
  });

  it("an old CLI schema (no config_files) still parses the reply", () => {
    const r = StatusReply.safeParse({
      v: 1,
      id: "x",
      type: "status",
      pid: 1,
      version: "1",
      label: "l",
      hub: "connected",
      namespaces: [],
      config_files: [{ file: "/a", state: "refused", reason: "r", fix: "f" }],
    });
    expect(r.success).toBe(true);
  });
});
