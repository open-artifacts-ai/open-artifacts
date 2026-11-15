import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearPending,
  currentVersion,
  installVersion,
  loginActive,
  markLoginActive,
  QUIET_MS,
  queueReport,
  readInstallRequest,
  readPolicy,
  readReports,
  readState,
  requestInstall,
  runningVersion,
  setPending,
  setStaged,
  startSelfCheck,
  UPDATER_LOOP_ENABLED,
  Updater,
  versionDir,
  writeState,
} from "../src/index.ts";
import { ReleaseError } from "../src/update/errors.ts";
import type { FetchedRelease } from "../src/update/fetch.ts";
import type { VerifiedRelease } from "../src/update/verify.ts";

const T = 1_700_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), "oa-upd-"));

/** A home running 1.0.0 with a kept previous 0.9.0, armed. */
function world(prev = true) {
  const home = tmp();
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: v, oaBus: { settingsKinds: ["a"] } }),
    );
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
  };
  if (prev) installVersion(home, "0.9.0", fill("0.9.0"));
  installVersion(home, "1.0.0", fill("1.0.0"));
  return { home, fill };
}

describe("the loop is off in this PR", () => {
  it("UPDATER_LOOP_ENABLED is false and nothing runs", async () => {
    expect(UPDATER_LOOP_ENABLED).toBe(false);
    const { home } = world();
    setStaged(home, "1.1.0", T);
    const exit = vi.fn();
    const u = new Updater({
      home,
      running: "1.0.0",
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      serverVersion: () => undefined,
      exit,
      log: () => {},
      now: () => T + 10 * QUIET_MS,
    });
    expect(await u.instruct({ version: "1.1.0" })).toEqual({
      kind: "disabled",
    });
    await u.tick();
    await u.tick();
    expect(exit).not.toHaveBeenCalled();
    expect(currentVersion(home)).toBe("1.0.0");
  });
});

describe("the self-check after a switch", () => {
  const manual = () => {
    let f: (() => void) | undefined;
    return {
      every: (fn: () => void) => {
        f = fn;
        return () => {
          f = undefined;
        };
      },
      poll: () => f?.(),
      live: () => f !== undefined,
    };
  };

  it("a good release: current, one previous, pending gone, report queued", () => {
    const { home, fill } = world();
    installVersion(home, "1.1.0", fill("1.1.0")); // as the swap would leave it
    writeState(home, { armed: true, current: "1.0.0", previous: "0.9.0" });
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: T });
    const m = manual();
    let ready = false;
    let clock = T;
    const exit = vi.fn();
    const c = startSelfCheck({
      home,
      running: "1.1.0",
      now: () => clock,
      ready: () => ready,
      exit,
      log: () => {},
      every: m.every,
    });
    expect(c.state()).toBe("checking");
    m.poll();
    expect(readPolicy(home).pending).toBeDefined();
    ready = true;
    clock += 5000;
    m.poll();
    expect(c.state()).toBe("ok");
    const p = readPolicy(home);
    expect(p.pending).toBeUndefined();
    expect(p.newestRun).toBe("1.1.0");
    expect(readState(home)).toMatchObject({
      armed: true,
      current: "1.1.0",
      previous: "1.0.0",
    });
    expect(existsSync(versionDir(home, "0.9.0"))).toBe(false);
    expect(readReports(home)).toEqual([
      { event: "updated", from: "1.0.0", to: "1.1.0", reason: "ok", at: clock },
    ]);
    expect(exit).not.toHaveBeenCalled();
    expect(m.live()).toBe(false);
  });

  it("never reaches hello in 60 s: steps back, remembers, counts, reports, exits 1", () => {
    const { home, fill } = world();
    installVersion(home, "1.1.0", fill("1.1.0"));
    // The updater's swap: bin to 1.1.0, state keeps 1.0.0 as current until ok.
    writeState(home, { armed: true, current: "1.0.0", previous: "0.9.0" });
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: T });
    const m = manual();
    let clock = T;
    const exit = vi.fn();
    startSelfCheck({
      home,
      running: "1.1.0",
      now: () => clock,
      ready: () => false,
      exit,
      log: () => {},
      every: m.every,
    });
    clock += 59_000;
    m.poll();
    expect(exit).not.toHaveBeenCalled();
    clock += 2000;
    m.poll();
    expect(exit).toHaveBeenCalledWith(1);
    expect(currentVersion(home)).toBe("1.0.0");
    const p = readPolicy(home);
    expect(p.failed).toEqual(["1.1.0"]);
    expect(p.lastAt).toBe(clock);
    expect(p.pending).toBeUndefined();
    expect(readState(home).current).toBe("1.0.0");
    expect(readReports(home)).toMatchObject([
      {
        event: "stepped_back",
        from: "1.0.0",
        to: "1.1.0",
        reason: "unhealthy",
      },
    ]);
    // Polling after the end does nothing more.
    m.poll();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("an unready daemon that hangs is still caught by the clock", () => {
    const { home } = world();
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: T });
    const exit = vi.fn();
    const m = manual();
    let clock = T;
    startSelfCheck({
      home,
      running: "1.1.0",
      now: () => clock,
      ready: () => {
        throw new Error("hub object not built yet");
      },
      exit,
      log: () => {},
      every: m.every,
      deadlineMs: 10_000,
    });
    clock += 10_000;
    m.poll();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a stale pending left under the old version is cleared; nothing else", () => {
    const { home } = world();
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: T });
    const exit = vi.fn();
    const c = startSelfCheck({
      home,
      running: "1.0.0",
      ready: () => true,
      exit,
      log: () => {},
    });
    expect(c.state()).toBe("none");
    expect(readPolicy(home).pending).toBeUndefined();
    // A pending naming neither version is left for the rescue shim.
    setPending(home, { from: "0.8.0", to: "1.1.0", startedAt: T });
    startSelfCheck({
      home,
      running: "1.0.0",
      ready: () => true,
      exit,
      log: () => {},
    });
    expect(readPolicy(home).pending).toBeDefined();
    clearPending(home);
    expect(
      startSelfCheck({
        home,
        running: "1.0.0",
        ready: () => true,
        exit,
        log: () => {},
      }).state(),
    ).toBe("none");
  });

  it("runningVersion reads the folder the entry lives in", () => {
    const { home } = world();
    expect(runningVersion(join(home, "bin/dist/index.js"), home)).toBe("1.0.0");
    expect(runningVersion(join(tmp(), "x.js"), home)).toBeUndefined();
  });
});

