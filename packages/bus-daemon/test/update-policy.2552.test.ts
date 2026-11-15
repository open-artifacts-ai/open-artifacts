import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accept,
  compareVersions,
  emptyPolicy,
  installNow,
  isBusy,
  label,
  MAX_LIST,
  markFailed,
  markNotified,
  markRefused,
  type PolicyState,
  QUIET_MS,
  QuietTracker,
  READY_AFTER_MS,
  readPolicy,
  readyDue,
  recordAttempt,
  refusedBackoff,
  SIX_HOURS_MS,
  setOff,
  setStaged,
  updateCommand,
  writePolicy,
  writeState,
} from "../src/index.ts";

const T = 1_000_000_000_000;
const st = (o: Partial<PolicyState> = {}): PolicyState => ({
  ...emptyPolicy(),
  armed: true,
  newestRun: "1.5.0",
  current: "1.5.0",
  previous: "1.4.0",
  ...o,
});
const ok = { ok: true };
const no = (reason: string) => ({ ok: false, reason });

describe("accept", () => {
  const rows: [
    string,
    Partial<PolicyState>,
    Parameters<typeof accept>[1],
    number,
    string | undefined,
    unknown,
  ][] = [
    ["forward", {}, { version: "1.6.0" }, T, undefined, ok],
    ["downgrade", {}, { version: "1.3.0" }, T, undefined, no("not_forward")],
    ["equal", {}, { version: "1.5.0" }, T, undefined, no("not_forward")],
    [
      "previous without step-back",
      {},
      { version: "1.4.0" },
      T,
      undefined,
      no("not_forward"),
    ],
    [
      "previous with step-back",
      {},
      { version: "1.4.0", stepBack: true },
      T,
      undefined,
      ok,
    ],
    [
      "step-back to a non-previous",
      {},
      { version: "1.3.0", stepBack: true },
      T,
      undefined,
      no("not_forward"),
    ],
    [
      "failed version",
      { failed: ["1.6.0"] },
      { version: "1.6.0" },
      T,
      undefined,
      no("failed"),
    ],
    [
      "failed previous step-back",
      { failed: ["1.4.0"] },
      { version: "1.4.0", stepBack: true },
      T,
      undefined,
      no("failed"),
    ],
    [
      "newestRun beyond current",
      { newestRun: "1.7.0" },
      { version: "1.6.0" },
      T,
      undefined,
      no("not_forward"),
    ],
    [
      "newer than server",
      {},
      { version: "1.6.0" },
      T,
      "1.5.5",
      no("ahead_of_server"),
    ],
    ["equal to server", {}, { version: "1.6.0" }, T, "1.6.0", ok],
    ["server unknown", {}, { version: "1.6.0" }, T, undefined, ok],
    ["server garbage ignored", {}, { version: "1.6.0" }, T, "latest", ok],
    [
      "rate limited",
      { lastAt: T - 1000 },
      { version: "1.6.0" },
      T,
      undefined,
      no("rate_limited"),
    ],
    [
      "just past 6 h",
      { lastAt: T - SIX_HOURS_MS },
      { version: "1.6.0" },
      T,
      undefined,
      ok,
    ],
    [
      "clock rolled back",
      { lastAt: T + 5 * 3600_000 },
      { version: "1.6.0" },
      T,
      undefined,
      no("rate_limited"),
    ],
    [
      "step-back ignores the 6 h limit",
      { lastAt: T - 1000 },
      { version: "1.4.0", stepBack: true },
      T,
      undefined,
      ok,
    ],
    [
      "step-back with clock rolled back",
      { lastAt: T + 5 * 3600_000 },
      { version: "1.4.0", stepBack: true },
      T,
      undefined,
      ok,
    ],
    ["off", { off: true }, { version: "1.6.0" }, T, undefined, no("off")],
    [
      "no history",
      { newestRun: undefined, current: undefined },
      { version: "0.0.1" },
      T,
      undefined,
      ok,
    ],
    ...[
      "1.2",
      "1.2.3-x",
      "01.2.3",
      "1.2.3 ",
      "١.٢.٣",
      "1.2.3.4",
      "",
      "v1.2.3",
      "1e3.0.0",
    ].map(
      (
        v,
      ): [
        string,
        Partial<PolicyState>,
        { version: string },
        number,
        undefined,
        unknown,
      ] => [
        `bad version ${JSON.stringify(v)}`,
        {},
        { version: v },
        T,
        undefined,
        no("bad_version"),
      ],
    ),
  ];
  it.each(rows)("%s", (_n, over, i, now, server, want) => {
    expect(accept(st(over), i, now, server ? { server } : {})).toEqual(want);
  });

  it("compares numerically, not as strings", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(() => compareVersions("1.2", "1.2.3")).toThrow();
  });
});

