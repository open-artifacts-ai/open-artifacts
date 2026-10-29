import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  judge,
  patternOf,
} from "../src/oneshot/chrome.ts";
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
  it("escapes CDP pattern wildcards", () => {
    expect(patternOf("https://a?b*c\\d")).toBe("https://a\\?b\\*c\\\\d");
  });
});

describe("Chrome's launch", () => {
  it("is a normal launch: CDP on 127.0.0.1, a port Chrome picks, its own profile, no automation switch", () => {
    const a = chromeArgs("/tmp/p");
    expect(a).toContain("--remote-debugging-address=127.0.0.1");
    expect(a).toContain("--remote-debugging-port=0");
    expect(a).toContain("--user-data-dir=/tmp/p");
    expect(a).toContain("--disable-blink-features=AutomationControlled");
    expect(a.join(" ")).not.toMatch(
      /enable-automation|headless|remote-debugging-pipe/,
    );
    expect(chromeArgs("/tmp/p", true)).toEqual([
      ...a.slice(0, -1),
      "--headless=new",
      "about:blank",
    ]);
  });
});

describe("blockedBy: Google's automation and unsupported-browser blocks", () => {
  const G = "https://accounts.google.com";
  it("by path and by text, on the IdP's origin only", () => {
    expect(blockedBy(`${G}/v3/signin/rejected?rrk=46`, "", G)).toMatch(
      /block page/,
    );
    expect(
      blockedBy(
        `${G}/v3/signin/identifier`,
        "Couldn't sign you in\nThis browser or app may not be secure.",
        G,
      ),
    ).toMatch(/Couldn.t sign you in|may not be secure/);
    expect(
      blockedBy(`${G}/x`, "This browser or app may not be secure", G),
    ).toMatch(/may not be secure/);
    expect(blockedBy(`${G}/x`, "Unsupported browser", G)).toBeTruthy();
    expect(blockedBy(`${G}/v3/signin/identifier`, "Sign in", G)).toBeNull();
    expect(
      blockedBy(`${A}/v3/signin/rejected`, "may not be secure", G),
    ).toBeNull();
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
    expect(r.opts.chrome).toEqual({});
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
    return { ...r.opts, chrome: { path: process.execPath }, ...o };
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
        chrome: { path: "/no/chrome" },
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
        chrome: { path: process.execPath, headless: true },
      }),
      targets.secretFileName,
      "darwin",
    ).gaps.join();
    expect(g).toMatch(/--idp, --loopback, --headless: rehearsal only/);
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