describe("login flag", () => {
  it("is on while a live login holds it, off when cleared or stale", () => {
    const home = tmp();
    expect(loginActive(home)).toBe(false);
    const done = markLoginActive(home, () => T);
    expect(loginActive(home, () => T)).toBe(true);
    expect(loginActive(home, () => T + 16 * 60_000)).toBe(false);
    expect(
      loginActive(
        home,
        () => T,
        () => false,
      ),
    ).toBe(false);
    done();
    expect(loginActive(home, () => T)).toBe(false);
  });
});

describe("the report queue", () => {
  it("keeps the last 50 and drops anything malformed", () => {
    const home = tmp();
    for (let i = 0; i < 60; i++)
      queueReport(home, {
        event: "updated",
        from: "1.0.0",
        to: "1.0.1",
        reason: "ok",
        at: i,
      });
    queueReport(home, {
      event: "updated",
      from: "1.0.0",
      to: "1.0.1",
      reason: "Not Closed",
      at: 1,
    });
    const r = readReports(home);
    expect(r).toHaveLength(50);
    expect(r[0]?.at).toBe(10);
    expect(statLike(home)).toBe(0o600);
  });
});

import { statSync } from "node:fs";

const statLike = (home: string) =>
  statSync(join(home, "update-reports.json")).mode & 0o777;