describe("quiet", () => {
  it("needs 30 s of continuous idle", () => {
    const q = new QuietTracker();
    q.observe(T, false, false);
    expect(q.quiet(T + QUIET_MS - 1)).toBe(false);
    expect(q.quiet(T + QUIET_MS)).toBe(true);
  });
  it("a busy blip restarts the wait", () => {
    const q = new QuietTracker();
    q.observe(T, false, false);
    q.observe(T + 20_000, true, false);
    q.observe(T + 21_000, false, false);
    expect(q.quiet(T + 21_000 + QUIET_MS - 1)).toBe(false);
    expect(q.quiet(T + 21_000 + QUIET_MS)).toBe(true);
  });
  it("login or approval blocks and restarts", () => {
    const q = new QuietTracker();
    q.observe(T, false, false);
    q.observe(T + 40_000, false, true);
    expect(q.quiet(T + 40_000)).toBe(false);
    q.observe(T + 41_000, false, false);
    expect(q.quiet(T + 50_000)).toBe(false);
    expect(q.quiet(T + 41_000 + QUIET_MS)).toBe(true);
  });
  it("never quiet before the first observation", () => {
    expect(new QuietTracker().quiet(T + 10 * QUIET_MS)).toBe(false);
  });
  it("busy over pending, outbox and codex queue", () => {
    expect(isBusy({ pending: 0, outbox: 0, codexQueue: 0 })).toBe(false);
    expect(isBusy({ pending: 1, outbox: 0, codexQueue: 0 })).toBe(true);
    expect(isBusy({ pending: 0, outbox: 1, codexQueue: 0 })).toBe(true);
    expect(isBusy({ pending: 0, outbox: 0, codexQueue: 1 })).toBe(true);
  });
  it("24 h without a swap: ready, once per version", () => {
    const home = mkdtempSync(join(tmpdir(), "oa-pol-"));
    setStaged(home, "1.6.0", T);
    let s = readPolicy(home);
    expect(readyDue(s, T + READY_AFTER_MS - 1)).toBe(false);
    expect(label(s, T + 1000)).toBe("Updating soon");
    expect(readyDue(s, T + READY_AFTER_MS)).toBe(true);
    expect(label(s, T + READY_AFTER_MS)).toBe("Update ready");
    expect(markNotified(home, "1.6.0", "ready")).toBe(true);
    s = readPolicy(home);
    expect(readyDue(s, T + 2 * READY_AFTER_MS)).toBe(false);
    expect(markNotified(home, "1.6.0", "ready")).toBe(false);
    expect(label(s, T + 2 * READY_AFTER_MS)).toBe("Update ready");
    // a new version notifies again
    setStaged(home, "1.7.0", T + 3 * READY_AFTER_MS);
    s = readPolicy(home);
    expect(readyDue(s, T + 4 * READY_AFTER_MS)).toBe(true);
  });
  it("clock rolled back does not make it ready", () => {
    const s = st({ staged: { version: "1.6.0", readySince: T } });
    expect(readyDue(s, T - READY_AFTER_MS)).toBe(false);
  });
  it("Up to date and Update needs you", () => {
    expect(label(st(), T)).toBe("Up to date");
    expect(label(st({ needsYou: true }), T)).toBe("Update needs you");
  });
});

describe("install now and oa-bus update", () => {
  const staged = { version: "1.6.0", readySince: T };
  it("install now skips only the quiet wait", () => {
    expect(installNow(st({ staged }), T, false)).toEqual(ok);
    expect(installNow(st(), T, false)).toEqual(no("nothing_staged"));
    expect(installNow(st({ staged }), T, true)).toEqual(
      no("login_in_progress"),
    );
    expect(installNow(st({ staged, off: true }), T, false)).toEqual(no("off"));
    expect(installNow(st({ staged, failed: ["1.6.0"] }), T, false)).toEqual(
      no("failed"),
    );
    expect(installNow(st({ staged, lastAt: T - 1000 }), T, false)).toEqual(
      no("rate_limited"),
    );
    expect(installNow(st({ staged, lastAt: T + 1000 }), T, false)).toEqual(
      no("rate_limited"),
    );
  });
  const tty = { stdinTTY: true, stdoutTTY: true };
  it("oa-bus update", () => {
    expect(updateCommand(st({ staged }), tty)).toEqual(ok);
    // may pass the 6 h limit
    expect(updateCommand(st({ staged, lastAt: T - 1000 }), tty)).toEqual(ok);
    expect(updateCommand(st({ staged }), { ...tty, stdinTTY: false })).toEqual(
      no("not_a_terminal"),
    );
    expect(updateCommand(st({ staged }), { ...tty, stdoutTTY: false })).toEqual(
      no("not_a_terminal"),
    );
    expect(updateCommand(st(), tty)).toEqual(no("nothing_staged"));
    expect(updateCommand(st({ staged, off: true }), tty)).toEqual(no("off"));
    expect(updateCommand(st({ staged, failed: ["1.6.0"] }), tty)).toEqual(
      no("failed"),
    );
    expect(updateCommand(st({ staged, armed: false }), tty)).toEqual(
      no("not_armed"),
    );
    expect(updateCommand(st({ staged, unreadable: true }), tty)).toEqual(
      no("unreadable"),
    );
  });
});

