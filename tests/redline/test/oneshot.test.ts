import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as capture from "../src/capture.ts";
import {
  blockedBy,
  CALLBACK_PATH,
  chromeArgs,
  GOOGLE_CLEAR,
  judge,
  Listener,
  rehearsalArgs,
  writeExtension,
} from "../src/oneshot/browser.ts";
import {
  BROKER_OVERRIDE,
  blockedLines,
  type OneShotOpts,
  parseOpts,
  prereqs,
  promptLine,
  safeMessage,
  timeoutLines,
  usage,
} from "../src/oneshot/driver.ts";
import {
  apiGaps,
  bindingGaps,
  DEFAULT_EXPECT_SHA,
} from "../src/oneshot/suite.ts";
import * as preflight from "../src/preflight.ts";
import * as signin from "../src/signin.ts";
import * as targets from "../src/targets.ts";

// The one-shot capture driver's pure parts (src/oneshot). The real-Chrome
// path runs in test/oneshot-rehearsal.test.ts (REDLINE_REHEARSAL=1).

const A = "https://rl-a.open-artifacts-staging.app";
const B = "https://rl-b.open-artifacts-staging.app";
const armed = { origin: A, state: "S0me-State_x", probe: "oa-capture-probe.p" };
const cb = (
  origin: string,
  q: Record<string, string>,
  path = CALLBACK_PATH,
) => {
  const u = new URL(path, origin);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.href;
};

describe("judge: only this install's callback with this prompt's state is captured", () => {
  it("captures the exact host, path and state", () => {
    expect(judge(cb(A, { state: armed.state, code: "c" }), armed)).toBe(
      "capture",
    );
  });
  it("never captures another host, path, state, an r1. retry or a junk URL", () => {
    expect(judge(cb(B, { state: armed.state, code: "c" }), armed)).toBe("pass");
    expect(
      judge(cb(A, { state: armed.state }, "/auth/callback/github"), armed),
    ).toBe("pass");
    expect(judge(cb(A, { state: "other", code: "c" }), armed)).toBe("pass");
    expect(judge(cb(A, { state: `r1.${armed.state}`, code: "c" }), armed)).toBe(
      "pass",
    );
    expect(
      judge(cb(A, { state: "r1.x", code: "c" }), { ...armed, state: "r1.x" }),
    ).toBe("pass");
    expect(judge(cb(A, { code: "c" }), armed)).toBe("pass");
    expect(judge("not a url", armed)).toBe("pass");
    expect(
      judge(
        cb("http://rl-a.open-artifacts-staging.app", { state: armed.state }),
        armed,
      ),
    ).toBe("pass");
  });
  it("tells the probe apart", () => {
    expect(judge(cb(A, { state: armed.probe }), armed)).toBe("probe");
    expect(judge(cb(B, { state: armed.probe }), armed)).toBe("pass");
  });
});

describe("Chrome's launch", () => {
  it("is plain Chrome: exactly a profile, no first-run screens and a URL; nothing else", () => {
    expect(chromeArgs("/tmp/p", "chrome://extensions/")).toEqual([
      "--user-data-dir=/tmp/p",
      "--no-first-run",
      "chrome://extensions/",
    ]);
  });
  it("no source file of the driver adds a debugging, automation or blink flag outside the rehearsal-only args", () => {
    const src = (f: string) =>
      readFileSync(join(import.meta.dirname, "..", f), "utf8");
    const driver = src("src/oneshot/driver.ts");
    const browser = src("src/oneshot/browser.ts");
    const cli = src("scripts/capture-oneshot.ts");
    const flags =
      /--remote-debugging|--enable-automation|--disable-blink-features|--load-extension|--headless|--enable-unsafe/;
    for (const s of [driver, cli]) expect(s).not.toMatch(flags);
    // browser.ts: only inside rehearsalArgs() (the --rehearsal-harness flag,
    // refused with staging targets).
    const outside = browser.replace(
      /export function rehearsalArgs[\s\S]*?\n}\n/,
      "",
    );
    expect(outside).not.toMatch(flags);
    expect(browser).not.toMatch(
      /disable-blink-features|enable-automation|load-extension/,
    );
    expect(rehearsalArgs()).toEqual([
      "--headless=new",
      "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging",
    ]);
  });
});

