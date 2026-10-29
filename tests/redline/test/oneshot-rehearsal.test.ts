import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeIdp, startFakeIdp } from "../src/fake-idp/server.ts";
import { adminCreds, readBody, withCred } from "../src/http.ts";
import { type LocalPair, startLocalPair } from "../src/local-pair.ts";
import {
  type Armed,
  armCallback,
  CALLBACK_PATH,
  type Chrome,
  launchChrome,
  liveChromes,
} from "../src/oneshot/chrome.ts";
import {
  cleanupSync,
  EXIT,
  type Human,
  loopbackHttp,
  type OneShotDeps,
  oneShot,
} from "../src/oneshot/driver.ts";
import { DEFAULT_EXPECT_SHA } from "../src/oneshot/suite.ts";
import type { Report } from "../src/report.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// The no-human rehearsal of the ONE-SHOT capture: the command's own code path
// (src/oneshot/driver.ts: prerequisites, the frozen-suite binding, the
// preflight, the Chrome CaptureIO, the dry run, the suite with --gate) with
// real Google Chrome launched, attached and intercepted exactly as on
// staging, against the local pair, a local auth broker and a fake Google
// (src/fake-idp). The test types each account and password into the fake
// Google's form over CDP, standing in for the person. Rehearsal-only flags:
// --headless (Chrome's only difference), --loopback (the pair's https
// origins answered over loopback http by the interceptor), --idp, --flows,
// --prompt-timeout-ms. Slow (wrangler dev x3, a frozen checkout install), so
// it runs only with REDLINE_REHEARSAL=1.
const on = process.env.REDLINE_REHEARSAL === "1";

const CLIENT = "oa-redline-broker-local.apps.googleusercontent.com";
const USERS = ["alice@oa-redline-a.fyi", "dave@oa-redline-c.fyi"];
const REPO = join(import.meta.dirname, "..", "..", "..");
const PKG = join(import.meta.dirname, "..");
const CLI = join(PKG, "scripts", "capture-oneshot.ts");

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits (bounded) until `pid` is gone; Chrome's group was SIGKILLed already. */
async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
/** The listening addresses of a TCP port (lsof). */
const listeners = (port: number) =>
  execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));

