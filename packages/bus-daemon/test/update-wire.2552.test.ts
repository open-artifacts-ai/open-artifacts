import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentVersion,
  installVersion,
  queueReport,
  readPolicy,
  readReports,
  writeState,
} from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
  delete process.env.OA_BUS_HOME;
});

const T = Date.parse("2026-11-15T12:00:00Z");
const every = (fn: () => void, ms: number) => {
  const t = setInterval(fn, Math.min(ms, 20));
  return () => clearInterval(t);
};

/** A home running 1.0.0 with 0.9.0 kept; no switch pending. */
function home() {
  const h = mkdtempSync(join(tmpdir(), "oa-uw-"));
  process.env.OA_BUS_HOME = h;
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
  };
  installVersion(h, "0.9.0", fill("0.9.0"));
  installVersion(h, "1.0.0", fill("1.0.0"));
  writeState(h, { armed: true, current: "1.0.0", previous: "0.9.0" });
  return { h, entry: join(h, "bin/dist/index.js") };
}
const helloOk = (over: object = {}) => ({
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  ...over,
});

describe("the update wire, daemon side (#2552)", () => {
  it("lists the cap in its hello", async () => {
    const w = home();
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit: vi.fn(), every },
    });
    await vi.waitFor(() => expect(h.of("hello")).toHaveLength(1));
    expect(h.of("hello")[0]?.caps).toContain("run_version");
  });

  it("feeds hello_ok.run_version and the push to the updater, only with the cap", async () => {
    const w = home();
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit: vi.fn(), every },
    });
    const spy = vi
      .spyOn(
        h.daemon.updater as never as {
          instructFromInstance: () => Promise<unknown>;
        },
        "instructFromInstance",
      )
      .mockResolvedValue({ kind: "disabled" });
    // A hub without the cap: the field and the push are ignored.
    h.toDaemon(helloOk({ run_version: "1.1.0" }));
    h.toDaemon({ id: "p0", type: "run_version", run_version: "1.1.0" });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).not.toHaveBeenCalled();
    // A hub that listed it.
    h.toDaemon(helloOk({ caps: ["run_version"], run_version: "1.1.0" }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("1.1.0"));
    h.toDaemon({ id: "p1", type: "run_version", run_version: "1.2.0" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("1.2.0"));
    // A bad value never reaches the updater: the frame does not decode.
    h.toDaemon({ id: "p2", type: "run_version", run_version: "latest" });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("install_now has no field and goes only to a daemon that listed the cap", async () => {
    const w = home();
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit: vi.fn(), every },
    });
    const spy = vi
      .spyOn(
        h.daemon.updater as never as {
          installNowFromInstance: () => Promise<unknown>;
        },
        "installNowFromInstance",
      )
      .mockResolvedValue({ kind: "disabled" });
    h.toDaemon(helloOk());
    h.toDaemon({ id: "i0", type: "install_now" });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).not.toHaveBeenCalled();
    h.toDaemon(helloOk({ caps: ["run_version"] }));
    h.toDaemon({ id: "i1", type: "install_now" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // A frame with a field is no frame.
    h.toDaemon({ id: "i2", type: "install_now", version: "9.9.9" });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sends the queued reports on hello_ok, with the rescue version, and keeps none that went", async () => {
    const w = home();
    writeFileSync(
      join(w.h, "rescue.mjs"),
      "// Written by oa-bus install. Rescue shim 7.\n",
    );
    queueReport(w.h, {
      event: "updated",
      from: "1.0.0",
      to: "1.1.0",
      reason: "ok",
      at: T,
    });
    queueReport(w.h, {
      event: "ready_24h",
      from: "1.0.0",
      to: "1.2.0",
      reason: "not_quiet_24h",
      at: T + 1000,
    });
    queueReport(w.h, {
      event: "refused",
      from: "1.0.0",
      to: "1.3.0",
      reason: "proof_failed",
      at: T + 2000,
    });
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit: vi.fn(), every },
    });
    // No cap (an older hub): nothing goes, nothing is lost.
    h.toDaemon(helloOk());
    await new Promise((r) => setTimeout(r, 150));
    expect(h.of("update_report")).toHaveLength(0);
    expect(readReports(w.h)).toHaveLength(3);
    h.toDaemon(helloOk({ caps: ["run_version"] }));
    await h.next("update_report", 3);
    expect(
      h
        .of("update_report")
        .map((f) => [f.event, f.to, f.reason, f.rescue_version, f.at]),
    ).toEqual([
      ["updated", "1.1.0", "ok", 7, new Date(T).toISOString()],
      ["held", "1.2.0", "not_quiet_24h", 7, new Date(T + 1000).toISOString()],
      ["refused", "1.3.0", "proof_failed", 7, new Date(T + 2000).toISOString()],
    ]);
    await vi.waitFor(() => expect(readReports(w.h)).toEqual([]));
  });

  it("an unknown reason goes as other", async () => {
    const w = home();
    queueReport(w.h, {
      event: "refused",
      from: "1.0.0",
      to: "1.1.0",
      reason: "brand_new_code",
      at: T,
    });
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit: vi.fn(), every },
    });
    h.toDaemon(helloOk({ caps: ["run_version"] }));
    expect((await h.next("update_report")).reason).toBe("other");
  });

  it("no update deps (every other caller): nothing is sent", async () => {
    const w = home();
    queueReport(w.h, {
      event: "updated",
      from: "1.0.0",
      to: "1.1.0",
      reason: "ok",
      at: T,
    });
    const h = await daemonHarness({});
    h.toDaemon(helloOk({ caps: ["run_version"] }));
    await new Promise((r) => setTimeout(r, 150));
    expect(h.of("update_report")).toHaveLength(0);
    expect(readReports(w.h)).toHaveLength(1);
  });

  describe("a switch is announced and needs the hub's yes", () => {
    const setup = async (ackMs = 2000) => {
      const w = home();
      const exit = vi.fn();
      const h = await daemonHarness({
        update: { entryFile: w.entry, exit, every, enabled: true, ackMs },
      });
      h.toDaemon(helloOk({ caps: ["run_version"] }));
      await vi.waitFor(() => expect(h.daemon.updater).toBeDefined());
      // Let the hello_ok land before asking for a switch.
      await new Promise((r) => setTimeout(r, 100));
      return { w, exit, h };
    };

    it("yes: the report comes first, then the swap and the exit", async () => {
      const { w, exit, h } = await setup();
      const run = h.daemon.updater?.instructFromInstance("0.9.0");
      const rep = await h.next("update_report");
      expect(rep).toMatchObject({
        event: "switching",
        from: "1.0.0",
        to: "0.9.0",
      });
      // Nothing moved before the answer.
      expect(currentVersion(w.h)).toBe("1.0.0");
      expect(readPolicy(w.h).pending).toBeUndefined();
      h.toDaemon({ id: rep.id, type: "update_ack", ok: true });
      expect(await run).toMatchObject({ kind: "switching", version: "0.9.0" });
      expect(currentVersion(w.h)).toBe("0.9.0");
      expect(exit).toHaveBeenCalledWith(1);
    });

    it("no: held, nothing moves", async () => {
      const { w, exit, h } = await setup();
      const run = h.daemon.updater?.instructFromInstance("0.9.0");
      const rep = await h.next("update_report");
      h.toDaemon({ id: rep.id, type: "update_ack", ok: false });
      expect(await run).toEqual({ kind: "retry_later" });
      expect(currentVersion(w.h)).toBe("1.0.0");
      expect(readPolicy(w.h).pending).toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    });

    it("no answer in time: held, nothing moves", async () => {
      const { w, exit, h } = await setup(150);
      const run = h.daemon.updater?.instructFromInstance("0.9.0");
      await h.next("update_report");
      expect(await run).toEqual({ kind: "retry_later" });
      expect(currentVersion(w.h)).toBe("1.0.0");
      expect(exit).not.toHaveBeenCalled();
    });

    it("an ack for another id changes nothing", async () => {
      const { w, h } = await setup(200);
      const run = h.daemon.updater?.instructFromInstance("0.9.0");
      await h.next("update_report");
      h.toDaemon({ id: "other", type: "update_ack", ok: true });
      expect(await run).toEqual({ kind: "retry_later" });
      expect(currentVersion(w.h)).toBe("1.0.0");
    });

    it("a hub that never listed the cap is never asked: held", async () => {
      const w = home();
      const exit = vi.fn();
      const h = await daemonHarness({
        update: { entryFile: w.entry, exit, every, enabled: true },
      });
      h.toDaemon(helloOk());
      await new Promise((r) => setTimeout(r, 100));
      expect(await h.daemon.updater?.instructFromInstance("0.9.0")).toEqual({
        kind: "retry_later",
      });
      expect(h.of("update_report")).toHaveLength(0);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
