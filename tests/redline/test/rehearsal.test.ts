import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CaptureIO, runCaptures } from "../src/capture.ts";
import { FakeBrowser, loopbackHttp } from "../src/fake-idp/browser.ts";
import { type FakeIdp, startFakeIdp } from "../src/fake-idp/server.ts";
import { adminCreds, readBody, withCred } from "../src/http.ts";
import {
  groupMembers,
  type LocalPair,
  startLocalPair,
} from "../src/local-pair.ts";
import { fileChecks, gaps, networkChecks } from "../src/preflight.ts";
import type { Report } from "../src/report.ts";
import {
  CALLBACK_GOOGLE,
  CAPTURE_FLOWS,
  type FlowName,
} from "../src/signin.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// The no-human rehearsal of the real-tenant sign-in step: the capture's real
// code path (src/capture.ts, src/preflight.ts, the live suite's ID-token
// cases) end to end on the local pair, with a local auth broker and a fake
// Google (src/fake-idp). A fake browser plays the human: it opens the URL the
// capture offers, picks the named account, and its DevTools log holds the
// cookieless first callback and the install's r1. retry. Slow (wrangler dev
// x3), so it runs only with REDLINE_LOCAL_SMOKE=1 or REDLINE_REHEARSAL=1.
const on =
  process.env.REDLINE_LOCAL_SMOKE === "1" ||
  process.env.REDLINE_REHEARSAL === "1";

const CLIENT = "oa-redline-broker-local.apps.googleusercontent.com";
const USERS = ["alice@oa-redline-a.fyi", "dave@oa-redline-c.fyi"];
/** Codes die this long after issue; the simulated human takes HUMAN_MS per prompt. */
const CODE_TTL_MS = 30_000;
const HUMAN_MS = 20_000;