describe.skipIf(!on)(
  "one-shot rehearsal: the one command on real Chrome",
  () => {
    let idp: FakeIdp;
    let pair: LocalPair;
    let T: Targets;
    let suite: string;
    let work: string;
    let targetsFile: string;
    const redirectUris: string[] = [];
    /** Every Chrome the driver launched, and what became of it. */
    const chromes: { pid: number; port: number; profile: string }[] = [];

    beforeAll(async () => {
      work = mkdtempSync(join(tmpdir(), "oa-oneshot-rehearsal-"));
      // The frozen suite checkout, at the commit the gate is bound to.
      suite = join(work, "suite");
      execFileSync(
        "git",
        ["worktree", "add", "--detach", suite, DEFAULT_EXPECT_SHA],
        { cwd: REPO, stdio: "ignore", timeout: 120_000 },
      );
      execFileSync(
        "pnpm",
        ["install", "--frozen-lockfile", "--prefer-offline"],
        {
          cwd: suite,
          stdio: "ignore",
          timeout: 300_000,
          env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
        },
      );
      execFileSync("pnpm", ["--filter", "@oa/provision", "build"], {
        cwd: suite,
        stdio: "ignore",
        timeout: 300_000,
      });
      idp = await startFakeIdp({
        clients: {
          [CLIENT]: { secret: "fake-broker-secret-0123456789", redirectUris },
        },
        users: USERS,
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
      targetsFile = join(work, "targets.json");
      writeFileSync(targetsFile, pair.targets, { mode: 0o600 });
      // The one-time admin step: alice and dave invited.
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
        expect(res.status, await readBody(res)).toBe(201);
      }
    }, 600_000);

    afterAll(async () => {
      // A test that failed mid-prompt leaves its Chrome: stop it (ours, by PID).
      const leaked = liveChromes().length;
      cleanupSync();
      const left = pair ? await pair.stop() : [];
      await idp?.stop();
      if (suite && existsSync(suite))
        execFileSync("git", ["worktree", "remove", "--force", suite], {
          cwd: REPO,
          stdio: "ignore",
          timeout: 60_000,
        });
      if (work) rmSync(work, { recursive: true, force: true });
      expect(left).toEqual([]);
      expect(leaked, "Chromes still open at the end").toBe(0);
      // Nothing the driver launched outlives it.
      for (const c of chromes) {
        expect(await gone(c.pid), `chrome ${c.pid}`).toBe(true);
        expect(existsSync(c.profile), c.profile).toBe(false);
      }
    }, 180_000);

    const base = () => [
      "--suite",
      suite,
      "--targets",
      targetsFile,
      "--idp",
      idp.origin,
      "--loopback",
      "--headless",
    ];

    /** The person, at the fake Google's form: types the account and a password over CDP. */
    const types =
      (seen?: Human[]) =>
      async (h: Human): Promise<void> => {
        seen?.push(h);
        // The person's eyes and hands: the TEST's own CDP session on the
        // sign-in tab (the driver's session there never uses Runtime).
        let t: ReturnType<typeof setTimeout> | undefined;
        const page = await Promise.race([
          h.armed.landed.then(() => "landed" as const),
          // Google blocked the window: the person sees no form to type into.
          h.armed.blocked.then(() => "blocked" as const),
          new Promise<never>((_, rej) => {
            t = setTimeout(
              () => rej(new Error("the sign-in page never arrived")),
              60_000,
            );
          }),
        ]).finally(() => clearTimeout(t));
        if (page === "blocked") return;
        const tab = h.armed.signIn;
        if (!tab) throw new Error("no sign-in tab");
        const { sessionId } = await h.chrome.cdp.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: tab.targetId, flatten: true },
        );
        humanSessions.add(sessionId);
        const ev = (expression: string) =>
          h.chrome.cdp.send(
            "Runtime.evaluate",
            { expression, awaitPromise: true },
            sessionId,
          );
        await ev(
          "new Promise((r) => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', () => r(0)) : r(0))",
        );
        await ev("document.getElementById('identifier').focus()");
        await h.chrome.cdp.send(
          "Input.insertText",
          { text: h.prompt.user },
          sessionId,
        );
        await ev("document.getElementById('password').focus()");
        await h.chrome.cdp.send(
          "Input.insertText",
          { text: "test-password" },
          sessionId,
        );
        void ev("document.getElementById('next').click()").catch(() => 0);
      };
    /** The test's own sessions (the stand-in person), never the driver's. */
    const humanSessions = new Set<string>();
    /**
     * What the DRIVER sent: browser-level methods (no session) and, on a
     * page, only the throwaway tab's session. Anything on another session
     * would be the driver touching the sign-in tab.
     */
    const driverSends = (h: Human) => {
      const mine = h.chrome.cdp.sent.filter(
        (s) => !s.sessionId || !humanSessions.has(s.sessionId),
      );
      return {
        browser: [
          ...new Set(mine.filter((s) => !s.sessionId).map((s) => s.method)),
        ].sort(),
        pages: [
          ...new Set(
            mine.filter((s) => s.sessionId).map((s) => s.sessionId as string),
          ),
        ],
        throwaway: [
          ...new Set(
            mine
              .filter((s) => s.sessionId === h.armed.throwawaySessionId)
              .map((s) => s.method),
          ),
        ].sort(),
      };
    };

    function deps(o: Partial<OneShotDeps> = {}) {
      const out: string[] = [];
      const report = join(work, `report-${chromes.length}-${Date.now()}.json`);
      const d: OneShotDeps = {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          REDLINE_REPORT: report,
        },
        out: (l) => {
          out.push(l);
          console.log(l);
        },
        key: async () => "",
        question: async () => null,
        onChrome: (c) =>
          chromes.push({ pid: c.pid, port: c.port, profile: c.profile }),
        ...o,
      };
      return { d, out, report };
    }

    /** The CLI as a child (exit paths, signals), with its own TMPDIR. */
    function cli(args: string[], tmp: string) {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", CLI, ...args],
        {
          cwd: PKG,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            TMPDIR: tmp,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      const waiters: { re: RegExp; res: () => void }[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (s: string) => {
        out += s;
        process.stdout.write(s);
        for (const w of waiters.splice(0))
          if (w.re.test(out)) w.res();
          else waiters.push(w);
      });
      child.stderr.resume();
      const exit = new Promise<number | null>((r) =>
        child.on("exit", (c, sig) => r(c ?? (sig ? 128 : null))),
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
      void exit.then(() => clearTimeout(timer));
      return {
        child,
        exit,
        out: () => out,
        until: (re: RegExp) =>
          new Promise<void>((res) => {
            if (re.test(out)) res();
            else waiters.push({ re, res });
          }),
      };
    }

    it("the binding refuses another commit and a dirty tree (before any window)", async () => {
      const tmp = mkdtempSync(join(work, "tmp-"));
      const wrong = cli(
        [...base(), "--flows", "a-alice", "--expect-sha", "0".repeat(40)],
        tmp,
      );
      expect(await wrong.exit).toBe(EXIT.refused);
      expect(wrong.out()).toMatch(
        new RegExp(
          `is at ${DEFAULT_EXPECT_SHA.slice(0, 12)}, not 000000000000`,
        ),
      );
      const stray = join(suite, "tests", "redline", "live", "stray.test.ts");
      writeFileSync(stray, "// not in the frozen commit\n");
      try {
        const dirty = cli([...base(), "--flows", "a-alice"], tmp);
        expect(await dirty.exit).toBe(EXIT.refused);
        expect(dirty.out()).toMatch(/has local changes \(1 paths\)/);
      } finally {
        rmSync(stray);
      }
      expect(readdirSync(tmp)).toEqual([]);
    }, 120_000);

    it("real Chrome: CDP on 127.0.0.1 only; only this host's callback with this state is captured, once, and never reaches the install", async () => {
      const c = await launchChrome({ headless: true });
      chromes.push({ pid: c.pid, port: c.port, profile: c.profile });
      try {
        const addrs = listeners(c.port);
        expect(addrs.length).toBeGreaterThan(0);
        for (const a of addrs) expect(a).toBe(`127.0.0.1:${c.port}`);
        const httpsA = T.a.app.replace(/^http:/, "https:");
        const httpsB = T.b.app.replace(/^http:/, "https:");
        const state = "rehearsal-state-0123456789abcdef";
        const armed = await armCallback(
          c,
          { origin: httpsA, state },
          {
            idp: idp.origin,
            proxy: { pattern: "https://*.localhost*", map: loopbackHttp },
          },
        );
        // navigator.webdriver, read in the throwaway tab only.
        await armed.checkWebdriver();
        await armed.probe();
        expect(armed.counts.probes).toBe(1);
        /** A new tab straight at a callback URL; resolves with the verdict on THAT request. */
        const go = async (origin: string, s: string) => {
          const u = new URL(CALLBACK_PATH, origin);
          u.searchParams.set("state", s);
          u.searchParams.set("code", "4/0junk");
          const v = armed.verdictOf(u.href);
          await c.cdp.send("Target.createTarget", { url: u.href });
          return v;
        };
        // Another install's callback carrying this state: passed on, not captured.
        expect(await go(httpsB, state)).toBe("pass");
        // This install's r1. retry: passed on, not captured.
        expect(await go(httpsA, `r1.${state}`)).toBe("pass");
        // Another state at this install: passed on.
        expect(await go(httpsA, "another-state")).toBe("pass");
        expect(armed.counts.captured).toBe(0);
        // This install, this state: captured and failed in the browser.
        expect(await go(httpsA, state)).toBe("capture");
        expect(armed.counts.captured).toBe(1);
        const got = new URL(await armed.captured);
        expect(got.origin).toBe(httpsA);
        expect(got.searchParams.get("state")).toBe(state);
        // Again: failed again (a code is never spent by the browser), the
        // capture stays the first.
        expect(await go(httpsA, state)).toBe("capture");
        expect(armed.counts.captured).toBe(2);
      } finally {
        const { pid, profile } = c;
        await c.close();
        expect(await gone(pid)).toBe(true);
        expect(existsSync(profile)).toBe(false);
      }
    }, 120_000);

    it("dry run: all 5 prompts up to the sign-in page; hd present except b-alice; interception armed; nothing redeemed", async () => {
      const before = chromes.length;
      const chooserBefore = idp.events.filter((e) => e.at === "chooser").length;
      const tokensBefore = idp.events.filter((e) => e.at === "token").length;
      const { d, out } = deps();
      const code = await oneShot([...base(), "--dry-run"], d);
      expect(code).toBe(EXIT.ok);
      const lines = out.filter((l) => l.startsWith("dry run ["));
      expect(lines).toHaveLength(5);
      for (const [flow, hd] of [
        ["a-alice", "hd oa-redline-a.fyi"],
        ["b-alice", "hd absent, as it must be"],
        ["a-alice-replay", "hd oa-redline-a.fyi"],
        ["b-dave", "hd oa-redline-c.fyi"],
        ["b-dave-2", "hd oa-redline-c.fyi"],
      ] as const) {
        const l = lines.find((x) => x.includes(`] ${flow} at `));
        expect(l, flow).toContain(`ok (${hd}; interception armed`);
        expect(l, flow).toContain("navigator.webdriver false");
      }
      expect(out.at(-1)).toMatch(/^Dry run green: all 5 prompts/);
      expect(chromes.length - before).toBe(5);
      expect(
        idp.events.filter((e) => e.at === "chooser").length - chooserBefore,
      ).toBe(5);
      expect(idp.events.filter((e) => e.at === "token").length).toBe(
        tokensBefore,
      );
      for (const c of chromes.slice(before)) {
        expect(isAlive(c.pid) && !(await gone(c.pid))).toBe(false);
        expect(existsSync(c.profile)).toBe(false);
      }
    }, 300_000);

    it("the one command: 5 prompts captured from real Chrome, each profile fresh, no retry, then the suite with --gate passes both ID-token cases", async () => {
      const before = chromes.length;
      const seen: Human[] = [];
      const ev0 = idp.events.length;
      const { d, out, report } = deps({ human: types(seen) });
      const code = await oneShot(base(), d);
      console.log(`one-shot exit code: ${code}`);
      const run = idp.events.slice(ev0);
      // One fresh Chrome per prompt, each closed with its profile removed.
      expect(chromes.length - before).toBe(5);
      expect(new Set(chromes.slice(before).map((c) => c.profile)).size).toBe(5);
      expect(new Set(chromes.slice(before).map((c) => c.port)).size).toBe(5);
      for (const c of chromes.slice(before)) {
        expect(await gone(c.pid)).toBe(true);
        expect(existsSync(c.profile)).toBe(false);
      }
      // Each prompt: one callback captured, armed for its own install.
      expect(seen.map((h) => [h.prompt.flow, h.armed.counts.captured])).toEqual(
        [
          ["a-alice", 1],
          ["b-alice", 1],
          ["a-alice-replay", 1],
          ["b-dave", 1],
          ["b-dave-2", 1],
        ],
      );
      // Each capture was a redirect hop: the broker's 302 target, caught at
      // the Request stage.
      expect(seen.map((h) => h.armed.counts.viaRedirect)).toEqual([
        1, 1, 1, 1, 1,
      ]);
      // The driver never held a session on the sign-in tab: its only page
      // session is the throwaway tab's (webdriver check and probe); the
      // rest is Target and Fetch on the browser session.
      for (const h of seen) {
        const s = driverSends(h);
        expect(s.pages).toEqual([h.armed.throwawaySessionId]);
        expect(s.throwaway).toEqual(["Runtime.evaluate"]);
        for (const m of s.browser) expect(m).toMatch(/^(Target|Fetch)\./);
      }
      console.log(
        `driver CDP methods: browser session ${driverSends(seen[0] as Human).browser.join(", ")}; throwaway tab ${driverSends(seen[0] as Human).throwaway.join(", ")}; sign-in tab none`,
      );
      for (const h of seen)
        expect(h.armed.origin).toBe(
          (h.prompt.install === T.a.name ? T.a : T.b).app.replace(
            /^http:/,
            "https:",
          ),
        );
      // No retry: the install never got the first callback, so the browser
      // never came back to Google: exactly one chooser visit per prompt.
      const choosers = run.filter((e) => e.at === "chooser");
      expect(choosers).toHaveLength(5);
      // Fresh profiles: no prompt arrived with a Google session, so alice's
      // never reached dave's prompts.
      expect(choosers.map((e) => e.session)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(out.filter((l) => /captured, \d of 5\./.test(l))).toHaveLength(5);
      expect(
        out.filter((l) => /^\[\d\/5\] rl-[ab]: sign in as /.test(l)),
      ).toHaveLength(5);
      // No URL, code or state is ever printed.
      for (const l of out) expect(l).not.toMatch(/[?&](code|state|bstate)=/);
      // The legs all passed when redeemed (the frozen capture's verdicts).
      expect(
        out.filter((l) => /: (pass|fail)/.test(l) && / \(rl-[ab]\): /.test(l)),
      ).toEqual([
        "  a-alice: A's credential at A (rl-a): pass",
        "  b-alice: A's credential at B (rl-b): pass",
        "  a-alice-replay: A's credential at B (rl-b): pass",
        "  a-alice-replay: A's credential at A (rl-a): pass",
        "  b-dave: B's own credential at B (rl-b): pass",
        "  b-dave-2: B's own credential at B (rl-b): pass",
      ]);
      // The suite ran from the frozen checkout with --gate and took the verdicts.
      expect(out).toContain(
        "Captures done. The live suite runs now (with --gate).",
      );
      const r = JSON.parse(readFileSync(report, "utf8")) as Report;
      const idCases = r.cases.filter((c) =>
        c.name.startsWith("sign-in: ID tokens > "),
      );
      expect(idCases).toHaveLength(2);
      for (const c of idCases)
        expect(c).toMatchObject({
          level: "pass",
          label: expect.stringMatching(
            /^fake IdP \(local\); redeemed by capture run /,
          ),
        });
      const levels: Record<string, number> = {};
      for (const c of r.cases) levels[c.level] = (levels[c.level] ?? 0) + 1;
      console.log(
        `suite (frozen checkout, --gate): ${JSON.stringify(levels)}; exit ${code}`,
      );

      // The control: within ONE profile the fake Google's session does
      // persist, so the nulls above are the fresh profiles' doing.
      const c = await launchChrome({ headless: true });
      chromes.push({ pid: c.pid, port: c.port, profile: c.profile });
      try {
        const armed = await armCallback(
          c,
          {
            origin: T.a.app.replace(/^http:/, "https:"),
            state: "control-state",
          },
          {
            idp: idp.origin,
            proxy: { pattern: "https://*.localhost*", map: loopbackHttp },
          },
        );
        const u = new URL((seen[0] as Human).url);
        u.searchParams.set("as", "alice@oa-redline-a.fyi");
        const n = idp.events.length;
        // Signed in as alice in this profile (the IdP's 302 sets its session)...
        await c.cdp.send("Target.createTarget", { url: u.href });
        await armed.untilJudged(1);
        u.searchParams.delete("as");
        // ...so the chooser, opened again in the SAME profile, sees her.
        await c.cdp.send("Target.createTarget", { url: u.href });
        await armed.landed;
        expect(
          idp.events
            .slice(n)
            .filter((e) => e.at === "chooser")
            .map((e) => e.session),
        ).toContain("alice@oa-redline-a.fyi");
      } finally {
        await c.close();
      }
    }, 600_000);

    it("a prompt that times out names the prompt, the user and the key; r retries it", async () => {
      const before = chromes.length;
      const seen: Human[] = [];
      let launches = 0;
      const keys: string[] = [];
      const { d, out } = deps({
        async human(h) {
          launches++;
          // The first window: the person never signs in.
          if (launches > 1) await types(seen)(h);
        },
        key: async () => {
          keys.push("r");
          return "r";
        },
        // The suite isn't under test here: stop it at once (our own child).
        onSuite: (pid) => process.kill(pid, "SIGTERM"),
      });
      await oneShot(
        [...base(), "--flows", "a-alice", "--prompt-timeout-ms", "4000"],
        d,
      );
      expect(out).toContain("[1/1] No sign-in came back within 4 s.");
      expect(out).toContain(
        "  Redo prompt 1 of 1: sign in as alice@oa-redline-a.fyi at rl-a. Press r to retry it (Ctrl-C stops).",
      );
      expect(keys).toEqual(["r"]);
      expect(launches).toBe(2);
      expect(chromes.length - before).toBe(2);
      expect(out.filter((l) => /captured, 1 of 1\./.test(l))).toHaveLength(1);
      expect(out).toContain("  a-alice: A's credential at A (rl-a): pass");
      expect(out.join("\n")).not.toMatch(/capture_timeout|sent no code/);
      for (const c of chromes.slice(before)) {
        expect(await gone(c.pid)).toBe(true);
        expect(existsSync(c.profile)).toBe(false);
      }
    }, 300_000);

    it("Google's block page stops the run once, with the plain message", async () => {
      const before = chromes.length;
      idp.block = true;
      try {
        const { d, out } = deps({ human: types() });
        const code = await oneShot([...base(), "--flows", "a-alice"], d);
        expect(code).toBe(EXIT.googleBlocked);
        const all = out.join("\n");
        expect(all).toMatch(
          /Stopped at prompt 1 of 1 \(rl-a, alice@oa-redline-a\.fyi\): Google's block page \(\/v3\/signin\/rejected\)\./,
        );
        expect(all).toMatch(
          /This is Google refusing to sign in from the browser this script started .*not a red-line test failure\. Nothing was retried and nothing was redeemed\./,
        );
        expect(all).not.toMatch(/captured, /);
        // No silent retry: one window.
        expect(chromes.length - before).toBe(1);
        for (const c of chromes.slice(before)) {
          expect(await gone(c.pid)).toBe(true);
          expect(existsSync(c.profile)).toBe(false);
        }
      } finally {
        idp.block = false;
      }
    }, 300_000);

    it("Ctrl-C mid-prompt: Chrome exits and its profile and the verdicts dir are gone", async () => {
      const tmp = mkdtempSync(join(work, "tmp-"));
      const run = cli([...base(), "--flows", "a-alice"], tmp);
      await run.until(/\[1\/1\] rl-a: sign in as alice@oa-redline-a\.fyi/);
      const profiles = readdirSync(tmp).filter((f) =>
        f.startsWith("oa-capture-chrome-"),
      );
      expect(profiles).toHaveLength(1);
      expect(
        readdirSync(tmp).some((f) => f.startsWith("oa-redline-signin-")),
      ).toBe(true);
      const profile = join(tmp, profiles[0] as string);
      const pids = execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        timeout: 10_000,
      })
        .split("\n")
        .filter((l) => l.includes(`--user-data-dir=${profile}`))
        .map((l) => Number(l.trim().split(/\s+/)[0]));
      expect(pids.length).toBeGreaterThan(0);
      run.child.kill("SIGINT");
      expect(await run.exit).toBe(130);
      for (const p of pids) expect(await gone(p), `chrome ${p}`).toBe(true);
      expect(existsSync(profile)).toBe(false);
      // Left: only the suite's hook pacing ledgers (src/http.ts, by design
      // shared across runs). No profile, verdicts or playwright dir.
      expect(
        readdirSync(tmp).filter(
          (f) => !/^oa-redline-hooks-[0-9a-f]+\.json$/.test(f),
        ),
      ).toEqual([]);
      console.log(
        `SIGINT: exit 130; chrome pids ${pids.join(" ")} gone; profile and verdicts dir removed`,
      );
    }, 300_000);
  },
);