describe("the updater loop (enabled by a test only)", () => {
  const fake = (v: string, kinds: string[] = ["a"]) => {
    const entries = [
      { path: "package", type: "dir", data: Buffer.alloc(0) },
      { path: "package/dist", type: "dir", data: Buffer.alloc(0) },
      {
        path: "package/dist/index.js",
        type: "file",
        data: Buffer.from(`// ${v}`),
      },
      {
        path: "package/package.json",
        type: "file",
        data: Buffer.from(JSON.stringify({ version: v })),
      },
    ] as VerifiedRelease["entries"];
    return {
      rel: { version: v } as FetchedRelease,
      ver: {
        version: v,
        sha512: "x",
        commit: "c",
        entries,
        packageJson: { name: "n", version: v, oaBus: { settingsKinds: kinds } },
      } as VerifiedRelease,
    };
  };
  const make = (
    over: {
      kinds?: string[];
      busy?: () => boolean;
      login?: () => boolean;
      verify?: () => VerifiedRelease;
      fetchFails?: boolean;
    } = {},
  ) => {
    const w = world();
    let clock = T;
    const exit = vi.fn();
    const f = fake("1.1.0", over.kinds);
    const u = new Updater({
      home: w.home,
      running: "1.0.0",
      enabled: true,
      now: () => clock,
      busy: () => ({
        pending: over.busy?.() ? 1 : 0,
        outbox: 0,
        codexQueue: 0,
      }),
      loginActive: over.login ?? (() => false),
      serverVersion: () => "1.2.0",
      exit,
      log: () => {},
      fetch: async () => {
        if (over.fetchFails) throw new ReleaseError("fetch_failed", "net");
        return f.rel;
      },
      verify: over.verify ?? (() => f.ver),
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    return { ...w, u, exit, advance, clock: () => clock };
  };
  const arm = (w: { home: string }) => readPolicy(w.home);

  it("stages at once, swaps only after 30 s of quiet, then exits non-zero", async () => {
    const w = make();
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "staged",
      version: "1.1.0",
    });
    expect(arm(w).staged?.manifest).toBeDefined();
    // Not yet: bin is still on 1.0.0, and the staged copy has the launcher.
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(existsSync(join(versionDir(w.home, "1.1.0"), "node"))).toBe(true);
    await w.u.tick();
    w.advance(QUIET_MS - 1000);
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    w.advance(1000);
    await w.u.tick();
    expect(w.exit).toHaveBeenCalledWith(1);
    expect(currentVersion(w.home)).toBe("1.1.0");
    const p = arm(w);
    expect(p.pending).toEqual({
      from: "1.0.0",
      to: "1.1.0",
      startedAt: w.clock(),
      attempts: 0,
    });
    expect(p.lastAt).toBe(w.clock());
    // update.json keeps armed/off as they were.
    expect(p.armed).toBe(true);
    expect(p.off).toBe(false);
  });

  it("busy resets the wait; a login holds it", async () => {
    let busy = false;
    let login = false;
    const w = make({ busy: () => busy, login: () => login });
    await w.u.instruct({ version: "1.1.0" });
    await w.u.tick();
    w.advance(QUIET_MS - 1);
    busy = true;
    await w.u.tick();
    busy = false;
    w.advance(5000);
    await w.u.tick();
    w.advance(QUIET_MS - 1);
    login = true;
    await w.u.tick();
    login = false;
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    w.advance(QUIET_MS);
    await w.u.tick();
    expect(w.exit).toHaveBeenCalled();
  });

  it("off stops everything, and an instruction cannot turn it on", async () => {
    const w = make();
    await w.u.instruct({ version: "1.1.0" });
    const j = JSON.parse(readFileSync(join(w.home, "update.json"), "utf8"));
    writeFileSync(
      join(w.home, "update.json"),
      JSON.stringify({ ...j, off: true }),
    );
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    expect(await w.u.instruct({ version: "1.2.0" })).toEqual({
      kind: "refused",
      reason: "off",
    });
    expect(readPolicy(w.home).off).toBe(true);
  });

  it("a staged file changed since the proof is refused, dropped and reported", async () => {
    const w = make();
    await w.u.instruct({ version: "1.1.0" });
    writeFileSync(join(versionDir(w.home, "1.1.0"), "dist/index.js"), "evil");
    await w.u.tick();
    w.advance(QUIET_MS);
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(existsSync(versionDir(w.home, "1.1.0"))).toBe(false);
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(readReports(w.home)).toMatchObject([
      { event: "refused", to: "1.1.0", reason: "staged_changed" },
    ]);
  });

  it(".live markers do not count as a change", async () => {
    const w = make();
    await w.u.instruct({ version: "1.1.0" });
    mkdirSync(join(versionDir(w.home, "1.1.0"), ".live"));
    writeFileSync(join(versionDir(w.home, "1.1.0"), ".live/4242"), "");
    await w.u.tick();
    w.advance(QUIET_MS);
    await w.u.tick();
    expect(w.exit).toHaveBeenCalledWith(1);
  });

  it("a release that wants a new kind of settings change needs you: no swap", async () => {
    const w = make({ kinds: ["a", "b"] });
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "needs_you",
    });
    expect(readPolicy(w.home).needsYou).toBe(true);
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(existsSync(versionDir(w.home, "1.1.0"))).toBe(false);
    expect(readReports(w.home)).toMatchObject([
      { event: "needs_you", reason: "needs_you" },
    ]);
    await w.u.tick();
    w.advance(10 * QUIET_MS);
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("a malformed kinds list needs you too", async () => {
    const w = make({ kinds: ["Not Valid!"] });
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "needs_you",
    });
  });

  it("a refused proof is remembered with backoff and reported", async () => {
    const w = make({
      verify: () => {
        throw new ReleaseError("proof_failed", "bad");
      },
    });
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "proof_refused",
      code: "proof_failed",
    });
    expect(readPolicy(w.home).refused["1.1.0"]).toMatchObject({ count: 1 });
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "refused",
      reason: "refused_backoff",
    });
    expect(readReports(w.home)).toMatchObject([
      { event: "refused", reason: "proof_failed" },
    ]);
  });

  it("a network failure is retried later, not remembered", async () => {
    const w = make({ fetchFails: true });
    expect(await w.u.instruct({ version: "1.1.0" })).toEqual({
      kind: "retry_later",
    });
    expect(readPolicy(w.home).refused).toEqual({});
    expect(readReports(w.home)).toEqual([]);
  });

  it("forward only, not past the server, bad versions reported", async () => {
    const w = make();
    expect(await w.u.instruct({ version: "1.0.0" })).toMatchObject({
      reason: "not_forward",
    });
    expect(await w.u.instruct({ version: "9.0.0" })).toMatchObject({
      reason: "ahead_of_server",
    });
    expect(await w.u.instruct({ version: "1.2" })).toMatchObject({
      reason: "bad_version",
    });
    expect(readReports(w.home).map((r) => r.reason)).toEqual([
      "ahead_of_server",
      "bad_instruction",
    ]);
  });

  it("one attempt per 6 h: the swap counts, the next instruction waits", async () => {
    const w = make();
    await w.u.instruct({ version: "1.1.0" });
    await w.u.tick();
    w.advance(QUIET_MS);
    await w.u.tick();
    expect(w.exit).toHaveBeenCalled();
    expect(await w.u.instruct({ version: "1.2.0" })).toMatchObject({
      reason: "rate_limited",
    });
  });

  it("an instance's return to the kept previous skips staging and quiet", async () => {
    const w = make();
    expect(await w.u.instruct({ version: "0.9.0", stepBack: true })).toEqual({
      kind: "switching",
      version: "0.9.0",
    });
    expect(currentVersion(w.home)).toBe("0.9.0");
    expect(w.exit).toHaveBeenCalledWith(1);
  });

  it("the 24 h notice goes out once per version", async () => {
    const w = make({ busy: () => true });
    await w.u.instruct({ version: "1.1.0" });
    w.advance(24 * 3600_000 + 1);
    await w.u.tick();
    await w.u.tick();
    expect(
      readReports(w.home).filter((r) => r.event === "ready_24h"),
    ).toHaveLength(1);
  });

  it("`oa-bus update`'s request installs the staged version at once, once", async () => {
    const w = make({ busy: () => true });
    await w.u.instruct({ version: "1.1.0" });
    requestInstall(w.home, "1.1.0", w.clock());
    await w.u.tick();
    expect(w.exit).toHaveBeenCalledWith(1);
    expect(readInstallRequest(w.home)).toBeUndefined();
  });

  it("a request for another version, a stale one, or during a login does nothing", async () => {
    for (const [ver, age, login] of [
      ["1.5.0", 0, false],
      ["1.1.0", 6 * 60_000, false],
      ["1.1.0", 0, true],
    ] as const) {
      const w = make({ busy: () => true, login: () => login });
      await w.u.instruct({ version: "1.1.0" });
      requestInstall(w.home, ver, w.clock() - age);
      await w.u.tick();
      expect(w.exit).not.toHaveBeenCalled();
      expect(readInstallRequest(w.home)).toBeUndefined();
    }
  });

  it("a newer staged version replaces the older and removes its folder", async () => {
    const w = make();
    await w.u.instruct({ version: "1.1.0" });
    const f2 = fake("1.2.0");
    const u2 = new Updater({
      home: w.home,
      running: "1.0.0",
      enabled: true,
      now: () => T,
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      serverVersion: () => undefined,
      exit: () => {},
      log: () => {},
      fetch: async () => f2.rel,
      verify: () => f2.ver,
    });
    await u2.instruct({ version: "1.2.0" });
    expect(readPolicy(w.home).staged?.version).toBe("1.2.0");
    expect(existsSync(versionDir(w.home, "1.1.0"))).toBe(false);
  });
});