describe("state file", () => {
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), "oa-pol-"));
    mkdirSync(h, { recursive: true });
    return h;
  };
  it("off persists across a restart and is 0600", () => {
    const h = home();
    setOff(h, true);
    expect(readPolicy(h).off).toBe(true);
    expect(statSync(join(h, "update.json")).mode & 0o777).toBe(0o600);
    setOff(h, false);
    expect(readPolicy(h).off).toBe(false);
  });
  it("layout writes keep off, failed and the rest", () => {
    const h = home();
    setOff(h, true);
    markFailed(h, "1.6.0");
    writeState(h, { armed: true, current: "1.5.0", previous: "1.4.0" });
    const s = readPolicy(h);
    expect(s.off).toBe(true);
    expect(s.failed).toEqual(["1.6.0"]);
    expect(s.current).toBe("1.5.0");
  });
  it("policy writes keep the layout keys", () => {
    const h = home();
    writeState(h, { armed: true, current: "1.5.0", previous: "1.4.0" });
    recordAttempt(h, T);
    const j = JSON.parse(readFileSync(join(h, "update.json"), "utf8"));
    expect(j).toMatchObject({
      armed: true,
      current: "1.5.0",
      previous: "1.4.0",
      lastAt: T,
    });
  });
  it("lastAt never moves backward", () => {
    const h = home();
    recordAttempt(h, T);
    recordAttempt(h, T - 99999);
    expect(readPolicy(h).lastAt).toBe(T);
  });
  it("a failed version is remembered, un-staged, and refused", () => {
    const h = home();
    writeState(h, { armed: true });
    setStaged(h, "1.6.0", T);
    markFailed(h, "1.6.0");
    const s = readPolicy(h);
    expect(s.staged).toBeUndefined();
    expect(accept(s, { version: "1.6.0" }, T)).toEqual(no("failed"));
  });
  it("junk in the file is ignored", () => {
    const h = home();
    writeFileSync(
      join(h, "update.json"),
      JSON.stringify({
        off: "yes",
        failed: ["../x", "1.2.3", 7],
        lastAt: "now",
        staged: { version: "bad" },
        notified: { "../x": ["ready"] },
      }),
    );
    const s = readPolicy(h);
    expect(s.off).toBe(false);
    expect(s.failed).toEqual(["1.2.3"]);
    expect(s.lastAt).toBeUndefined();
    expect(s.staged).toBeUndefined();
    expect(s.notified).toEqual({});
  });
  it("nothing from the instance can clear off: accept never writes, and only the CLI imports setOff", () => {
    const h = home();
    writeState(h, { armed: true });
    setOff(h, true);
    accept(
      readPolicy(h),
      { version: "9.9.9", stepBack: true, off: false } as never,
      T,
    );
    expect(readPolicy(h).off).toBe(true);
    writePolicy(h, readPolicy(h));
    expect(readPolicy(h).off).toBe(true);
    const root = new URL("../../", import.meta.url).pathname;
    const users: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (
            e.name !== "node_modules" &&
            e.name !== "test" &&
            e.name !== "dist"
          )
            walk(p);
        } else if (
          p.endsWith(".ts") &&
          /\bsetOff\b/.test(readFileSync(p, "utf8"))
        )
          users.push(p.slice(root.length));
      }
    };
    walk(root);
    expect(users.sort()).toEqual([
      "bus-cli/src/commands/auto-update.ts",
      "bus-daemon/src/update/state.ts",
    ]);
  });
  it("update/ never reads process.env", () => {
    const dir = new URL("../src/update/", import.meta.url).pathname;
    for (const f of readdirSync(dir))
      expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/process\.env/);
  });
});

