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
    expect(out).toContain(`Fix: run chmod o-w '${file}'`);
  });

  it("says to restart the session to pick up a fix", async () => {
    const { ctx, file } = setup();
    chmodSync(file, 0o666);
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "Restart the session to pick up a fix.",
    );
  });

  it("strips terminal controls from the path and the fix", async () => {
    const ctx = fakeCtx();
    ctx.userHome = realpathSync(ctx.userHome);
    ctx.home = join(ctx.userHome, ".oa-bus");
    const dir = join(ctx.userHome, "a\x1b]52;c;aGk=\x07b\nFORGED");
    mkdirSync(dir, { recursive: true });
    ctx.cwd = dir;
    const f = join(dir, ".oa-bus.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o666);
    await doctor(ctx);
    const raw = ctx.all().join("\n");
    expect(raw).not.toContain("\x1b");
    expect(raw).not.toContain("\x07");
    expect(ctx.all()).not.toContain("FORGED");
    expect(raw).toContain("Fix: run chmod o-w");
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
      `Fix: remove it (rm ${f}) or take it over (chown "$USER" ${f})`,
    );
  });

  it("strips terminal controls from what the daemon reports", async () => {
    const ctx = fakeCtx();
    ctx.status = vi.fn(async () =>
      status({
        config_files: [
          {
            file: "/h/a\x1b]52;c;aGk=\x07b/.oa-bus.json",
            state: "refused",
            reason: "is writable by everyone",
            fix: "run chmod o-w '/h/a\x1b[2Jb\nFORGED'",
          },
        ],
      }),
    );
    approve(ctx);
    await statusCmd(ctx);
    const raw = ctx.all().join("\n");
    expect(raw).not.toContain("\x1b");
    expect(raw).not.toContain("\x07");
    expect(ctx.all()).not.toContain("FORGED");
    expect(ctx.all().join("\n")).toContain("Restart the session");
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
