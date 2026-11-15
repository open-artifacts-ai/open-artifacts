import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markFailed, readPolicy, setStaged } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { update } from "../src/commands/update.ts";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const world = (tty = true, answer = "yes") => {
  const ctx = fakeCtx({}, tty);
  mkdirSync(ctx.home, { recursive: true });
  ctx.stdinIsTTY = tty;
  ctx.readLine = vi.fn(async () => answer);
  return ctx;
};

describe("oa-bus auto-update", () => {
  it("off, on and status", async () => {
    const c = world();
    expect(await main(["auto-update", "off"], () => c)).toBe(0);
    expect(c.out()).toContain("Auto-update is off.");
    expect(readPolicy(c.home).off).toBe(true);
    const s = world();
    s.home = c.home;
    expect(await main(["auto-update", "status"], () => s)).toBe(0);
    expect(s.out().join("\n")).toContain("Auto-update: off");
    expect(await main(["auto-update", "on"], () => world())).toBe(0);
  });
  it("status shows the first-time line once", async () => {
    const c = world();
    await main(["auto-update", "status"], () => c);
    expect(c.out()).toEqual([
      expect.stringContaining(
        "The bus now keeps itself up to date. To turn this off: ",
      ),
      "Up to date",
    ]);
    expect(c.out()[0]).toMatch(/auto-update off$/);
    const d = world();
    d.home = c.home;
    await main(["auto-update", "status"], () => d);
    expect(d.out()).toEqual(["Up to date"]);
  });
  it("usage", () => {
    expect(() => parse(["auto-update"])).toThrow(/usage/);
    expect(() => parse(["auto-update", "maybe"])).toThrow(/usage/);
    expect(() => parse(["auto-update", "off", "x"])).toThrow(/unexpected/);
  });
});

describe("oa-bus update", () => {
  it("is not registered as a command yet", () => {
    expect(() => parse(["update"])).toThrow(/unknown command/);
  });
  it("refuses without a terminal, exit 2", async () => {
    const c = world(false);
    setStaged(c.home, "1.6.0", 1);
    expect(
      await update(
        c,
        vi.fn(async () => true),
      ),
    ).toBe(2);
    expect(c.err()).toContain("Run this yourself in a terminal.");
    expect(c.readLine).not.toHaveBeenCalled();
  });
  it("an env override changes nothing", async () => {
    const c = world(false);
    c.env = { OA_BUS_YES: "1", CI: "1", YES: "1" };
    setStaged(c.home, "1.6.0", 1);
    expect(
      await update(
        c,
        vi.fn(async () => true),
      ),
    ).toBe(2);
  });
  it("nothing staged says the state", async () => {
    const c = world();
    expect(
      await update(
        c,
        vi.fn(async () => true),
      ),
    ).toBe(0);
    expect(c.out()[0]).toMatch(/^Up to date\./);
  });
  it("only yes installs; y does not", async () => {
    for (const [a, code] of [
      ["yes", 0],
      ["y", 1],
      ["", 1],
      ["no", 1],
    ] as const) {
      const c = world(true, a);
      setStaged(c.home, "1.6.0", 1);
      const install = vi.fn(async () => true);
      expect(await update(c, install)).toBe(code);
      expect(install).toHaveBeenCalledTimes(code === 0 ? 1 : 0);
      if (code === 0) expect(install).toHaveBeenCalledWith("1.6.0");
    }
  });
  it("refuses a failed version, and off", async () => {
    const c = world();
    setStaged(c.home, "1.6.0", 1);
    writeFileSync(
      join(c.home, "update.json"),
      JSON.stringify({
        staged: { version: "1.6.0", readySince: 1 },
        failed: ["1.6.0"],
      }),
    );
    expect(await update(c, vi.fn())).toBe(1);
    const d = world();
    setStaged(d.home, "1.6.0", 1);
    await main(["auto-update", "off"], () => d);
    expect(await update(d, vi.fn())).toBe(1);
  });
});
