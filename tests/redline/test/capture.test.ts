import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_LEGS,
  CAPTURE_MAX_AGE_MS,
  type Capture,
  checkCallback,
  decodeBrokerState,
  idTokenOutcome,
  type LegVerdict,
  redeemCapture,
  runCaptures,
  STAGE_UNAVAILABLE,
  type StartedFlow,
  signinStage,
  VERDICTS_FILE,
  type Verdicts,
} from "../src/capture.ts";
import {
  CALLBACK_GOOGLE,
  CAPTURE_FLOWS,
  type FlowName,
} from "../src/signin.ts";
import type { Target } from "../src/targets.ts";
import { type Fake, fakeServer } from "./fake.ts";

const t = (name: string, app: string): Target => ({
  name,
  installId: `${name}-id`,
  app,
  content: `https://${name}.content.test`,
  testDomain: `${name}.test`,
  cookieName: "__Host-oa_session",
  hookKeyFile: "/dev/null",
});
const A = t("rl-a", "https://rl-a.example.test");
const B = t("rl-b", "https://rl-b.example.test");

const bstateFor = (i: string, s: string, exp: number) =>
  `${Buffer.from(JSON.stringify({ i, s, h: "h", exp })).toString("base64url")}.SIG`;

const dirs: string[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) await f.close();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-redline-cap-"));
  dirs.push(d);
  return d;
};

describe("checkCallback (item 5: local checks after each capture)", () => {
  const now = 1_000_000_000_000;
  const started: StartedFlow = {
    flow: "a-alice",
    at: "a",
    state: "st-1",
    cookie: { name: "oa_oidc_x", value: "v" },
    startedAt: now - 60_000,
    broker: true,
  };
  const cb = (q: Record<string, string>, app = A.app) => {
    const u = new URL(`${app}${CALLBACK_GOOGLE}`);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  };
  const good = {
    state: "st-1",
    code: "4/0abc",
    bstate: bstateFor("rl-a-id", "st-1", now + 300_000),
  };

  it("takes this start's callback, with its expiry the earlier of code and broker state", () => {
    const r = checkCallback(A, started, cb(good), now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capture.query).toEqual(good);
      expect(r.capture.expiresAt).toBe(now + 300_000);
    }
  });

  it("names each problem without quoting the URL", () => {
    const why = (u: string, at = now) => {
      const r = checkCallback(A, started, u, at);
      expect(r.ok).toBe(false);
      const w = r.ok ? "" : r.why;
      expect(w).not.toContain("4/0abc");
      expect(w).not.toContain("st-1");
      return r;
    };
    expect(why("not a url")).toMatchObject({ why: /doesn't hold a URL/ });
    expect(why(cb(good, B.app))).toMatchObject({
      why: /isn't rl-a's callback/,
    });
    expect(why(cb({ ...good, state: "r1.zz" }))).toMatchObject({
      why: /retry callback \(state r1\.\)/,
    });
    expect(why(cb({ ...good, state: "other" }))).toMatchObject({
      why: /another sign-in start/,
    });
    expect(
      why(cb({ state: "st-1", error: "access_denied", bstate: good.bstate })),
    ).toMatchObject({ why: /error=access_denied/, restart: true });
    expect(
      why(cb({ ...good, bstate: bstateFor("rl-b-id", "st-1", now + 1e5) })),
    ).toMatchObject({ why: /names install rl-b-id, not rl-a/ });
    expect(why(cb({ ...good, bstate: "garbage" }))).toMatchObject({
      why: /broker state/,
    });
    expect(
      why(cb(good), started.startedAt + CAPTURE_MAX_AGE_MS + 1),
    ).toMatchObject({ why: /too old/, restart: true });
  });

  it("decodeBrokerState reads the payload only", () => {
    expect(decodeBrokerState(bstateFor("i", "s", 5))).toEqual({
      i: "i",
      s: "s",
      exp: 5,
    });
    expect(decodeBrokerState("x.y")).toBeNull();
  });
});

/**
 * A fake install: Google start (direct to Google, no broker) and a callback
 * that signs in, or refuses with /sign-in?error=<x>, by the code's prefix.
 */
async function fakeInstall(name: string) {
  let n = 0;
  const f = await fakeServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/auth/login/google") {
      n++;
      res
        .writeHead(302, {
          location: `https://accounts.google.com/o/oauth2/v2/auth?state=${name}-st-${n}&hd=${name}.fyi`,
          "set-cookie": `oa_oidc_${n}=cookie-${n}; Path=/; HttpOnly`,
        })
        .end();
      return;
    }
    if (u.pathname === CALLBACK_GOOGLE) {
      const code = u.searchParams.get("code") ?? "";
      const [verdict] = code.split(":");
      if (verdict === "ok")
        res
          .writeHead(302, {
            location: "/",
            "set-cookie": "oa_session=sess; Path=/",
          })
          .end();
      else
        res
          .writeHead(302, { location: `/sign-in?error=${verdict}&next=%2F` })
          .end();
      return;
    }
    res.writeHead(404).end();
  });
  fakes.push(f);
  return { ...t(name, f.origin), installId: `${name}-id` };
}

