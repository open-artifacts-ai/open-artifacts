import {
  chmodSync,
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
  accept,
  clearPending,
  currentVersion,
  installVersion,
  loginActive,
  markFailed,
  markLoginActive,
  queueReport,
  readInstallRequest,
  readPolicy,
  readReports,
  readState,
  recordAttempt,
  requestInstall,
  runningVersion,
  setPending,
  setStaged,
  startSelfCheck,
  takeInstallRequest,
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

describe("the loop is on, for a version the instance names", () => {
  it("UPDATER_LOOP_ENABLED is true; with nothing named, nothing swaps", async () => {
    expect(UPDATER_LOOP_ENABLED).toBe(true);
    const { home } = world();
    setStaged(home, "1.1.0", T);
    const exit = vi.fn();
    // No `enabled` override: the default is the loop's real switch.
    const u = new Updater({
      home,
      running: "1.0.0",
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => undefined,
      exit,
      log: () => {},
      now: () => T,
    });
    await u.onIdle();
    await u.tick();
    expect(exit).not.toHaveBeenCalled();
    expect(currentVersion(home)).toBe("1.0.0");
    // A bad instruction is refused, never staged.
    expect(await u.instruct({ version: "nope" })).toMatchObject({
      kind: "refused",
    });
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
      hub: () => ready,
      local: () => true,
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
      hub: () => false,
      local: () => true,
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
    // Nobody answered: stepped back, but the version is not banned.
    expect(p.failed).toEqual([]);
    expect(p.startFailures["1.1.0"]).toBeDefined();
    expect(p.startFailures["1.1.0"]?.at).toBe(clock);
    expect(p.pending).toBeUndefined();
    expect(readState(home).current).toBe("1.0.0");
    expect(readReports(home)).toMatchObject([
      {
        event: "stepped_back",
        from: "1.0.0",
        to: "1.1.0",
        reason: "hub_unreachable",
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
      hub: () => {
        throw new Error("hub object not built yet");
      },
      local: () => true,
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
      hub: () => true,
      local: () => true,
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
      hub: () => true,
      local: () => true,
      exit,
      log: () => {},
    });
    expect(readPolicy(home).pending).toBeDefined();
    clearPending(home);
    expect(
      startSelfCheck({
        home,
        running: "1.0.0",
        hub: () => true,
        local: () => true,
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

describe("the install request", () => {
  it("is one-shot, owner-only and taken once", () => {
    const home = tmp();
    expect(requestInstall(home, "1.1.0", T)).toBe(true);
    // A second request while one waits does not replace it.
    expect(requestInstall(home, "1.2.0", T + 1000)).toBe(false);
    expect(statSync(join(home, "update-request.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(takeInstallRequest(home)).toEqual({ version: "1.1.0", at: T });
    expect(takeInstallRequest(home)).toBeUndefined();
    expect(existsSync(join(home, "update-request.json"))).toBe(false);
    // Only one of two takers gets it.
    requestInstall(home, "1.1.0", T);
    const got = [takeInstallRequest(home), takeInstallRequest(home)];
    expect(got.filter(Boolean)).toHaveLength(1);
  });
  it("an old request makes way for a new one", () => {
    const home = tmp();
    requestInstall(home, "1.1.0", T);
    expect(requestInstall(home, "1.2.0", T + 6 * 60_000)).toBe(true);
    expect(readInstallRequest(home)?.version).toBe("1.2.0");
  });
  it("a group- or world-readable or malformed request is dropped unread", () => {
    const home = tmp();
    const f = join(home, "update-request.json");
    writeFileSync(f, JSON.stringify({ version: "1.1.0", at: T }), {
      mode: 0o644,
    });
    chmodSync(f, 0o644);
    expect(readInstallRequest(home)).toBeUndefined();
    expect(takeInstallRequest(home)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "{nope", { mode: 0o600 });
    expect(takeInstallRequest(home)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
    expect(requestInstall(home, "1.1", T)).toBe(false);
  });
  it("is consumed even when nothing is staged", async () => {
    const { home } = world();
    requestInstall(home, "1.1.0", T);
    const u = new Updater({
      home,
      running: "1.0.0",
      enabled: true,
      now: () => T,
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => undefined,
      exit: () => {},
      log: () => {},
    });
    await u.tick();
    expect(existsSync(join(home, "update-request.json"))).toBe(false);
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
      announce?: (
        from: string,
        to: string,
        reason?: string,
      ) => Promise<boolean>;
    } = {},
  ) => {
    const w = world();
    let clock = T;
    const exit = vi.fn();
    const hubUp = { v: true };
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
      hubReady: () => hubUp.v,
      announceSwitch: over.announce ?? (async () => true),
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
    return { ...w, u, exit, advance, hubUp, clock: () => clock };
  };
  const arm = (w: { home: string }) => readPolicy(w.home);

  it("stages at once, swaps when idle with no clock advance, then exits non-zero", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    expect(await w.u.instructFromInstance("1.1.0")).toEqual({
      kind: "staged",
      version: "1.1.0",
    });
    expect(arm(w).staged?.manifest).toBeDefined();
    // Still busy: bin stays on 1.0.0, and the staged copy has the launcher.
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(existsSync(join(versionDir(w.home, "1.1.0"), "node"))).toBe(true);
    await w.u.onIdle();
    expect(w.exit).not.toHaveBeenCalled();
    busy = false;
    await w.u.onIdle();
    expect(w.clock()).toBe(T);
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

  it("retries the named release on backoff expiry without a new hub frame", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = make({});
    try {
      markFailed(w.home, "1.1.0", T);
      expect((await w.u.instructFromInstance("1.1.0")).kind).toBe("refused");
      w.advance(15 * 60_000);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(w.exit).toHaveBeenCalledOnce();
    } finally {
      w.u.stop();
      vi.useRealTimers();
    }
  });
  it("switches a still-busy machine at its 30-minute deadline without a tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = make({ busy: () => true });
    try {
      await w.u.instructFromInstance("1.1.0");
      w.advance(30 * 60_000 - 1);
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(w.exit).not.toHaveBeenCalled();
      w.advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(currentVersion(w.home)).toBe("1.1.0");
      expect(w.exit).toHaveBeenCalledOnce();
    } finally {
      w.u.stop();
      vi.useRealTimers();
    }
  });

  it("busy blocks the install; login holds it until cleared", async () => {
    let busy = true;
    let login = false;
    const w = make({ busy: () => busy, login: () => login });
    await w.u.instructFromInstance("1.1.0");
    await w.u.onIdle();
    expect(w.exit).not.toHaveBeenCalled();
    busy = false;
    login = true;
    await w.u.onIdle();
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    login = false;
    await w.u.tick();
    expect(w.exit).toHaveBeenCalledWith(1);
  });

  it("switches when the login flag clears between ticks with no other activity", async () => {
    const { home } = world();
    let switched!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      switched = resolve;
    });
    const f = fake("1.1.0");
    writeState(home, { armed: true, current: "1.0.0" });
    const u = new Updater({
      home,
      running: "1.0.0",
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => "1.2.0",
      log: () => {},
      every: () => () => {},
      loginActive: () => loginActive(home),
      fetch: async () => f.rel,
      verify: () => f.ver,
      exit: switched,
    });
    u.start();
    try {
      const done = markLoginActive(home);
      expect((await u.instructFromInstance("1.1.0")).kind).toBe("staged");
      expect(currentVersion(home)).toBe("1.0.0");
      done();
      expect(await exit).toBe(1);
      expect(currentVersion(home)).toBe("1.1.0");
    } finally {
      u.stop();
    }
  });

  it("onIdle installs immediately when idle and respects outbox busy count", async () => {
    const { home } = world();
    const exit = vi.fn();
    let outbox = 1;
    const f = fake("1.1.0");
    const u = new Updater({
      home,
      running: "1.0.0",
      enabled: true,
      now: () => T,
      busy: () => ({ pending: 0, outbox, codexQueue: 0 }),
      loginActive: () => false,
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => "1.2.0",
      exit,
      log: () => {},
      fetch: async () => f.rel,
      verify: () => f.ver,
    });
    expect(await u.instructFromInstance("1.1.0")).toEqual({
      kind: "staged",
      version: "1.1.0",
    });
    await u.onIdle();
    expect(exit).not.toHaveBeenCalled();
    expect(readPolicy(home).pending).toBeUndefined();
    outbox = 0;
    await u.onIdle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(readPolicy(home).pending).toEqual({
      from: "1.0.0",
      to: "1.1.0",
      startedAt: T,
      attempts: 0,
    });
  });

  it("off stops everything, and an instruction cannot turn it on", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    const j = JSON.parse(readFileSync(join(w.home, "update.json"), "utf8"));
    writeFileSync(
      join(w.home, "update.json"),
      JSON.stringify({ ...j, off: true }),
    );
    busy = false;
    await w.u.onIdle();
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    expect(await w.u.instruct({ version: "1.2.0" })).toEqual({
      kind: "refused",
      reason: "off",
    });
    expect(readPolicy(w.home).off).toBe(true);
  });

  it("a staged file changed since the proof is refused, dropped and reported", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    writeFileSync(join(versionDir(w.home, "1.1.0"), "dist/index.js"), "evil");
    busy = false;
    await w.u.onIdle();
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(existsSync(versionDir(w.home, "1.1.0"))).toBe(false);
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(readReports(w.home)).toMatchObject([
      { event: "refused", to: "1.1.0", reason: "staged_changed" },
    ]);
  });

  it(".live markers do not count as a change", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    mkdirSync(join(versionDir(w.home, "1.1.0"), ".live"));
    writeFileSync(join(versionDir(w.home, "1.1.0"), ".live/4242"), "");
    busy = false;
    await w.u.onIdle();
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
    await w.u.onIdle();
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
      "not_forward",
      "ahead_of_server",
      "bad_instruction",
    ]);
  });

  it("one attempt per 6 h while unconfirmed: the swap counts, the next instruction waits", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    busy = false;
    await w.u.onIdle();
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

  // #2719: stopping a rollout.
  it("a staged version swaps only while the instance still names it", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    w.u.clearNamed();
    busy = false;
    await w.u.onIdle();
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
  });

  it("naming the running version drops a newer staged one", async () => {
    let busy = true;
    const w = make({ busy: () => busy });
    await w.u.instructFromInstance("1.1.0");
    expect(readPolicy(w.home).staged?.version).toBe("1.1.0");
    await w.u.instructFromInstance("1.0.0");
    expect(readPolicy(w.home).staged).toBeUndefined();
    expect(existsSync(versionDir(w.home, "1.1.0"))).toBe(false);
    busy = false;
    await w.u.onIdle();
    await w.u.tick();
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("the person's own request still installs when nothing is named, and says so", async () => {
    const reasons: (string | undefined)[] = [];
    const w = make({
      busy: () => true,
      announce: async (_f, _t, r) => {
        reasons.push(r);
        return true;
      },
    });
    await w.u.instruct({ version: "1.1.0" });
    requestInstall(w.home, "1.1.0", w.clock());
    await w.u.tick();
    expect(w.exit).toHaveBeenCalledWith(1);
    expect(reasons).toEqual(["requested"]);
  });

  it("a clearing during the ack wait stops the swap", async () => {
    let busy = true;
    let w!: ReturnType<typeof make>;
    w = make({
      busy: () => busy,
      announce: async () => {
        w.u.clearNamed();
        return true;
      },
    });
    await w.u.instructFromInstance("1.1.0");
    busy = false;
    await w.u.onIdle();
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
  });

  it("a staged tree changed during the ack wait stops the swap", async () => {
    let busy = true;
    let w!: ReturnType<typeof make>;
    w = make({
      busy: () => busy,
      announce: async () => {
        writeFileSync(
          join(versionDir(w.home, "1.1.0"), "dist/index.js"),
          "evil",
        );
        return true;
      },
    });
    await w.u.instructFromInstance("1.1.0");
    busy = false;
    await w.u.onIdle();
    expect(w.exit).not.toHaveBeenCalled();
    expect(currentVersion(w.home)).toBe("1.0.0");
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
      hubReady: () => true,
      announceSwitch: async () => true,
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

describe("review fixes (#2552)", () => {
  const ups = (
    home: string,
    over: Partial<ConstructorParameters<typeof Updater>[0]> = {},
  ) =>
    new Updater({
      home,
      running: "1.0.0",
      enabled: true,
      now: () => T,
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => undefined,
      exit: () => {},
      log: () => {},
      ...over,
    });
  const switchedWorld = () => {
    const { home, fill } = world();
    installVersion(home, "1.1.0", fill("1.1.0"));
    writeState(home, { armed: true, current: "1.0.0", previous: "0.9.0" });
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: T });
    return home;
  };
  const check = (home: string, hub: boolean, local: boolean) => {
    let clock = T;
    let f: (() => void) | undefined;
    const exit = vi.fn();
    startSelfCheck({
      home,
      running: "1.1.0",
      now: () => clock,
      hub: () => hub,
      local: () => local,
      exit,
      log: () => {},
      every: (fn) => {
        f = fn;
        return () => {};
      },
    });
    clock += 60_000;
    f?.();
    return { exit, at: clock };
  };

  it("hub down for 60 s after a good switch: stepped back, not banned, retried later", () => {
    const home = switchedWorld();
    const { exit, at } = check(home, false, true);
    expect(exit).toHaveBeenCalledWith(1);
    expect(currentVersion(home)).toBe("1.0.0");
    const p = readPolicy(home);
    expect(p.failed).toEqual([]);
    expect(p.startFailures["1.1.0"]).toMatchObject({ count: 1, at });
    expect(readReports(home)).toMatchObject([
      { event: "stepped_back", reason: "hub_unreachable" },
    ]);
    // Inside the backoff it waits; after it, the same version is accepted again.
    expect(
      accept(p, { version: "1.1.0" }, at + 1000, { running: "1.0.0" }),
    ).toEqual({
      ok: false,
      reason: "refused_backoff",
    });
    // A retry is available after the startup backoff.
    expect(
      accept(p, { version: "1.1.0" }, at + 25 * 3600_000, { running: "1.0.0" }),
    ).toEqual({ ok: true });
  });

  it("a broken daemon records a retry, with the hub up or down", () => {
    for (const hub of [true, false]) {
      const home = switchedWorld();
      const { exit } = check(home, hub, false);
      expect(exit).toHaveBeenCalledWith(1);
      expect(readPolicy(home).startFailures["1.1.0"]).toMatchObject({
        count: 1,
      });
      expect(readPolicy(home).refused).toEqual({});
    }
  });

  it("no switch while the hub link is down", async () => {
    const w = (() => {
      const { home } = world();
      return home;
    })();
    const exit = vi.fn();
    let up = false;
    const u = ups(w, { exit, hubReady: () => up });
    expect(await u.instruct({ version: "0.9.0", stepBack: true })).toEqual({
      kind: "retry_later",
    });
    expect(exit).not.toHaveBeenCalled();
    expect(currentVersion(w)).toBe("1.0.0");
    up = true;
  });

  it("an instance-asked step back waits for a login, then goes", async () => {
    const { home } = world();
    let login = true;
    const exit = vi.fn();
    const u = ups(home, { exit, loginActive: () => login });
    expect(await u.instruct({ version: "0.9.0", stepBack: true })).toEqual({
      kind: "retry_later",
    });
    await u.tick();
    expect(exit).not.toHaveBeenCalled();
    expect(currentVersion(home)).toBe("1.0.0");
    login = false;
    await u.tick();
    expect(exit).toHaveBeenCalledWith(1);
    expect(currentVersion(home)).toBe("0.9.0");
  });

  it("an instance step back that meets the one-swap lock is held and retried (#2719)", async () => {
    const { home } = world();
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((r) => {
      release = r;
    });
    const exit = vi.fn();
    let n = 0;
    const u = ups(home, {
      exit,
      announceSwitch: async () => (n++ === 0 ? gate : true),
    });
    const first = u.instruct({ version: "0.9.0", stepBack: true });
    expect(await u.instruct({ version: "0.9.0", stepBack: true })).toEqual({
      kind: "retry_later",
    });
    release(false);
    expect(await first).toEqual({ kind: "retry_later" });
    expect(exit).not.toHaveBeenCalled();
    await u.tick();
    expect(exit).toHaveBeenCalledWith(1);
    expect(currentVersion(home)).toBe("0.9.0");
  });

  it("a running version that is not x.y.z never runs the updater, and never throws", async () => {
    const { home } = world();
    let scheduled = 0;
    const exit = vi.fn();
    const u = ups(home, {
      running: "unknown-1700000000000",
      exit,
      every: () => {
        scheduled++;
        return () => {};
      },
    });
    u.start();
    expect(scheduled).toBe(0);
    expect(await u.instruct({ version: "1.1.0" })).toEqual({
      kind: "disabled",
    });
    await expect(u.tick()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("installVersion with arm:false leaves update.json unarmed", () => {
    const home = tmp();
    installVersion(home, "1.0.0", () => {}, { arm: false });
    expect(readState(home).armed).toBe(false);
    installVersion(home, "1.1.0", () => {});
    expect(readState(home).armed).toBe(true);
  });
});

describe("the instance's install_now and announced switches (#2552)", () => {
  const build = (
    over: {
      login?: () => boolean;
      announce?: () => boolean | Promise<boolean>;
    } = {},
  ) => {
    const { home, fill } = world();
    const exit = vi.fn();
    let clock = T;
    const f2 = (v: string) => ({
      rel: { version: v } as FetchedRelease,
      ver: {
        version: v,
        sha512: "x",
        commit: "c",
        entries: [
          { path: "package", type: "dir", data: Buffer.alloc(0) },
          { path: "package/dist", type: "dir", data: Buffer.alloc(0) },
          {
            path: "package/dist/index.js",
            type: "file",
            data: Buffer.from(`// ${v}`),
          },
        ],
        packageJson: { name: "n", version: v, oaBus: { settingsKinds: ["a"] } },
      } as VerifiedRelease,
    });
    const rel = f2("1.1.0");
    const calls: string[] = [];
    const u = new Updater({
      home,
      running: "1.0.0",
      enabled: true,
      now: () => clock,
      busy: () => ({ pending: 1, outbox: 0, codexQueue: 0 }),
      loginActive: over.login ?? (() => false),
      hubReady: () => true,
      announceSwitch: async (from, to) => {
        calls.push(`${from}>${to}@${currentVersion(home)}`);
        return (await over.announce?.()) ?? true;
      },
      serverVersion: () => undefined,
      exit,
      log: () => {},
      fetch: async () => rel.rel,
      verify: () => rel.ver,
    });
    return {
      home,
      fill,
      u,
      exit,
      calls,
      advance: (ms: number) => (clock += ms),
    };
  };

  it("install_now swaps the staged version the instance named, announcing first", async () => {
    const w = build();
    await w.u.instructFromInstance("1.1.0");
    expect(readPolicy(w.home).staged?.version).toBe("1.1.0");
    expect(await w.u.installNowFromInstance()).toMatchObject({
      kind: "switching",
    });
    // The announcement came before bin moved.
    expect(w.calls).toEqual(["1.0.0>1.1.0@1.0.0"]);
    expect(currentVersion(w.home)).toBe("1.1.0");
    expect(w.exit).toHaveBeenCalledWith(1);
  });

  it("install_now without a named staged version does nothing", async () => {
    const w = build();
    expect(await w.u.installNowFromInstance()).toMatchObject({
      reason: "nothing_staged",
    });
    // Staged by an instruction the instance has not named through the instance path.
    await w.u.instruct({ version: "1.1.0" });
    expect(await w.u.installNowFromInstance()).toMatchObject({
      reason: "nothing_staged",
    });
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("install_now honors off, a login, the 6 h limit and a held switch", async () => {
    const off = build();
    await off.u.instructFromInstance("1.1.0");
    const j = JSON.parse(readFileSync(join(off.home, "update.json"), "utf8"));
    writeFileSync(
      join(off.home, "update.json"),
      JSON.stringify({ ...j, off: true }),
    );
    expect(await off.u.installNowFromInstance()).toMatchObject({
      reason: "off",
    });

    let login = true;
    const l = build({ login: () => login });
    await l.u.instructFromInstance("1.1.0");
    expect(await l.u.installNowFromInstance()).toMatchObject({
      reason: "login_in_progress",
    });
    login = false;

    const r = build();
    await r.u.instructFromInstance("1.1.0");
    recordAttempt(r.home, T);
    expect(await r.u.installNowFromInstance()).toMatchObject({
      reason: "rate_limited",
    });

    const held = build({ announce: () => false });
    await held.u.instructFromInstance("1.1.0");
    expect(await held.u.installNowFromInstance()).toEqual({
      kind: "retry_later",
    });
    expect(currentVersion(held.home)).toBe("1.0.0");
    expect(readPolicy(held.home).pending).toBeUndefined();
  });

  it("`off` set while the hub's answer is awaited stops the swap", async () => {
    let home = "";
    const w = build({
      announce: () => {
        const j = JSON.parse(readFileSync(join(home, "update.json"), "utf8"));
        writeFileSync(
          join(home, "update.json"),
          JSON.stringify({ ...j, off: true }),
        );
        return true;
      },
    });
    home = w.home;
    await w.u.instructFromInstance("1.1.0");
    expect(await w.u.installNowFromInstance()).toEqual({
      kind: "retry_later",
    });
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(readPolicy(w.home).pending).toBeUndefined();
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("backing out after the hub's ack queues a report that goes out as held (#2719)", async () => {
    let home = "";
    const w = build({
      announce: () => {
        const j = JSON.parse(readFileSync(join(home, "update.json"), "utf8"));
        writeFileSync(
          join(home, "update.json"),
          JSON.stringify({ ...j, off: true }),
        );
        return true;
      },
    });
    home = w.home;
    await w.u.instructFromInstance("1.1.0");
    expect(await w.u.installNowFromInstance()).toEqual({
      kind: "retry_later",
    });
    expect(readReports(home)).toEqual([
      expect.objectContaining({
        event: "ready_24h",
        from: "1.0.0",
        to: "1.1.0",
      }),
    ]);
  });

  it("a second switch while one awaits the hub gets retry_later; one swap only", async () => {
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((r) => {
      release = r;
    });
    let n = 0;
    const w = build({ announce: () => (n++ === 0 ? gate : true) });
    await w.u.instructFromInstance("1.1.0");
    const first = w.u.installNowFromInstance();
    expect(await w.u.installNowFromInstance()).toEqual({
      kind: "retry_later",
    });
    release(true);
    expect(await first).toMatchObject({ kind: "switching" });
    expect(w.exit).toHaveBeenCalledTimes(1);
    expect(n).toBe(1);
  });

  it("naming the running version is no instruction; naming the kept previous is a step back", async () => {
    const w = build();
    expect(await w.u.instructFromInstance("1.0.0")).toEqual({
      kind: "disabled",
    });
    expect(await w.u.instructFromInstance("0.9.0")).toMatchObject({
      kind: "switching",
    });
    expect(currentVersion(w.home)).toBe("0.9.0");
  });

  it("a not_forward instruction is reported once per version, like the others", async () => {
    const w = build();
    for (let i = 0; i < 3; i++) await w.u.instructFromInstance("0.5.0");
    await w.u.instructFromInstance("0.6.0");
    await w.u.instructFromInstance("0.6.0");
    expect(readReports(w.home).map((r) => [r.event, r.to, r.reason])).toEqual([
      ["refused", "0.5.0", "not_forward"],
      ["refused", "0.6.0", "not_forward"],
    ]);
    // Ahead of the server and malformed ones are once too.
    const u2 = new Updater({
      home: w.home,
      running: "1.0.0",
      enabled: true,
      now: () => T,
      busy: () => ({ pending: 0, outbox: 0, codexQueue: 0 }),
      loginActive: () => false,
      hubReady: () => true,
      announceSwitch: async () => true,
      serverVersion: () => "1.0.0",
      exit: () => {},
      log: () => {},
    });
    for (let i = 0; i < 3; i++) {
      await u2.instructFromInstance("2.0.0");
      await u2.instructFromInstance("1.2");
    }
    expect(
      readReports(w.home)
        .slice(2)
        .map((r) => [r.to, r.reason]),
    ).toEqual([
      ["2.0.0", "ahead_of_server"],
      ["", "bad_instruction"],
    ]);
  });
});
