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
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAKE_AUTHORIZE,
  type FakeIdp,
  startFakeIdp,
} from "../src/fake-idp/server.ts";
import { adminCreds, readBody, withCred } from "../src/http.ts";
import { type LocalPair, startLocalPair } from "../src/local-pair.ts";
import {
  armPrompt,
  CALLBACK_PATH,
  type Chrome,
  Listener,
  launchChrome,
  liveChromes,
  rehearsalArgs,
  writeExtension,
} from "../src/oneshot/browser.ts";
import {
  cleanupSync,
  EXIT,
  type Human,
  type OneShotDeps,
  oneShot,
} from "../src/oneshot/driver.ts";
import { DEFAULT_EXPECT_SHA } from "../src/oneshot/suite.ts";
import type { Report } from "../src/report.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// The no-human rehearsal of the ONE-SHOT capture: the command's own code
// path (src/oneshot/driver.ts: prerequisites, the frozen-suite binding, the
// preflight, plain Chrome on a temporary profile with the capture
// extension, the listener, the dry run, the suite with --gate) against the
// local pair, a local auth broker and a fake Google (src/fake-idp).
//
// The stand-in for the person is this test's HARNESS: through its own
// debugging connection (the rehearsal-only --rehearsal-harness flag starts
// the same installed Chrome headless with a debugging port), it does "Load
// unpacked" (CDP Extensions.loadUnpacked) and types into the fake Google's
// form. The script never connects to that port. Other rehearsal-only flags:
// --loopback (the extension's copy also redirects the pair's https origins
// to http), --idp, --flows, --prompt-timeout-ms. All are refused with
// staging targets.
//
// What it can't prove: the manual Load unpacked itself (its stand-in is the
// harness's loadUnpacked), real Google (account chooser, new-device
// checks, its automation detection, cookies on google.com), TLS, and the
// hosted dispatch Worker. Slow (wrangler dev x3, a frozen checkout
// install), so it runs only with REDLINE_REHEARSAL=1.
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
/** A bounded wait on a condition (Chrome's group was already signalled). */
async function until(f: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
const gone = (pid: number) => until(() => !isAlive(pid));
/** The listening addresses of a TCP port (lsof). */
const listeners = (port: number) =>
  execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));

/** The harness's own connection to a rehearsal Chrome (its debugging port). */
async function harness(profile: string): Promise<Browser> {
  const f = join(profile, "DevToolsActivePort");
  let lines: string[] = [];
  const ok = await until(() => {
    try {
      lines = readFileSync(f, "utf8").split("\n");
      return !!lines[1];
    } catch {
      return false;
    }
  }, 30_000);
  if (!ok) throw new Error("rehearsal Chrome opened no debugging port");
  return chromium.connectOverCDP(`http://127.0.0.1:${lines[0]}`);
}
/** The person's "Load unpacked", by the harness. */
async function loadUnpacked(b: Browser, dir: string): Promise<void> {
  const s = await b.newBrowserCDPSession();
  await (s.send as (m: string, p: object) => Promise<unknown>)(
    "Extensions.loadUnpacked",
    { path: dir },
  );
}
/** The first tab of the run whose URL passes `ok`. */
async function tabWhere(b: Browser, ok: (u: URL) => boolean): Promise<Page> {
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error("no browser context");
  const test = (p: Page) => {
    try {
      return ok(new URL(p.url()));
    } catch {
      return false;
    }
  };
  if (!(await until(() => ctx.pages().some(test), 30_000)))
    throw new Error("the prompt's tab never showed the IdP");
  return ctx.pages().find(test) as Page;
}