describe("blockedBy: Google's automation, unsupported-browser and OAuth error pages", () => {
  const G = "https://accounts.google.com";
  it("by path, on the IdP's origin only", () => {
    expect(blockedBy(`${G}/v3/signin/rejected?rrk=46`, G)).toBe(
      "Google's block page (/v3/signin/rejected)",
    );
    expect(
      blockedBy(`${G}/signin/oauth/error?authError=disallowed_useragent`, G),
    ).toBe("Google's block page (/signin/oauth/error, disallowed_useragent)");
    expect(blockedBy(`${G}/signin/oauth/error/v2?authError=x y`, G)).toBe(
      "Google's block page (/signin/oauth/error/v2)",
    );
    expect(blockedBy(`${G}/v3/signin/identifier`, G)).toBeNull();
    expect(blockedBy(`${A}/v3/signin/rejected`, G)).toBeNull();
  });
});

describe("the capture extension's generated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-oneshot-ext-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("host permissions are the two installs, 127.0.0.1 and the IdP; DNR blocks only their callbacks", () => {
    writeExtension(join(dir, "e"), {
      installs: [A, B],
      listener: "http://127.0.0.1:4567",
      token: "t".repeat(43),
      idp: "https://accounts.google.com",
      clearOrigins: GOOGLE_CLEAR,
    });
    const read = (f: string) => readFileSync(join(dir, "e", f), "utf8");
    const m = JSON.parse(read("manifest.json"));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions.sort()).toEqual([
      "browsingData",
      "declarativeNetRequest",
      "webRequest",
    ]);
    expect(m.host_permissions).toEqual([
      "https://rl-a.open-artifacts-staging.app/*",
      "https://rl-b.open-artifacts-staging.app/*",
      "http://127.0.0.1/*",
      "https://accounts.google.com/*",
    ]);
    expect(JSON.parse(read("rules.json"))).toEqual([
      {
        id: 1,
        priority: 2,
        action: { type: "block" },
        condition: {
          urlFilter: `|${A}/auth/callback/google`,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
      {
        id: 2,
        priority: 2,
        action: { type: "block" },
        condition: {
          urlFilter: `|${B}/auth/callback/google`,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ]);
    const cfg = read("config.js");
    expect(cfg).toContain('"listener":"http://127.0.0.1:4567"');
    expect(cfg).toContain(`"token":"${"t".repeat(43)}"`);
    expect(cfg).toContain(
      `"clearOrigins":["https://accounts.google.com","https://www.google.com","https://google.com"]`,
    );
    expect(read("background.js")).not.toMatch(/console\./);
    expect(statSync(join(dir, "e", "config.js")).mode & 0o077).toBe(0);
  });
});