describe("redeemCapture (each capture redeemed right after its prompt)", () => {
  const cap = (flow: FlowName, code: string, at: "a" | "b"): Capture => ({
    flow,
    at,
    cookie: { name: "oa_oidc_1", value: "cookie-1" },
    query: { state: `${at}-st`, code },
    startedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
  });

  it("records a pass per leg with the leg functions' expectations", async () => {
    const T = { a: await fakeInstall("rl-a"), b: await fakeInstall("rl-b") };
    const v = await redeemCapture(T, cap("a-alice", "ok:1", "a"));
    expect(v).toMatchObject([
      {
        case: "hd",
        flow: "a-alice",
        leg: "A's credential at A",
        host: "rl-a",
        verdict: "pass",
      },
    ]);
    expect(v[0]?.expected).toMatch(/signed in/);
  });

  it("a code the IdP refused (expired) is a fail with a redacted reason, the leg, host and expected", async () => {
    const T = { a: await fakeInstall("rl-a"), b: await fakeInstall("rl-b") };
    // An expired code: the install's exchange fails, /sign-in?error=failed.
    const v = await redeemCapture(
      T,
      cap("b-alice", "failed:4/0AeanSexpiredcode0123456789", "b"),
    );
    expect(v).toHaveLength(1);
    const l = v[0] as LegVerdict;
    expect(l).toMatchObject({
      leg: "A's credential at B",
      host: "rl-b",
      verdict: "fail",
    });
    expect(l.expected).toMatch(/error=tenant/);
    expect(l.reason).toMatch(/A's credential at B \(rl-b; expected/);
    expect(l.reason).toMatch(/error=failed/);
    expect(l.reason).not.toMatch(/4\/0Aean|cookie-1|rl-b-st/);
  });

  it("the replay flow: refused at B on a fresh B start, then A's success, in that order", async () => {
    const T = { a: await fakeInstall("rl-a"), b: await fakeInstall("rl-b") };
    expect(CAPTURE_LEGS["a-alice-replay"].map((l) => l.leg)).toEqual([
      "A's credential at B",
      "A's credential at A",
    ]);
    // The fake refuses "failed:" codes everywhere: the refused leg passes,
    // A's own leg fails, so the case can't pass on a dead code.
    const v = await redeemCapture(T, cap("a-alice-replay", "failed:x", "a"));
    expect(v.map((l) => [l.leg, l.verdict])).toEqual([
      ["A's credential at B", "pass"],
      ["A's credential at A", "fail"],
    ]);
  });

  it("an error before any request (a fresh start that fails) is a fail with its reason", async () => {
    const T = {
      a: await fakeInstall("rl-a"),
      b: { ...B, app: "http://127.0.0.1:9" },
    };
    const v = await redeemCapture(T, cap("a-alice-replay", "ok:1", "a"));
    expect(v[0]).toMatchObject({ leg: "A's credential at B", verdict: "fail" });
    expect(v[0]?.reason).toMatch(/A's credential at B \(rl-b/);
  });
});

describe("idTokenOutcome (the suite reads the verdicts)", () => {
  const T = { a: A, b: B, mode: "staging" as const };
  const now = Date.now();
  const NONCE = "N".repeat(43);
  /** The capture script's suite child: its run flag and nonce. */
  const ENV = { REDLINE_CAPTURE_RUN: "1", REDLINE_CAPTURE_NONCE: NONCE };
  const out = (
    d: string | undefined,
    which: "hd" | "aud" = "hd",
    env: Record<string, string | undefined> = ENV,
    t: typeof T | (Omit<typeof T, "mode"> & { mode: "local" }) = T,
  ) => idTokenOutcome(d, t, which, now, env);
  const verdicts = (over: Partial<LegVerdict> = {}, flows?: FlowName[]) => {
    const legs: LegVerdict[] = [];
    for (const [flow, ls] of Object.entries(CAPTURE_LEGS))
      if (!flows || flows.includes(flow as FlowName))
        for (const l of ls)
          legs.push({
            case: l.case,
            flow: flow as FlowName,
            leg: l.leg,
            host: l.host === "a" ? "rl-a" : "rl-b",
            expected: "x",
            verdict: "pass",
            startedAt: now - 120_000,
            redeemedAt: now - 60_000,
            ...over,
          });
    const v: Verdicts = {
      v: 1,
      mode: "staging",
      runNonce: NONCE,
      installs: { a: A.installId, b: B.installId },
      versions: { a: "0.64.0", b: "0.64.0" },
      suiteSha: "a".repeat(40),
      startedAt: now - 11 * 60_000,
      finishedAt: now - 30_000,
      legs,
    };
    return v;
  };
  const dirWith = (v: unknown, mode = 0o600) => {
    const d = tmp();
    writeFileSync(join(d, VERDICTS_FILE), JSON.stringify(v), { mode });
    return d;
  };

  it("none without a directory; the happy path passes, labeled with the capture run", () => {
    expect(out(undefined)).toEqual({ kind: "none" });
    expect(out(dirWith(verdicts()))).toEqual({
      kind: "pass",
      label: "redeemed by capture run NNNNNN",
    });
  });

  it("refuses a forged or leftover verdicts file: no run flag, no nonce, a wrong nonce", () => {
    const d = dirWith(verdicts());
    const not = {
      kind: "unproven",
      reason: "verdicts not from this capture run",
    };
    // A hand-written file with the right public install ids, read by a suite
    // the capture script didn't start.
    expect(out(d, "hd", {})).toEqual(not);
    expect(out(d, "hd", { REDLINE_CAPTURE_RUN: "1" })).toEqual(not);
    expect(out(d, "hd", { REDLINE_CAPTURE_NONCE: NONCE })).toEqual(not);
    // A forged file without a nonce, even with the env set.
    const { runNonce: _drop, ...noNonce } = verdicts();
    expect(out(dirWith(noNonce))).toEqual(not);
    // A leftover dir from a killed run: its nonce isn't this run's.
    const leftover = dirWith({ ...verdicts(), runNonce: "L".repeat(43) });
    expect(out(leftover)).toEqual(not);
    expect(
      out(d, "hd", { ...ENV, REDLINE_CAPTURE_NONCE: "M".repeat(43) }),
    ).toEqual(not);
  });

  it("refuses impossible times: a redeem in the future, a start after its redeem, a run ending before it starts", () => {
    const un = (reason: string) => ({ kind: "unproven", reason });
    // A redeem in the future (the run's end in the past: a hand-edited file).
    expect(out(dirWith(verdicts({ redeemedAt: now + 60_000 })))).toEqual(
      un("capture redeemed in the future (a-alice)"),
    );
    // Within the 5 s skew is fine.
    expect(
      out(
        dirWith({
          ...verdicts({ redeemedAt: now + 4_000 }),
          finishedAt: now + 4_000,
        }),
      ).kind,
    ).toBe("pass");
    // A start after its redeem (a negative age), inside the run.
    expect(
      out(
        dirWith({
          ...verdicts({ startedAt: now - 1_000, redeemedAt: now - 2_000 }),
          finishedAt: now,
        }),
      ),
    ).toEqual(un("capture started after its redeem (a-alice)"));
    expect(
      out(dirWith({ ...verdicts(), finishedAt: now - 12 * 60_000 })),
    ).toEqual(un("capture run ends before it starts"));
    expect(out(dirWith({ ...verdicts(), finishedAt: now + 60_000 }))).toEqual(
      un("capture run ends in the future"),
    );
    // A leg outside its run's window.
    expect(
      out(
        dirWith({
          ...verdicts(),
          startedAt: now - 30_000 - 1,
          finishedAt: now,
        }),
      ),
    ).toEqual(un("capture outside its run (a-alice)"));
  });

  it("local verdicts: labeled fake IdP (local) in local mode, unproven against staging targets", () => {
    const local = { ...verdicts(), mode: "local" };
    expect(out(dirWith(local), "hd", ENV, { ...T, mode: "local" })).toEqual({
      kind: "pass",
      label: "fake IdP (local); redeemed by capture run NNNNNN",
    });
    expect(out(dirWith(local))).toEqual({
      kind: "unproven",
      reason: "capture verdicts are from local mode, this run is staging",
    });
  });

  it("capture-file problems are unproven with the reason, never a bare fail", () => {
    expect(out(tmp())).toMatchObject({
      kind: "unproven",
      reason: /no capture verdicts/,
    });
    expect(
      out(dirWith(verdicts({ startedAt: now - 11 * 60_000 }))),
    ).toMatchObject({
      kind: "unproven",
      reason: /^capture too old \(a-alice, 10m 0s\)$/,
    });
    expect(out(dirWith(verdicts({}, ["a-alice"])))).toMatchObject({
      kind: "unproven",
      reason: "not captured (b-alice)",
    });
    expect(
      out(dirWith({ ...verdicts(), installs: { a: "x", b: "y" } }), "aud"),
    ).toMatchObject({ kind: "unproven", reason: /other installs/ });
    expect(out(dirWith(verdicts(), 0o644))).toMatchObject({
      kind: "unproven",
      reason: /0600/,
    });
  });

  it("a failed leg fails the case with every failed leg's reason and the first leg's fields", () => {
    const v = verdicts();
    for (const l of v.legs)
      if (l.flow === "b-alice") {
        l.verdict = "fail";
        l.reason = "A's credential at B (rl-b; expected refused): not refused";
        l.actual = "status 302; to /";
      }
    const o = out(dirWith(v));
    expect(o.kind).toBe("fail");
    if (o.kind !== "fail") return;
    expect(o.error.message).toBe(
      "[b-alice] A's credential at B (rl-b; expected refused): not refused",
    );
    expect((o.error as { redline?: unknown }).redline).toEqual({
      leg: "A's credential at B",
      host: "rl-b",
      expected: "x",
      actual: "status 302; to /",
    });
    // The other case is unaffected.
    expect(out(dirWith(v), "aud").kind).toBe("pass");
  });
});

describe("runCaptures (the script's loop, driven programmatically)", () => {
  it("rejects the r1 retry paste, takes the first callback, redeems at once and writes 0600 verdicts", async () => {
    const T = {
      a: await fakeInstall("rl-a"),
      b: await fakeInstall("rl-b"),
      mode: "local" as const,
    };
    const dir = tmp();
    const said: string[] = [];
    const offered: URL[] = [];
    let asks = 0;
    const v = await runCaptures(
      T,
      dir,
      {
        offer: (u) => {
          offered.push(u);
        },
        ask: async (p) => {
          asks++;
          const target = T[CAPTURE_FLOWS[p.flow].at];
          const state = (offered.at(-1) as URL).searchParams.get("state");
          const cb = (st: string, code: string) =>
            `${target.app}${CALLBACK_GOOGLE}?state=${st}&code=${code}`;
          // First paste of the first prompt: the browser's r1 retry.
          if (asks === 1) return cb("r1.retry", "ok:r1");
          const want = p.flow === "b-alice" ? "tenant" : "ok";
          return cb(state as string, `${want}:${p.flow}`);
        },
        say: (l) => said.push(l),
      },
      { flows: ["a-alice", "b-alice"] },
    );
    expect(asks).toBe(3);
    // Bound to its run: nonce, install ids, versions, suite commit, times.
    expect(v.runNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(v.installs).toEqual({ a: T.a.installId, b: T.b.installId });
    expect(v.versions).toEqual({ a: "unknown", b: "unknown" });
    expect(v.suiteSha).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(v.finishedAt).toBeGreaterThanOrEqual(v.startedAt);
    for (const l of v.legs)
      expect(l.redeemedAt).toBeGreaterThanOrEqual(v.startedAt);
    expect(said.join("\n")).toMatch(/retry callback \(state r1\.\)/);
    expect(said.join("\n")).toMatch(
      /a-alice: captured, 1 of 2\. Time left before the first capture expires: \d+:\d\d/,
    );
    // The foreign flow drops the hd hint; the others keep it.
    expect(offered[0]?.searchParams.get("hd")).toBe("rl-a.fyi");
    expect(offered.at(-1)?.searchParams.has("hd")).toBe(false);
    expect(v.legs.map((l) => [l.flow, l.leg, l.verdict])).toEqual([
      ["a-alice", "A's credential at A", "pass"],
      ["b-alice", "A's credential at B", "pass"],
    ]);
    const f = join(dir, VERDICTS_FILE);
    expect(lstatSync(f).mode & 0o777).toBe(0o600);
    const text = readFileSync(f, "utf8");
    expect(text).not.toMatch(/cookie-|ok:|-st-/);
  });
});

describe("the install's own stage per leg (POST /__test/audit, test_hook.signin rows)", () => {
  const rows =
    (...events: unknown[]) =>
    async () => ({ events });
  const signin = (o: Record<string, unknown>) => ({
    action: "test_hook.signin",
    at: Date.now(),
    ...o,
  });

  it("formats the last signin row: outcome, stage, status", async () => {
    expect(
      await signinStage(
        A,
        0,
        rows(
          { action: "test_hook.session" },
          signin({ outcome: "ok", stage: "ok", provider: "google" }),
          signin({
            outcome: "refused",
            stage: "broker_http",
            status: 522,
            provider: "google",
            domain: "oa-redline-c.fyi",
          }),
        ),
      ),
    ).toBe("refused: stage broker_http status 522");
    // Fields nested under meta, no status.
    expect(
      await signinStage(
        A,
        0,
        rows({
          action: "test_hook.signin",
          meta: { outcome: "refused", stage: "tenant" },
        }),
      ),
    ).toBe("refused: stage tenant");
  });

  it("(stage unavailable) without the hook, the rows or a safe stage", async () => {
    const http404 = async (): Promise<unknown> => {
      throw new Error("hook 404");
    };
    expect(await signinStage(A, 0, http404)).toBe(STAGE_UNAVAILABLE);
    expect(await signinStage(A, 0, rows())).toBe(STAGE_UNAVAILABLE);
    expect(await signinStage(A, 0, async () => ({}))).toBe(STAGE_UNAVAILABLE);
    expect(
      await signinStage(A, 0, rows(signin({ stage: "alice@x.test" }))),
    ).toBe(STAGE_UNAVAILABLE);
  });

  it("each leg records it; a failed leg's reason carries it verbatim", async () => {
    const T = { a: await fakeInstall("rl-a"), b: await fakeInstall("rl-b") };
    const asked: [string, number][] = [];
    const v = await redeemCapture(
      T,
      {
        flow: "a-alice-replay",
        at: "a",
        cookie: { name: "oa_oidc_1", value: "cookie-1" },
        query: { state: "a-st", code: "failed:x" },
        startedAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
      },
      Date.now,
      async (t, since) => {
        asked.push([t.name, since]);
        return t.name === "rl-a"
          ? "refused: stage broker_http status 522"
          : STAGE_UNAVAILABLE;
      },
    );
    expect(asked.map(([n]) => n)).toEqual(["rl-b", "rl-a"]);
    expect(v[0]).toMatchObject({ verdict: "pass", stage: STAGE_UNAVAILABLE });
    expect(v[0]?.reason).toBeUndefined();
    expect(v[1]).toMatchObject({
      verdict: "fail",
      stage: "refused: stage broker_http status 522",
    });
    expect(v[1]?.reason).toMatch(
      /error=failed\) \[install: refused: stage broker_http status 522\]$/,
    );
  });
});