describe.skipIf(!on)(
  "one-shot rehearsal: plain Chrome, the capture extension, the one command",
  () => {
    let idp: FakeIdp;
    let pair: LocalPair;
    let T: Targets;
    let suite: string;
    let work: string;
    let targetsFile: string;
    const redirectUris: string[] = [];
    /** Every Chrome the driver launched. */
    const chromes: { pid: number; profile: string }[] = [];
    const browsers: Browser[] = [];

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
      for (const b of browsers) await b.close().catch(() => {});
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
      "--rehearsal-harness",
    ];
    const https = (app: string) => app.replace(/^http:/, "https:");

    /** In-process run state: the harness per Chrome, and what the person saw. */
    function deps(o: Partial<OneShotDeps> & { load?: boolean } = {}) {
      const out: string[] = [];
      const report = join(work, `report-${Date.now()}.json`);
      let ext = "";
      const harnesses = new Map<string, Promise<Browser>>();
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
        onListener: (_l, dir) => {
          ext = dir;
        },
        onChrome: (c) => {
          chromes.push({ pid: c.pid, profile: c.profile });
          // The person loads the extension (each start: the stand-in's
          // loadUnpacked doesn't persist across Chrome restarts).
          const b = harness(c.profile).then(async (br) => {
            browsers.push(br);
            if (o.load !== false) await loadUnpacked(br, ext);
            return br;
          });
          b.catch(() => {});
          harnesses.set(`${c.pid}`, b);
        },
        ...o,
      };
      const browserOf = (c: Chrome) =>
        harnesses.get(`${c.pid}`) as Promise<Browser>;
      return { d, out, report, browserOf };
    }

    /** The person at the fake Google: types the account and a password. */
    const types =
      (
        browserOf: (c: Chrome) => Promise<Browser>,
        seen?: Human[],
        log?: string[],
      ) =>
      async (h: Human): Promise<void> => {
        seen?.push(h);
        const b = await browserOf(h.chrome);
        const page = await tabWhere(
          b,
          (u) => u.origin === idp.origin && u.pathname === FAKE_AUTHORIZE,
        );
        // (a): the callback request, seen from the harness's side.
        page.on("requestfailed", (r) => {
          const u = new URL(r.url());
          if (u.pathname !== CALLBACK_PATH) return;
          const from = r.redirectedFrom();
          log?.push(
            `${h.prompt.flow}: ${u.origin} ${r.failure()?.errorText} via ${from ? new URL(from.url()).pathname : "none"}`,
          );
        });
        await page.waitForSelector("#identifier");
        await page.fill("#identifier", h.prompt.user);
        await page.fill("#password", "test-password");
        await page.click("#next", { noWaitAfter: true }).catch(() => {});
      };

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
    const chromePidsOf = (profile: string) =>
      execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        timeout: 10_000,
      })
        .split("\n")
        .filter((l) => l.includes(`--user-data-dir=${profile}`))
        .map((l) => Number(l.trim().split(/\s+/)[0]));

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

    it("(c) with the extension not loaded, the command waits with the plain message and never falls back; a wrong token changes nothing", async () => {
      const tmp = mkdtempSync(join(work, "tmp-"));
      const run = cli([...base(), "--flows", "a-alice"], tmp);
      await run.until(
        /Waiting for the extension to check in \(Ctrl-C stops\)\./,
      );
      const ext = /choose this folder: (\S+)/.exec(run.out())?.[1] as string;
      const cfg = readFileSync(join(ext, "config.js"), "utf8");
      const listener = /"listener":"([^"]+)"/.exec(cfg)?.[1] as string;
      // The listener is on 127.0.0.1 only.
      for (const a of listeners(Number(new URL(listener).port)))
        expect(a).toBe(`127.0.0.1:${new URL(listener).port}`);
      for (const path of ["/hello", "/next", "/blocked"]) {
        const r = await fetch(`${listener}${path}`, {
          method: "POST",
          body: JSON.stringify({ token: "not-this-run", url: "x" }),
        });
        expect(r.status, path).toBe(403);
      }
      // Still waiting: no prompt, no check-in, no other way forward.
      expect(run.out()).not.toMatch(/checked in|\[1\/1\]|sign in as/);
      const profile = join(
        tmp,
        readdirSync(tmp).find((f) =>
          f.startsWith("oa-redline-capture-"),
        ) as string,
        "profile",
      );
      const pids = chromePidsOf(profile);
      expect(pids.length).toBeGreaterThan(0);
      run.child.kill("SIGINT");
      expect(await run.exit).toBe(130);
      for (const p of pids) expect(await gone(p), `chrome ${p}`).toBe(true);
      expect(
        readdirSync(tmp).filter(
          (f) => !/^oa-redline-hooks-[0-9a-f]+\.json$/.test(f),
        ),
      ).toEqual([]);
    }, 180_000);

    it("real Chrome + extension: the DNR block reports only to this run's listener; only this host and state are captured; Google's cookies are cleared on command", async () => {
      const dir = mkdtempSync(join(work, "x-"));
      const L = new Listener();
      await L.start();
      const ext = join(dir, "extension");
      const httpsA = https(T.a.app);
      const httpsB = https(T.b.app);
      writeExtension(ext, {
        installs: [httpsA, httpsB],
        listener: L.origin,
        token: L.token,
        idp: idp.origin,
        clearOrigins: [idp.origin],
        loopback: true,
      });
      const c = launchChrome({
        profile: join(dir, "profile"),
        url: "chrome://extensions/",
        extra: rehearsalArgs(),
      });
      chromes.push({ pid: c.pid, profile: c.profile });
      try {
        const b = await harness(c.profile);
        browsers.push(b);
        await loadUnpacked(b, ext);
        await L.checkedIn;
        const state = "rehearsal-state-0123456789abcdef";
        const armed = armPrompt(
          L,
          { origin: httpsA, state },
          { idp: idp.origin },
        );
        const reported = (url: string) =>
          new Promise<"blocked" | "idp">((res) => {
            const off = L.on((r) => {
              if (r.url === url) {
                off();
                res(r.kind);
              }
            });
          });
        const ctx = b.contexts()[0];
        if (!ctx) throw new Error("no context");
        /** A new tab at a callback URL (the extension closes it once blocked). */
        const go = async (origin: string, s: string) => {
          const u = new URL(CALLBACK_PATH, origin);
          u.searchParams.set("state", s);
          u.searchParams.set("code", "4/0junk");
          const r = reported(u.href);
          const page = await ctx.newPage();
          const err = await page.goto(u.href).then(
            () => "loaded",
            (e: Error) =>
              /ERR_BLOCKED_BY_CLIENT/.test(e.message) ? "blocked" : "other",
          );
          return { kind: await r, err };
        };
        // Another install's callback carrying this state: blocked (the code
        // is never spent), reported, never captured.
        expect(await go(httpsB, state)).toEqual({
          kind: "blocked",
          err: "blocked",
        });
        // This install's r1. retry, and another state: blocked, not captured.
        expect(await go(httpsA, `r1.${state}`)).toEqual({
          kind: "blocked",
          err: "blocked",
        });
        expect(await go(httpsA, "another-state")).toEqual({
          kind: "blocked",
          err: "blocked",
        });
        expect(armed.counts).toEqual({ captured: 0, passed: 3, probes: 0 });
        // This install, this state: captured, once.
        expect(await go(httpsA, state)).toEqual({
          kind: "blocked",
          err: "blocked",
        });
        expect(armed.counts.captured).toBe(1);
        const got = new URL(await armed.captured);
        expect(got.origin).toBe(httpsA);
        expect(got.searchParams.get("state")).toBe(state);
        await go(httpsA, state);
        expect(armed.counts.captured).toBe(2);
        armed.off();

        // The IdP session cookie persists in this profile until the clear.
        const auth = new URL(FAKE_AUTHORIZE, idp.origin);
        const chooser = async () => {
          const n = idp.events.length;
          const p = await ctx.newPage();
          await p.goto(auth.href);
          await p.close();
          return idp.events
            .slice(n)
            .filter((e) => e.at === "chooser")
            .map((e) => e.session);
        };
        // A sign-in at the IdP (it answers its 302 with the session cookie;
        // the redirect target is junk, so the hop fails, that's fine).
        for (const [k, v] of Object.entries({
          client_id: CLIENT,
          redirect_uri: redirectUris[0] as string,
          response_type: "code",
          code_challenge: "x".repeat(43),
          code_challenge_method: "S256",
          nonce: "n",
          state: "s",
        }))
          auth.searchParams.set(k, v);
        const signIn = new URL(auth);
        signIn.searchParams.set("as", "alice@oa-redline-a.fyi");
        const p = await ctx.newPage();
        await p.goto(signIn.href).catch(() => null);
        await p.close();
        expect(await chooser()).toEqual(["alice@oa-redline-a.fyi"]);
        expect(await L.command({ cmd: "clear" })).toBe(true);
        expect(await chooser()).toEqual([null]);
      } finally {
        await c.close();
        await L.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);

    it("dry run: all 5 prompts up to the sign-in page; hd from the extension's report, absent only for b-alice; nothing redeemed", async () => {
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
        expect(l, flow).toContain(
          `ok (${hd}, from the URL the extension reported; interception armed`,
        );
      }
      expect(out.at(-1)).toMatch(/^Dry run green: all 5 prompts/);
      expect(
        idp.events.filter((e) => e.at === "chooser").length - chooserBefore,
      ).toBe(5);
      expect(idp.events.filter((e) => e.at === "token").length).toBe(
        tokensBefore,
      );
    }, 300_000);

    it("the one command: 5 prompts in one profile, (a) each callback blocked as the broker's 302 target and never delivered, (b) no IdP cookie on any prompt, then the suite with --gate passes both ID-token cases", async () => {
      const seen: Human[] = [];
      const hops: string[] = [];
      const ev0 = idp.events.length;
      const c0 = chromes.length;
      const r = deps();
      r.d.human = types(r.browserOf, seen, hops);
      const code = await oneShot(base(), r.d);
      console.log(`one-shot exit code: ${code}`);
      const run = idp.events.slice(ev0);
      // One Chrome, one profile, for the whole run; gone at the end.
      expect(chromes.length - c0).toBe(1);
      const c = chromes[c0] as { pid: number; profile: string };
      expect(await gone(c.pid)).toBe(true);
      expect(existsSync(c.profile)).toBe(false);
      // Each prompt captured exactly one callback for its own install.
      expect(seen.map((h) => [h.prompt.flow, h.armed.counts.captured])).toEqual(
        [
          ["a-alice", 1],
          ["b-alice", 1],
          ["a-alice-replay", 1],
          ["b-dave", 1],
          ["b-dave-2", 1],
        ],
      );
      // (a) The callback was the target of the broker's 302 (after the
      // IdP's 302 to the broker), blocked by the extension's DNR rule.
      expect(hops).toEqual(
        seen.map(
          (h) =>
            `${h.prompt.flow}: ${h.armed.origin} net::ERR_BLOCKED_BY_CLIENT via /google/callback`,
        ),
      );
      // ...and never delivered: the install would have answered a cookieless
      // callback with its own retry, a second visit to Google. Exactly one
      // chooser visit per prompt.
      const choosers = run.filter((e) => e.at === "chooser");
      expect(choosers).toHaveLength(5);
      // (b) Same profile throughout, yet the IdP saw no session cookie on any
      // prompt (prompts 2 to 5 follow a sign-in that set one): the
      // extension cleared it before each prompt.
      expect(choosers.map((e) => e.session)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(run.filter((e) => e.at === "authorize" && e.ok)).toHaveLength(5);
      expect(r.out.filter((l) => /captured, \d of 5\./.test(l))).toHaveLength(
        5,
      );
      expect(
        r.out.filter((l) => /^\[\d\/5\] rl-[ab]: sign in as /.test(l)),
      ).toHaveLength(5);
      expect(
        r.out.filter((l) => l.startsWith("Temp dir for this run: ")),
      ).toHaveLength(1);
      // No URL, code or state is ever printed.
      for (const l of r.out) expect(l).not.toMatch(/[?&](code|state|bstate)=/);
      expect(
        r.out.filter(
          (l) => /: (pass|fail)/.test(l) && / \(rl-[ab]\): /.test(l),
        ),
      ).toEqual([
        "  a-alice: A's credential at A (rl-a): pass",
        "  b-alice: A's credential at B (rl-b): pass",
        "  a-alice-replay: A's credential at B (rl-b): pass",
        "  a-alice-replay: A's credential at A (rl-a): pass",
        "  b-dave: B's own credential at B (rl-b): pass",
        "  b-dave-2: B's own credential at B (rl-b): pass",
      ]);
      expect(r.out).toContain(
        "Captures done. The live suite runs now (with --gate).",
      );
      const rep = JSON.parse(readFileSync(r.report, "utf8")) as Report;
      const idCases = rep.cases.filter((x) =>
        x.name.startsWith("sign-in: ID tokens > "),
      );
      expect(idCases).toHaveLength(2);
      for (const x of idCases)
        expect(x).toMatchObject({
          level: "pass",
          label: expect.stringMatching(
            /^fake IdP \(local\); redeemed by capture run /,
          ),
        });
      const levels: Record<string, number> = {};
      for (const x of rep.cases) levels[x.level] = (levels[x.level] ?? 0) + 1;
      console.log(
        `suite (frozen checkout, --gate): ${JSON.stringify(levels)}; exit ${code}`,
      );
      console.log(`callback hops: ${hops.join(" | ")}`);
    }, 600_000);

    it("a prompt that times out names the prompt, the user and the key; r retries it", async () => {
      const seen: Human[] = [];
      let tries = 0;
      const keys: string[] = [];
      const r = deps({
        key: async () => {
          keys.push("r");
          return "r";
        },
        // The suite isn't under test here: stop it at once (our own child).
        onSuite: (pid) => process.kill(pid, "SIGTERM"),
      });
      r.d.human = async (h) => {
        tries++;
        // The first time, the person never signs in.
        if (tries > 1) await types(r.browserOf, seen)(h);
      };
      await oneShot(
        [...base(), "--flows", "a-alice", "--prompt-timeout-ms", "4000"],
        r.d,
      );
      expect(r.out).toContain("[1/1] No sign-in came back within 4 s.");
      expect(r.out).toContain(
        "  Redo prompt 1 of 1: sign in as alice@oa-redline-a.fyi at rl-a. Press r to retry it (Ctrl-C stops).",
      );
      expect(keys).toEqual(["r"]);
      expect(tries).toBe(2);
      expect(r.out.filter((l) => /captured, 1 of 1\./.test(l))).toHaveLength(1);
      expect(r.out).toContain("  a-alice: A's credential at A (rl-a): pass");
      expect(r.out.join("\n")).not.toMatch(/capture_timeout|sent no code/);
    }, 300_000);

    it("Chrome closing mid-prompt is noticed at once: the prompt to redo, r reopens Chrome on the same profile and retries", async () => {
      const seen: Human[] = [];
      let tries = 0;
      const c0 = chromes.length;
      const r = deps({
        key: async () => "r",
        onSuite: (pid) => process.kill(pid, "SIGTERM"),
      });
      r.d.human = async (h) => {
        tries++;
        // The first time, Chrome dies (a crash, or the person quitting it).
        if (tries === 1) {
          process.kill(-h.chrome.pid, "SIGKILL");
          return;
        }
        await types(r.browserOf, seen)(h);
      };
      const t0 = Date.now();
      // A 2 min timeout: the exit must be noticed long before it.
      await oneShot(
        [...base(), "--flows", "b-dave", "--prompt-timeout-ms", "120000"],
        r.d,
      );
      expect(r.out).toContain("[1/1] Chrome closed during this prompt.");
      expect(r.out).toContain(
        "  Redo prompt 1 of 1: sign in as dave@oa-redline-c.fyi at rl-b. Press r to reopen Chrome and retry it (Ctrl-C stops).",
      );
      expect(r.out.join("\n")).not.toMatch(/No sign-in came back/);
      expect(Date.now() - t0).toBeLessThan(110_000);
      expect(chromes.length - c0).toBe(2);
      expect(chromes[c0]?.profile).toBe(chromes[c0 + 1]?.profile);
      expect(r.out).toContain("  b-dave: B's own credential at B (rl-b): pass");
    }, 300_000);

    it("Google's block page (reported by the extension) stops the run once, with the plain message", async () => {
      idp.block = true;
      try {
        const r = deps();
        const code = await oneShot([...base(), "--flows", "a-alice"], r.d);
        expect(code).toBe(EXIT.googleBlocked);
        const all = r.out.join("\n");
        expect(all).toMatch(
          /Stopped at prompt 1 of 1 \(rl-a, alice@oa-redline-a\.fyi\): Google's block page \(\/v3\/signin\/rejected\)\./,
        );
        expect(all).toMatch(
          /This is Google refusing to sign in from this browser .*not a red-line test failure\. Nothing was retried and nothing was redeemed\./,
        );
        expect(all).not.toMatch(/captured, /);
        expect(
          r.out.filter((l) => l.startsWith("[1/1] rl-a: sign in as")),
        ).toHaveLength(1);
      } finally {
        idp.block = false;
      }
    }, 300_000);

    it("Ctrl-C mid-prompt: Chrome exits and the temp dir (profile, extension, verdicts) is gone", async () => {
      const tmp = mkdtempSync(join(work, "tmp-"));
      const run = cli([...base(), "--flows", "a-alice"], tmp);
      await run.until(/Waiting for the extension to check in/);
      const ext = /choose this folder: (\S+)/.exec(run.out())?.[1] as string;
      const runDir = join(ext, "..");
      const profile = join(runDir, "profile");
      const b = await harness(profile);
      browsers.push(b);
      await loadUnpacked(b, ext);
      await run.until(/\[1\/1\] rl-a: sign in as alice@oa-redline-a\.fyi/);
      const pids = chromePidsOf(profile);
      expect(pids.length).toBeGreaterThan(0);
      expect(existsSync(join(runDir, "verdicts"))).toBe(true);
      run.child.kill("SIGINT");
      expect(await run.exit).toBe(130);
      for (const p of pids) expect(await gone(p), `chrome ${p}`).toBe(true);
      expect(existsSync(runDir)).toBe(false);
      expect(
        readdirSync(tmp).filter(
          (f) => !/^oa-redline-hooks-[0-9a-f]+\.json$/.test(f),
        ),
      ).toEqual([]);
      console.log(
        `SIGINT: exit 130; chrome pids ${pids.join(" ")} gone; temp dir removed`,
      );
    }, 300_000);
  },
);