/** The live suite's ID-token cases, run as a child (bounded, own process group). */
function runSuite(env: Record<string, string>): Promise<Report> {
  const pkg = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "oa-redline-rehearsal-report-"));
  const report = join(dir, "report.json");
  const child = spawn(
    join(pkg, "node_modules", ".bin", "vitest"),
    [
      "run",
      "-c",
      "vitest.live.config.ts",
      "live/signin.test.ts",
      "-t",
      "sign-in: ID tokens",
    ],
    {
      cwd: pkg,
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        REDLINE_REPORT: report,
        REDLINE_GATE: "0",
        ...env,
      },
    },
  );
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(kill, 240_000);
  return new Promise<Report>((res, rej) => {
    child.on("exit", () => {
      clearTimeout(timer);
      if (child.pid && groupMembers(child.pid).length) kill();
      try {
        res(JSON.parse(readFileSync(report, "utf8")) as Report);
      } catch (e) {
        rej(e);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

describe.skipIf(!on)(
  "no-human rehearsal: capture -> suite on a fake IdP",
  () => {
    let idp: FakeIdp;
    let pair: LocalPair;
    let T: Targets;
    const redirectUris: string[] = [];
    const capDirs: string[] = [];
    const capDir = () => {
      const d = mkdtempSync(join(tmpdir(), "oa-redline-rehearsal-"));
      chmodSync(d, 0o700);
      capDirs.push(d);
      return d;
    };

    beforeAll(async () => {
      idp = await startFakeIdp({
        clients: {
          [CLIENT]: { secret: "fake-broker-secret-0123456789", redirectUris },
        },
        users: USERS,
        codeTtlMs: CODE_TTL_MS,
      });
      pair = await startLocalPair({
        idp: {
          origin: idp.origin,
          publicJwk: idp.publicJwk,
          clientId: CLIENT,
          clientSecret: "fake-broker-secret-0123456789",
          tenants: ["oa-redline-a.fyi", "oa-redline-c.fyi"],
          redirectUris,
        },
      });
      T = await loadTargets({ REDLINE_TARGETS: pair.targets });
    }, 300_000);

    afterAll(async () => {
      for (const d of capDirs) rmSync(d, { recursive: true, force: true });
      const left = pair ? await pair.stop() : [];
      await idp?.stop();
      expect(left).toEqual([]);
    }, 120_000);

    const preflightOpts = () => ({ idp: idp.origin, map: loopbackHttp });

    it("preflight names each gap (users not invited), then is green once they are", async () => {
      // Local mode: no PAT, Turnstile, inventory or strayHost files to check.
      expect(fileChecks({ REDLINE_TARGETS: pair.targets })).toEqual([]);
      const before = gaps(await networkChecks(T, preflightOpts()));
      expect(before.map((g) => g.name).sort()).toEqual([
        `${T.a.name} alice@oa-redline-a.fyi`,
        `${T.b.name} dave@oa-redline-c.fyi`,
      ]);
      // Invite them (admin PAT), as the one-time admin step does on staging.
      for (const [t, email] of [
        [T.a, "alice@oa-redline-a.fyi"],
        [T.b, "dave@oa-redline-c.fyi"],
      ] as const) {
        const { pat } = await adminCreds(t);
        const res = await fetch(
          `${t.app}/api/v1/members`,
          withCred(pat, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-oa-request": "1",
            },
            body: JSON.stringify({ email, role: "member" }),
          }),
        );
        const text = await readBody(res);
        expect(res.status, text).toBe(201);
      }
      const after = await networkChecks(T, preflightOpts());
      expect(gaps(after)).toEqual([]);
      // Every check ran: versions, Google on, TEST_DOMAIN, users, broker.
      expect(after.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          `${T.a.name} version`,
          `${T.b.name} Google sign-in`,
          `${T.a.name} TEST_DOMAIN`,
          `${T.b.name} broker`,
        ]),
      );
      expect(
        after.find((c) => c.name === `${T.a.name} broker`)?.detail,
      ).toMatch(/reachable/);
    }, 120_000);

    /** The human: a fresh (Incognito) browser per prompt, signing in as the named user. */
    function human(o: { delayMs: number; expireOn?: FlowName }) {
      let browser: FakeBrowser | null = null;
      const seen: Record<string, { first: URL; retry?: URL; offered: URL }> =
        {};
      let pastes = 0;
      const asked = new Set<string>();
      const said: string[] = [];
      const io: CaptureIO = {
        async offer(url, p) {
          browser = new FakeBrowser({ idp: idp.origin, map: loopbackHttp });
          await browser.open(url, p.user);
          const [first, retry] = browser.callbacks;
          if (!first) throw new Error(`${p.flow}: no callback in the browser`);
          seen[p.flow] = { first, ...(retry ? { retry } : {}), offered: url };
        },
        async ask(p) {
          pastes++;
          const s = seen[p.flow];
          if (!s) throw new Error("ask before offer");
          // The human's pace (once per prompt); the expiry case waits past
          // the code's life.
          if (!asked.has(p.flow))
            idp.advance(
              p.flow === o.expireOn ? CODE_TTL_MS + 1_000 : o.delayMs,
            );
          asked.add(p.flow);
          // Prompt 1's first paste is the newest request, the r1. retry: refused.
          if (pastes === 1 && s.retry) return s.retry.toString();
          return s.first.toString();
        },
        say: (l) => said.push(l),
      };
      return { io, seen, said };
    }

    it("captures all 5 with per-prompt redeem under a 30 s code expiry, and the suite passes both ID-token cases", async () => {
      const dir = capDir();
      const h = human({ delayMs: HUMAN_MS });
      const v = await runCaptures(T, dir, h.io, {
        idp: idp.origin,
        map: loopbackHttp,
      });

      // The browser's first callback was cookieless and refused (retry), then
      // the install's own r1. flow; the capture took the first, refused the r1.
      for (const [flow, s] of Object.entries(h.seen)) {
        expect(s.first.pathname, flow).toBe(CALLBACK_GOOGLE);
        expect(s.first.searchParams.get("state")?.startsWith("r1."), flow).toBe(
          false,
        );
        expect(s.first.searchParams.get("bstate"), flow).toBeTruthy();
      }
      expect(h.seen["a-alice"]?.retry?.searchParams.get("state")).toMatch(
        /^r1\./,
      );
      expect(h.said.join("\n")).toMatch(
        /a-alice: that's the browser's retry callback/,
      );
      // hd: the foreign flow's URL dropped it, the others kept the tenant's.
      expect(h.seen["b-alice"]?.offered.searchParams.has("hd")).toBe(false);
      expect(h.seen["b-dave"]?.offered.searchParams.get("hd")).toBe(
        "oa-redline-c.fyi",
      );
      // With the hint kept, tenant A's alice can't sign in at B at all: the
      // browser's own retry (hd=C) was refused at the IdP.
      expect(idp.events).toContainEqual({
        at: "authorize",
        ok: false,
        why: "account_outside_hd",
      });
      expect(
        h.said.filter((l) => /captured, \d of 5\. Time left/.test(l)),
      ).toHaveLength(5);

      // Every leg passed when redeemed, though 5 x 20 s of human pace means a
      // batched redeem at the end would have found the early codes expired.
      expect(v.legs.map((l) => [l.flow, l.leg, l.verdict])).toEqual([
        ["a-alice", "A's credential at A", "pass"],
        ["b-alice", "A's credential at B", "pass"],
        ["a-alice-replay", "A's credential at B", "pass"],
        ["a-alice-replay", "A's credential at A", "pass"],
        ["b-dave", "B's own credential at B", "pass"],
        ["b-dave-2", "B's own credential at B", "pass"],
      ]);
      expect(Object.keys(h.seen)).toEqual(Object.keys(CAPTURE_FLOWS));
      // Bound to this pair: its install ids and /healthz versions.
      expect(v.installs).toEqual({ a: T.a.installId, b: T.b.installId });
      expect(v.versions.a).not.toBe("unknown");
      expect(v.versions.b).toBe(v.versions.a);

      const r = await runSuite({
        REDLINE_TARGETS: pair.targets,
        REDLINE_SIGNIN_CAPTURES: dir,
      });
      const level = (n: string) =>
        r.cases.find((c) => c.name === `sign-in: ID tokens > ${n}`);
      expect(
        level("an ID token with hd of A at B's callback: no session"),
      ).toMatchObject({ level: "pass" });
      expect(level("A's code and broker state at B: no session")).toMatchObject(
        {
          level: "pass",
        },
      );
    }, 300_000);

    it("an expired code (a delayed redeem) is a fail with its reason, never a pass", async () => {
      const dir = capDir();
      const h = human({ delayMs: 1_000, expireOn: "a-alice" });
      const v = await runCaptures(T, dir, h.io, {
        idp: idp.origin,
        map: loopbackHttp,
        flows: ["a-alice", "b-alice", "b-dave"],
      });
      expect(idp.events).toContainEqual({
        at: "token",
        ok: false,
        why: "code_expired",
      });
      const a = v.legs.find((l) => l.flow === "a-alice");
      expect(a).toMatchObject({ verdict: "fail", leg: "A's credential at A" });
      expect(a?.reason).toMatch(
        /^A's credential at A \(rl-a; expected signed in \(302 with a session cookie\)\): A's credential failed at A \(status 302, .*; to \/sign-in\?error=failed\)$/,
      );

      const r = await runSuite({
        REDLINE_TARGETS: pair.targets,
        REDLINE_SIGNIN_CAPTURES: dir,
      });
      const hd = r.cases.find(
        (c) =>
          c.name ===
          "sign-in: ID tokens > an ID token with hd of A at B's callback: no session",
      );
      expect(hd).toMatchObject({
        level: "fail",
        leg: "A's credential at A",
        host: "rl-a",
      });
      expect(hd?.reason).toMatch(
        /^\[a-alice\] A's credential at A \(rl-a; .*error=failed/,
      );
      // The aud case's flows weren't captured: unproven with the reason.
      expect(
        r.cases.find(
          (c) =>
            c.name ===
            "sign-in: ID tokens > A's code and broker state at B: no session",
        ),
      ).toMatchObject({
        level: "unproven-live",
        reason: "unproven: not captured (a-alice-replay)",
      });
    }, 300_000);
  },
);