describe("review fixes", () => {
  const home = () => mkdtempSync(join(tmpdir(), "oa-pol-"));
  const file = (h: string) => join(h, "update.json");

  it("the running version is in the floor even with no file", () => {
    const h = home();
    const s = readPolicy(h);
    expect(
      accept({ ...s, armed: true }, { version: "1.4.0" }, T, {
        running: "1.5.0",
      }),
    ).toEqual(no("not_forward"));
    expect(
      accept({ ...s, armed: true }, { version: "1.5.0" }, T, {
        running: "1.5.0",
      }),
    ).toEqual(no("not_forward"));
    expect(
      accept({ ...s, armed: true }, { version: "1.5.1" }, T, {
        running: "1.5.0",
      }),
    ).toEqual(ok);
  });

  it.each([
    ["missing", undefined],
    ["partial: no armed", { newestRun: "1.5.0" }],
    ["armed false", { armed: false }],
    ["armed as a string", { armed: "true" }],
  ])("%s file: no updates", (_n, body) => {
    const h = home();
    if (body) writeFileSync(file(h), JSON.stringify(body));
    const s = readPolicy(h);
    expect(s.unreadable).toBe(false);
    expect(accept(s, { version: "9.0.0" }, T)).toEqual(no("not_armed"));
  });

  it.each([
    ["corrupt", "{not json"],
    ["truncated", '{"armed": tru'],
    ["an array", "[]"],
    ["null", "null"],
    ["empty", ""],
  ])("%s file: no updates, Update needs you, never overwritten", (_n, text) => {
    const h = home();
    writeFileSync(file(h), text);
    const s = readPolicy(h);
    expect(s.unreadable).toBe(true);
    expect(accept(s, { version: "9.0.0" }, T)).toEqual(no("unreadable"));
    expect(label(s, T)).toBe("Update needs you");
    expect(() => recordAttempt(h, T)).toThrow(/unreadable/);
    expect(readFileSync(file(h), "utf8")).toBe(text);
  });

  it("an unreadable path (a directory) is unreadable, not missing", () => {
    const h = home();
    mkdirSync(file(h));
    expect(readPolicy(h).unreadable).toBe(true);
  });

  it("a stale state object cannot clear off (daemon write racing the CLI)", () => {
    const h = home();
    writeState(h, { armed: true });
    const stale = readPolicy(h); // the daemon read it: off is false
    setOff(h, true); // the person runs `oa-bus auto-update off`
    stale.lastAt = T;
    writePolicy(h, stale); // the daemon writes its stale copy
    const s = readPolicy(h);
    expect(s.off).toBe(true);
    expect(s.lastAt).toBe(T);
    expect(s.armed).toBe(true);
    // a stale copy claiming off:true cannot set it either
    setOff(h, false);
    writePolicy(h, { ...stale, off: true, introShown: true, armed: false });
    const r = readPolicy(h);
    expect(r.off).toBe(false);
    expect(r.introShown).toBe(false);
    expect(r.armed).toBe(true);
  });

  it("failed to start is never retried; refused is retried after a growing backoff", () => {
    const h = home();
    writeState(h, { armed: true });
    markFailed(h, "1.6.0");
    markRefused(h, "1.7.0", T);
    const s = readPolicy(h);
    const D = 24 * 3600_000;
    expect(accept(s, { version: "1.6.0" }, T + 400 * D)).toEqual(no("failed"));
    expect(accept(s, { version: "1.7.0" }, T + D - 1)).toEqual(
      no("refused_backoff"),
    );
    expect(accept(s, { version: "1.7.0" }, T + D)).toEqual(ok);
    expect(accept(s, { version: "1.7.0" }, T - 5 * D)).toEqual(
      no("refused_backoff"),
    );
    // second refusal: 48 h
    markRefused(h, "1.7.0", T + D);
    const s2 = readPolicy(h);
    expect(accept(s2, { version: "1.7.0" }, T + 3 * D - 1)).toEqual(
      no("refused_backoff"),
    );
    expect(accept(s2, { version: "1.7.0" }, T + 3 * D)).toEqual(ok);
    expect([1, 2, 3, 4, 5, 6, 9, 50].map((n) => refusedBackoff(n) / D)).toEqual(
      [1, 2, 4, 7, 7, 7, 7, 7],
    );
  });

  it("lists are capped at the last 20", () => {
    const h = home();
    writeState(h, { armed: true });
    for (let i = 0; i < 30; i++) {
      markFailed(h, `1.${i}.0`);
      markRefused(h, `2.${i}.0`, T);
      markNotified(h, `3.${i}.0`, "ready");
    }
    const s = readPolicy(h);
    expect(s.failed).toHaveLength(MAX_LIST);
    expect(s.failed.at(-1)).toBe("1.29.0");
    expect(s.failed[0]).toBe("1.10.0");
    expect(Object.keys(s.refused)).toHaveLength(MAX_LIST);
    expect(Object.keys(s.notified)).toHaveLength(MAX_LIST);
    // a hand-edited long file is trimmed on read
    writeFileSync(
      file(h),
      JSON.stringify({
        armed: true,
        failed: Array.from({ length: 50 }, (_, i) => `1.${i}.0`),
      }),
    );
    expect(readPolicy(h).failed).toHaveLength(MAX_LIST);
  });
});
