// #2425: a second bus home sets up only itself and leaves every harness config alone.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const service = (over: Partial<NonNullable<Ctx["service"]>> = {}) => ({
  kind: "launchd" as const,
  ensure: vi.fn(async () => ({})),
  remove: vi.fn(async () => ({ unit: "launchd" as const })),
  cli: () => ["oa-bus"],
  ...over,
});

/** A ctx whose bus home is `.oa-bus` (the first bus) or a second folder, already approved. */
function make(second: boolean, over: Partial<Ctx> = {}): Fake {
  const ctx = fakeCtx({
    which: (c) => ["claude", "pi"].includes(c),
    service: service(),
    status: vi.fn(async () => status()),
    ...over,
  });
  if (second) ctx.home = join(ctx.userHome, "second-bus");
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
  return ctx;
}

/** Every file under the user's home outside the bus home: where the harness configs live. */
const outside = (ctx: Ctx): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (p === ctx.home) continue;
      if (e.isDirectory()) walk(p);
      else found.push(p);
    }
  };
  walk(ctx.userHome);
  return found;
};

const MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";
/** A file the default uninstall removes: our marked output style. */
const styleFile = (ctx: Ctx) => {
  const dir = join(ctx.userHome, ".claude/output-styles");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "artifacts-teammate.md");
  writeFileSync(f, `---\nname: Artifacts Teammate\n---\n${MARKER}\nbody\n`);
  return f;
};

const harnessCalls = (ctx: Ctx) =>
  (ctx.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([cmd]) => cmd === "claude" || cmd === "pi",
  );

describe("install --home <dir> for a second bus (#2425)", () => {
  it("runs no harness step, writes nothing outside its home, and says how to start a session", async () => {
    const ctx = make(true);
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(harnessCalls(ctx)).toEqual([]);
    expect(outside(ctx)).toEqual([]);
    expect(ctx.service.ensure).toHaveBeenCalledOnce();
    const out = ctx.out().join("\n");
    expect(out).toContain("Left every session's settings alone.");
    expect(out).toContain(
      `Start a session on this bus with: OA_BUS_HOME=~/second-bus pi`,
    );
    expect(out).toContain("Codex, Hermes and OpenClaw do not follow it");
    expect(out).not.toContain("Configured");
    expect(out).not.toContain("—");
  });

  it("the default home still configures the harnesses", async () => {
    const ctx = make(false);
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(harnessCalls(ctx).length).toBeGreaterThan(0);
    expect(ctx.out().join("\n")).not.toContain("Left every session");
  });

  it("refuses --habits for a second home", async () => {
    const ctx = make(true);
    expect(await install({ habits: "yes" }, ctx)).toBe(1);
    expect(ctx.err().join("\n")).toContain("belong to your first bus");
    expect(outside(ctx)).toEqual([]);
  });
});

describe("uninstall --home <dir> for a second bus (#2425)", () => {
  it("removes only its service and leaves every harness config", async () => {
    const ctx = make(true);
    const claude = join(ctx.userHome, ".claude.json");
    const piDir = join(ctx.userHome, ".pi/agent/extensions");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(claude, '{"mcpServers":{"open-artifacts":{}}}\n');
    const style = styleFile(ctx);
    const before = outside(ctx).sort();
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.service.remove).toHaveBeenCalledOnce();
    expect(harnessCalls(ctx)).toEqual([]);
    expect(outside(ctx).sort()).toEqual(before);
    expect(existsSync(claude)).toBe(true);
    expect(existsSync(style)).toBe(true);
  });

  it("the default home still unwires the harnesses", async () => {
    const ctx = make(false);
    const style = styleFile(ctx);
    await uninstall({ purge: false }, ctx);
    expect(existsSync(style)).toBe(false);
  });
});

describe("doctor lists other homes' services (#2425)", () => {
  const names = [
    "com.open-artifacts.bus.0a1b2c3d",
    "com.open-artifacts.bus.99887766",
  ];

  it("names them in one line from the first bus", async () => {
    const ctx = make(false, { service: service({ others: () => names }) });
    await doctor(ctx);
    const lines = ctx.all().filter((l) => l.includes("Other bus homes"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(names.join(", "));
  });

  it("says nothing when there are none, or from a second home", async () => {
    const none = make(false, { service: service({ others: () => [] }) });
    await doctor(none);
    expect(none.all().join("\n")).not.toContain("Other bus homes");
    const second = make(true, { service: service({ others: () => names }) });
    await doctor(second);
    expect(second.all().join("\n")).not.toContain("Other bus homes");
  });
});

describe("not-logged-in errors for a second home (#2425)", () => {
  it("name login --home, never install", async () => {
    const { copyFor } = await import("../src/bus-cmd.ts");
    const { status: statusCmd } = await import("../src/commands/status.ts");
    const ctx = fakeCtx();
    ctx.home = join(ctx.userHome, "second-bus");
    ctx.copy = copyFor(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    const err = ctx.err().join("\n");
    expect(err).toContain(
      "Run npx @open-artifacts/bus login --home ~/second-bus --instance <url> to approve it.",
    );
    expect(err).not.toContain("install");
    const lines = [
      ...ctx.copy.revoked(),
      ...ctx.copy.revokedCheck(),
      ...ctx.copy.noCredentials("x"),
    ].join("\n");
    expect(lines).not.toContain("install");
    expect(lines).toContain("login --home ~/second-bus");
  });

  it("the first bus keeps its lines", async () => {
    const ctx = fakeCtx();
    const { copyFor } = await import("../src/bus-cmd.ts");
    expect(copyFor(ctx).revoked().join("\n")).toContain(
      "npx @open-artifacts/bus install to approve it again.",
    );
    expect(copyFor(ctx).notRegistered().join("\n")).toContain(
      "Run npx @open-artifacts/bus to approve it.",
    );
  });
});