describe("the listener", () => {
  it("refuses a missing or wrong token, takes the right one, and long-polls commands", async () => {
    const L = new Listener();
    await L.start();
    try {
      const post = (path: string, body: object) =>
        fetch(`${L.origin}${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      expect((await post("/hello", {})).status).toBe(403);
      expect((await post("/hello", { token: "x" })).status).toBe(403);
      expect(L.refused).toBe(2);
      const reports: string[] = [];
      L.on((r) => reports.push(r.kind));
      expect(
        (await post("/blocked", { token: "y", url: "https://a/" })).status,
      ).toBe(403);
      expect(reports).toEqual([]);
      const hello = L.nextHello();
      expect((await post("/hello", { token: L.token })).status).toBe(200);
      await hello;
      await L.checkedIn;
      const polled = post("/next", { token: L.token }).then((r) => r.json());
      const done = L.command({ cmd: "clear" });
      const c = (await polled) as { cmd: string; id: number };
      expect(c.cmd).toBe("clear");
      await post("/ack", { token: L.token, id: c.id, ok: true });
      expect(await done).toBe(true);
    } finally {
      await L.close();
    }
  });
});

describe("what the person reads", () => {
  const p = {
    n: 2,
    total: 5,
    flow: "b-alice" as const,
    user: "alice@oa-redline-a.fyi",
    why: "",
    install: "rl-b",
  };
  const g = new URL("https://accounts.google.com/o/oauth2/v2/auth?state=x");
  it("one line per prompt: who, where, what Google shows; no URL, state or code", () => {
    const l = promptLine(p, g);
    expect(l.split("\n")).toHaveLength(1);
    expect(l).toMatch(/^\[2\/5\] rl-b: sign in as alice@oa-redline-a\.fyi/);
    expect(l).toMatch(/any account/);
    g.searchParams.set("hd", "oa-redline-c.fyi");
    expect(promptLine(p, g)).toMatch(/only oa-redline-c\.fyi accounts/);
    expect(l).not.toMatch(/state|code=|https?:/);
  });
  it("the timeout names the prompt, the user and the one key", () => {
    const t = timeoutLines(p, 5 * 60_000).join("\n");
    expect(t).toMatch(/within 5 min/);
    expect(t).toMatch(
      /Redo prompt 2 of 5: sign in as alice@oa-redline-a\.fyi at rl-b\. Press r to retry it/,
    );
  });
  it("a Google block says it is Google refusing, not a test failure, and nothing retried", () => {
    const t = blockedLines(p, "Google's block page (/v3/signin/rejected)").join(
      "\n",
    );
    expect(t).toMatch(/Google refusing/);
    expect(t).toMatch(/not a red-line test failure/);
    expect(t).toMatch(/Nothing was retried/);
  });
  it("never mentions the browser's developer tools", () => {
    const all = [
      usage,
      promptLine(p, g),
      ...timeoutLines(p, 1000),
      ...blockedLines(p, "x"),
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "docs",
          "ops",
          "redline-signin.md",
        ),
        "utf8",
      ),
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "docs",
          "ops",
          "redline-capture-audit.md",
        ),
        "utf8",
      ),
    ].join("\n");
    expect(all).not.toMatch(/devtools/i);
  });
});

describe("safeMessage: no URL, state or code reaches the terminal", () => {
  it("strips URLs and query values from a browser error", () => {
    const e = new Error(
      'page.goto: Navigation to "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=SECRETSTATE&code_challenge=CH" is interrupted\nCall log:\n  - navigating to "https://rl-a.x/auth/callback/google?state=S2&code=C2"',
    );
    const m = safeMessage(e);
    expect(m).toBe('page.goto: Navigation to "<url> is interrupted');
    expect(safeMessage(new Error("bad state=abc code=4/0x here"))).toBe(
      "bad state=<hidden> code=<hidden> here",
    );
  });
});

describe("flags", () => {
  it("defaults: the frozen suite, the frozen SHA, the kit's targets, 5 min", () => {
    const r = parseOpts([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.opts.expectSha).toBe(DEFAULT_EXPECT_SHA);
    expect(r.opts.suite).toMatch(/openartifacts-capture$/);
    expect(r.opts.targetsFile).toMatch(
      /\.open-artifacts\/redline-capture\/targets\.json$/,
    );
    expect(r.opts.promptTimeoutMs).toBe(300_000);
    expect(r.opts.chromePath).toBeUndefined();
    expect(r.opts.rehearsalHarness).toBeUndefined();
  });
  it("refuses unknown flags and a short SHA", () => {
    expect(parseOpts(["--nope"]).ok).toBe(false);
    expect(parseOpts(["--expect-sha", "5469cf78"]).ok).toBe(false);
  });
  it("builds in the approved broker override", () => {
    expect(BROKER_OVERRIDE).toEqual({ REDLINE_ALLOW_UNCHECKED_BROKER: "1" });
  });
});

describe("prerequisites", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "oa-oneshot-test-"));
    dirs.push(d);
    return d;
  };
  const opts = (o: Partial<OneShotOpts>): OneShotOpts => {
    const r = parseOpts([]);
    if (!r.ok) throw new Error(r.why);
    return { ...r.opts, chromePath: process.execPath, ...o };
  };
  const secret = (p: string, mode = 0o600) =>
    writeFileSync(p, "x".repeat(40), { mode });
  const kit = (d: string) => {
    const s = join(d, "secrets");
    mkdirSync(s, { mode: 0o700 });
    const tf = join(d, "targets.json");
    const ts = join(d, "turnstile-token");
    secret(ts);
    const t = (name: string, id: string) => ({
      name,
      installId: id,
      app: `https://${name}.open-artifacts-staging.app`,
      content: `https://${name}.open-artifacts-staging.page`,
      testDomain: "guests.x.fyi",
      turnstileFile: ts,
    });
    writeFileSync(
      tf,
      JSON.stringify({
        mode: "staging",
        a: t("rl-a", "ijzbmraouh5r"),
        b: t("rl-b", "i42fdk7ahvs2"),
        secretsDir: s,
      }),
      { mode: 0o600 },
    );
    return { tf, s, ts };
  };

  it("names a missing targets file, macOS and Chrome with their fixes", () => {
    const p = prereqs(
      opts({
        targetsFile: "/nonexistent/targets.json",
        chromePath: "/no/chrome",
      }),
      targets.secretFileName,
      "linux",
    );
    expect(p.gaps.join("\n")).toMatch(/macOS only/);
    expect(p.gaps.join("\n")).toMatch(/Google Chrome is not at \/no\/chrome/);
    expect(p.gaps.join("\n")).toMatch(/targets\.json.*missing.*Platform's kit/);
  });
  it("a 0644 targets file gets its chmod", () => {
    const d = tmp();
    const { tf } = kit(d);
    execFileSync("chmod", ["644", tf]);
    expect(
      prereqs(
        opts({ targetsFile: tf }),
        targets.secretFileName,
        "darwin",
      ).gaps.join(),
    ).toMatch(/chmod 600/);
  });
  it("missing admin secrets mean redline-creds, per install", () => {
    const d = tmp();
    const { tf, s } = kit(d);
    let p = prereqs(
      opts({ targetsFile: tf }),
      targets.secretFileName,
      "darwin",
    );
    expect(p.gaps).toEqual([]);
    expect(p.needCreds.map((n) => [n.name, n.installId, n.appHost])).toEqual([
      ["rl-a", "ijzbmraouh5r", "rl-a.open-artifacts-staging.app"],
      ["rl-b", "i42fdk7ahvs2", "rl-b.open-artifacts-staging.app"],
    ]);
    for (const n of ["RL_A", "RL_B"])
      for (const k of ["PAT", "HOOK_KEY"]) secret(join(s, `REDLINE_${n}_${k}`));
    p = prereqs(opts({ targetsFile: tf }), targets.secretFileName, "darwin");
    expect(p.needCreds).toEqual([]);
    expect(p.gaps).toEqual([]);
  });
  it("rehearsal flags are refused with staging targets", () => {
    const d = tmp();
    const { tf } = kit(d);
    const g = prereqs(
      opts({
        targetsFile: tf,
        idp: "http://127.0.0.1:1",
        loopback: true,
        rehearsalHarness: true,
      }),
      targets.secretFileName,
      "darwin",
    ).gaps.join();
    expect(g).toMatch(/--idp, --loopback, --rehearsal-harness: rehearsal only/);
  });
});

describe("the gate binding", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", a, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), "oa-oneshot-suite-"));
    dirs.push(d);
    mkdirSync(join(d, "tests", "redline", "src"), { recursive: true });
    writeFileSync(join(d, "tests", "redline", "src", "capture.ts"), "\n");
    writeFileSync(join(d, ".gitignore"), "node_modules/\ndist/\n");
    git(d, "init", "-q");
    git(d, "add", "-A");
    git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
    return { d, sha: git(d, "rev-parse", "HEAD") };
  };
  const install = (d: string) => {
    mkdirSync(join(d, "tests", "redline", "node_modules", ".bin"), {
      recursive: true,
    });
    writeFileSync(
      join(d, "tests", "redline", "node_modules", ".bin", "vitest"),
      "",
    );
    mkdirSync(join(d, "node_modules"), { recursive: true });
    mkdirSync(join(d, "packages", "provision", "dist"), { recursive: true });
    writeFileSync(join(d, "packages", "provision", "dist", "index.js"), "");
  };

  it("bound: the expected HEAD, a clean tree, installed and generated", () => {
    const { d, sha } = repo();
    install(d);
    expect(bindingGaps(d, sha)).toEqual([]);
  });
  it("refuses another commit", () => {
    const { d, sha } = repo();
    install(d);
    const other = "0".repeat(40);
    expect(bindingGaps(d, other).join()).toMatch(
      new RegExp(`is at ${sha.slice(0, 12)}, not 000000000000`),
    );
  });
  it("refuses a dirty tree: modified or untracked", () => {
    const { d, sha } = repo();
    install(d);
    writeFileSync(join(d, "tests", "redline", "src", "stray.test.ts"), "x");
    expect(bindingGaps(d, sha).join()).toMatch(/has local changes \(1 paths\)/);
    rmSync(join(d, "tests", "redline", "src", "stray.test.ts"));
    writeFileSync(join(d, "tests", "redline", "src", "capture.ts"), "y");
    expect(bindingGaps(d, sha).join()).toMatch(/has local changes/);
  });
  it("refuses a checkout that isn't installed or generated, and a missing one", () => {
    const { d, sha } = repo();
    expect(bindingGaps(d, sha).join()).toMatch(/is not installed \(pnpm -C/);
    mkdirSync(join(d, "tests", "redline", "node_modules", ".bin"), {
      recursive: true,
    });
    writeFileSync(
      join(d, "tests", "redline", "node_modules", ".bin", "vitest"),
      "",
    );
    mkdirSync(join(d, "node_modules"));
    expect(bindingGaps(d, sha).join()).toMatch(/is not generated/);
    expect(bindingGaps(join(d, "nope"), sha).join()).toMatch(
      /missing or has no tests\/redline/,
    );
  });
  it("this branch's capture API (identical at the frozen SHA) has every export the driver needs", () => {
    expect(apiGaps({ capture, preflight, signin, targets })).toEqual([]);
    const { runCaptures: _, ...noRun } = capture;
    expect(apiGaps({ capture: noRun, preflight, signin, targets })).toEqual([
      "capture.ts at the suite commit has no function runCaptures",
    ]);
  });
});
