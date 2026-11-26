import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentVersion,
  installVersion,
  markFailed,
  QUIET_MS,
  readPolicy,
  readReports,
  setOff,
  setPending,
  type Updater,
  writeState,
} from "../src/index.ts";
import type { FetchedRelease } from "../src/update/fetch.ts";
import type { VerifiedRelease } from "../src/update/verify.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
  delete process.env.OA_BUS_HOME;
});

/** A home on 1.0.0 whose daemon is the 1.1.0 folder, a switch pending. */
function switched() {
  const home = mkdtempSync(join(tmpdir(), "oa-ud-"));
  process.env.OA_BUS_HOME = home;
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
  };
  installVersion(home, "1.0.0", fill("1.0.0"));
  installVersion(home, "1.1.0", fill("1.1.0"));
  writeState(home, { armed: true, current: "1.0.0", previous: "1.0.0" });
  setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: Date.now() });
  return { home, entry: join(home, "bin/dist/index.js") };
}
const every = (fn: () => void, ms: number) => {
  const t = setInterval(fn, Math.min(ms, 20));
  return () => clearInterval(t);
};

describe("the daemon's self-check after a switch (#2552)", () => {
  it("hub link, hello_ok and the agents announced: the new version stays", async () => {
    const w = switched();
    const exit = vi.fn();
    const h = await daemonHarness({
      update: {
        defaultHome: true,
        entryFile: w.entry,
        exit,
        every,
        deadlineMs: 5000,
      },
    });
    expect(readPolicy(w.home).pending).toBeDefined();
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1.1.0",
    });
    await vi.waitFor(() => expect(readPolicy(w.home).pending).toBeUndefined());
    expect(readPolicy(w.home).newestRun).toBe("1.1.0");
    expect(readReports(w.home)).toMatchObject([{ event: "updated" }]);
    expect(currentVersion(w.home)).toBe("1.1.0");
    expect(exit).not.toHaveBeenCalled();
  });

  it("a link that never says hello_ok within the deadline steps back and exits 1", async () => {
    const w = switched();
    const exit = vi.fn();
    await daemonHarness({
      update: {
        defaultHome: true,
        entryFile: w.entry,
        exit,
        every,
        deadlineMs: 150,
      },
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(readPolicy(w.home).failed).toEqual([]);
    expect(readPolicy(w.home).refused["1.1.0"]).toBeDefined();
    expect(readReports(w.home)).toMatchObject([{ event: "stepped_back" }]);
  });

  it("with no update deps (every other caller) nothing reads update.json", async () => {
    const w = switched();
    const exit = vi.fn();
    // A self-check or updater would run on its timers: fake, moved far past any.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const h = await daemonHarness({});
      // The hub is up and says hello_ok: all a self-check would wait for.
      h.toDaemon({
        id: "w",
        type: "hello_ok",
        machine_id: "1".repeat(16),
        machine_label: "laptop",
        server_version: "1.1.0",
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await h.quiet();
      expect(exit).not.toHaveBeenCalled();
      expect(readPolicy(w.home).pending).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The staging rehearsal in code: the default (enabled) loop, no overrides. */
describe("the loop on, end to end (#2552)", () => {
  const CAPS = ["run_version"];
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: v, oaBus: { settingsKinds: ["a"] } }),
    );
  };
  const release = (v: string) => {
    const entries = [
      { path: "package", type: "dir", data: Buffer.alloc(0) },
      { path: "package/dist", type: "dir", data: Buffer.alloc(0) },
      {
        path: "package/dist/index.js",
        type: "file",
        data: Buffer.from(`// ${v}`),
      },
    ] as VerifiedRelease["entries"];
    return {
      rel: { version: v } as FetchedRelease,
      ver: {
        version: v,
        sha512: "x",
        commit: "c",
        entries,
        packageJson: { name: "n", version: v, oaBus: { settingsKinds: ["a"] } },
      } as VerifiedRelease,
    };
  };
  const T0 = 1_700_000_000_000;
  const hello = (run?: string | null) => ({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "2.0.0",
    caps: CAPS,
    ...(run === undefined ? {} : { run_version: run }),
  });
  /** A daemon running 1.0.0 whose ticks the test drives by hand. */
  async function rig(opts: { armed?: boolean; defaultHome?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "oa-ue-"));
    process.env.OA_BUS_HOME = home;
    installVersion(home, "1.0.0", fill("1.0.0"));
    writeState(home, { armed: opts.armed ?? true, current: "1.0.0" });
    let clock = T0;
    const exit = vi.fn();
    const fetched: string[] = [];
    const fetch = async (v: string) => {
      fetched.push(v);
      return release(v).rel;
    };
    const h = await daemonHarness({
      update: {
        defaultHome: opts.defaultHome ?? true,
        entryFile: join(home, "bin/dist/index.js"),
        exit,
        every: () => () => {},
        deadlineMs: 5000,
        now: () => clock,
        fetch,
        verify: (r) => release(r.version).ver,
      },
    });
    const u = h.daemon.updater as Updater;
    const named = () => (u as unknown as { named?: string }).named;
    return {
      home,
      exit,
      fetched,
      h,
      u,
      named,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }
  const switching = (h: Awaited<ReturnType<typeof rig>>["h"]) =>
    h.of("update_report").filter((f) => f.event === "switching");

  it("named 2.0.0: fetch, verify, switching, ack, swap, then `updated` from the new daemon", async () => {
    const w = await rig();
    await w.h.next("hello");
    w.h.toDaemon(hello("2.0.0"));
    await vi.waitFor(() =>
      expect(readPolicy(w.home).staged?.version).toBe("2.0.0"),
    );
    expect(w.fetched).toEqual(["2.0.0"]);
    expect(currentVersion(w.home)).toBe("1.0.0");
    await w.u.tick(); // starts the quiet window
    await w.u.tick();
    expect(switching(w.h)).toHaveLength(0); // not quiet yet
    w.advance(QUIET_MS);
    const done = w.u.tick();
    await vi.waitFor(() => expect(switching(w.h)).toHaveLength(1));
    const sw = switching(w.h)[0] as { id: string; from: string; to: string };
    expect([sw.from, sw.to]).toEqual(["1.0.0", "2.0.0"]);
    expect(currentVersion(w.home)).toBe("1.0.0"); // asked first, not swapped yet
    expect(w.exit).not.toHaveBeenCalled();
    // The ack answers the switching frame's id.
    w.h.toDaemon({ type: "update_ack", id: sw.id, ok: true });
    await done;
    expect(w.exit).toHaveBeenCalledWith(1);
    expect(currentVersion(w.home)).toBe("2.0.0");

    await w.h.daemon.stop(); // the old process is gone before the new one starts
    // The service restarts the daemon from the new folder: it checks itself and reports.
    const h2 = await daemonHarness({
      update: {
        defaultHome: true,
        entryFile: join(w.home, "bin/dist/index.js"),
        exit: vi.fn(),
        every: (fn, ms) => {
          const t = setInterval(fn, Math.min(ms, 20));
          return () => clearInterval(t);
        },
        deadlineMs: 5000,
      },
    });
    await h2.next("hello");
    h2.toDaemon(hello("2.0.0"));
    await vi.waitFor(() => expect(readPolicy(w.home).pending).toBeUndefined());
    // The next hello flushes what the self-check queued.
    h2.toDaemon(hello("2.0.0"));
    await vi.waitFor(() =>
      expect(h2.of("update_report").map((f) => f.event)).toContain("updated"),
    );
    expect(readPolicy(w.home).pending).toBeUndefined();
    expect(readPolicy(w.home).newestRun).toBe("2.0.0");
  });

  it("the hub then clears the name while a newer one is staged: no swap", async () => {
    const w = await rig();
    await w.h.next("hello");
    w.h.toDaemon(hello("2.0.0"));
    await vi.waitFor(() =>
      expect(readPolicy(w.home).staged?.version).toBe("2.0.0"),
    );
    w.h.toDaemon({ type: "run_version", id: "c", run_version: null });
    await vi.waitFor(() => expect(w.named()).toBeUndefined());
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    await w.u.tick();
    expect(switching(w.h)).toHaveLength(0);
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
  });

  it("auto-update off: named and staged, still no swap", async () => {
    const w = await rig();
    await w.h.next("hello");
    w.h.toDaemon(hello("2.0.0"));
    await vi.waitFor(() =>
      expect(readPolicy(w.home).staged?.version).toBe("2.0.0"),
    );
    setOff(w.home, true);
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(switching(w.h)).toHaveLength(0);
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
  });

  it("an unarmed install: named and staged, still no swap", async () => {
    const w = await rig({ armed: false });
    await w.h.next("hello");
    w.h.toDaemon(hello("2.0.0"));
    // Unarmed: the instruction is not even staged.
    await vi.waitFor(() => expect(w.named()).toBe("2.0.0"));
    expect(readPolicy(w.home).staged).toBeUndefined();
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(switching(w.h)).toHaveLength(0);
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
  });

  it("no version named at all: nothing is fetched or swapped", async () => {
    const w = await rig();
    await w.h.next("hello");
    w.h.toDaemon(hello(null));
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(w.fetched).toEqual([]);
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("a second bus home ignores what the instance names (hello_ok and push)", async () => {
    const w = await rig({ defaultHome: false });
    await w.h.next("hello");
    w.h.toDaemon(hello("2.0.0"));
    w.h.toDaemon({ type: "run_version", id: "p", run_version: "2.0.0" });
    w.h.toDaemon({ type: "install_now", id: "i" });
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(w.named()).toBeUndefined();
    expect(w.fetched).toEqual([]);
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(switching(w.h)).toHaveLength(0);
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("a version that failed on this machine is not retried when the instance defaults to it", async () => {
    const w = await rig();
    markFailed(w.home, "2.0.0");
    await w.h.next("hello");
    // The default reaches the machine as run_version, exactly like a named one.
    w.h.toDaemon(hello("2.0.0"));
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(w.fetched).toEqual([]);
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(switching(w.h)).toHaveLength(0);
    expect(currentVersion(w.home)).toBe("1.0.0");
  });
});
