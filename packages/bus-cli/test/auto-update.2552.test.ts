import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearInstallRequest,
  markFailed,
  markLoginActive,
  readInstallRequest,
  readPolicy,
  setStaged,
  writeState,
} from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { installViaDaemon, update } from "../src/commands/update.ts";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const world = (tty = true, answer = "yes") => {
  const ctx = fakeCtx({}, tty);
  mkdirSync(ctx.home, { recursive: true });
  writeState(ctx.home, { armed: true });
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
  it("is registered, takes no argument and no --yes", () => {
    expect(parse(["update"])).toMatchObject({ cmd: "update" });
    expect(() => parse(["update", "1.2.3"])).toThrow(/unexpected/);
    expect(() => parse(["update", "--yes"])).toThrow(/does not apply/);
    expect(() => parse(["update", "-y"])).toThrow(/does not apply/);
  });
  it("through main: with nothing staged it says so and installs nothing", async () => {
    const c = world();
    expect(await main(["update"], () => c)).toBe(0);
    expect(c.out()[0]).toMatch(/^Up to date\. Nothing is waiting/);
  });
  it("through main: not in a terminal, exit 2", async () => {
    const c = world(false);
    setStaged(c.home, "1.6.0", 1);
    expect(await main(["update"], () => c)).toBe(2);
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
    expect(c.err()).toContain(
      "Run this yourself in a terminal. It's not for an agent to run.",
    );
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
      expect(c.readLine).toHaveBeenCalledWith(
        "Install 1.6.0 now? The bus restarts for a few seconds. Type yes to continue: ",
      );
    }
  });
  it("refuses a failed version, and off", async () => {
    const c = world();
    setStaged(c.home, "1.6.0", 1);
    writeFileSync(
      join(c.home, "update.json"),
      JSON.stringify({
        armed: true,
        staged: { version: "1.6.0", readySince: 1 },
        failed: ["1.6.0"],
      }),
    );
    expect(await update(c, vi.fn())).toBe(1);
    expect(c.err()).toContain(
      "1.6.0 failed on this machine before, so it won't be installed. The next version will be.",
    );
    const d = world();
    setStaged(d.home, "1.6.0", 1);
    await main(["auto-update", "off"], () => d);
    expect(await update(d, vi.fn())).toBe(1);
  });
  it("a corrupt update.json means no update and Update needs you", async () => {
    const c = world();
    writeFileSync(join(c.home, "update.json"), "{nope");
    const install = vi.fn(async () => true);
    expect(await update(c, install)).toBe(0);
    expect(c.out()[0]).toMatch(/^Update needs you\./);
    expect(install).not.toHaveBeenCalled();
    expect(await main(["auto-update", "status"], () => c)).toBe(0);
    expect(c.out()).toContain("Update needs you");
  });
});

describe("installViaDaemon", () => {
  const ctxFor = () => {
    const c = world();
    setStaged(c.home, "1.6.0", 1);
    c.now = () => 1000;
    return c;
  };
  it("leaves a request and returns once the version is current", async () => {
    const c = ctxFor();
    c.sleep = async () => {
      // The daemon: consumes the request, restarts, passes the self-check.
      expect(readInstallRequest(c.home)).toEqual({
        version: "1.6.0",
        at: 1000,
      });
      clearInstallRequest(c.home);
      writeState(c.home, { armed: true, current: "1.6.0" });
    };
    expect(await installViaDaemon(c, "1.6.0", 5000)).toBe(true);
  });
  it("gives up with the daemon silent, and withdraws its request", async () => {
    const c = ctxFor();
    c.sleep = async () => {};
    expect(await installViaDaemon(c, "1.6.0", 2000)).toBe(false);
    expect(readInstallRequest(c.home)).toBeUndefined();
    expect(c.err().join("\n")).toContain("1.6.0 was not installed. Run ");
  });
  it("stops at once when the version failed to start", async () => {
    const c = ctxFor();
    c.sleep = async () => {
      markFailed(c.home, "1.6.0");
    };
    const waits = vi.fn(c.sleep);
    c.sleep = waits;
    expect(await installViaDaemon(c, "1.6.0", 60_000)).toBe(false);
    expect(waits.mock.calls.length).toBeLessThan(3);
  });
  it("refuses while a login is in progress and leaves no request", async () => {
    const c = ctxFor();
    const done = markLoginActive(c.home);
    expect(await installViaDaemon(c, "1.6.0", 1000)).toBe(false);
    expect(c.err().join("\n")).toContain(
      "A login or an approval is in progress.",
    );
    expect(readInstallRequest(c.home)).toBeUndefined();
    done();
  });
});
