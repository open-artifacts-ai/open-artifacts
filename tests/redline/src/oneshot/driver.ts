import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { CaptureIO, CapturePrompt } from "../capture.ts";
import type { FlowName } from "../signin.ts";
import type { Target, Targets } from "../targets.ts";
import {
  type Armed,
  armCallback,
  CALLBACK_PATH,
  CHROME_MAC,
  type Chrome,
  type ChromeOpts,
  GoogleBlocked,
  killAllChromesSync,
  launchChrome,
} from "./chrome.ts";
import {
  BindingRefused,
  DEFAULT_EXPECT_SHA,
  DEFAULT_SUITE,
  loadSuite,
  runSuiteIn,
  type Suite,
} from "./suite.ts";

// The one-shot real-tenant sign-in capture (docs/ops/redline-signin.md):
//   pnpm -C tests/redline capture            (the run)
//   pnpm -C tests/redline capture:dry-run    (Platform's dry run)
// In order: prerequisites (each refusal names its fix), the admin
// credentials (printed, or made with --make-creds), the preflight with the
// approved broker override built in, the 5 Google sign-ins in a fresh
// Chrome per prompt (the callback is intercepted, never copied), then the
// live suite with --gate in the frozen suite checkout. The capture logic
// itself is the frozen checkout's runCaptures, given a Chrome CaptureIO.

export const KIT_DIR = join(homedir(), ".open-artifacts", "redline-capture");
export const ACCOUNT_ID_FILE = join(KIT_DIR, "cloudflare-account-id");
/** Until the server's broker-probe hook ships (#846); applies only on its 404. */
export const BROKER_OVERRIDE = { REDLINE_ALLOW_UNCHECKED_BROKER: "1" };
/** The deleted install's hosts (the kit's run-capture.sh set them). */
export const DEFAULT_DELETED_HOSTS = [
  "rl-del.open-artifacts-staging.app",
  "rl-del.open-artifacts-staging.page",
];
const GOOGLE_AUTH = "https://accounts.google.com";
const KEYCHAIN_ITEM = "oa-hosted-staging";
const KEYCHAIN_ACCOUNT = "open-artifacts";
const TIMEOUT_MARK = "capture_timeout";

/**
 * An error's message with every URL and query value removed: a browser
 * error can quote the Google URL or a callback (state, code). Only this
 * goes to the terminal.
 */
export function safeMessage(e: unknown, max = 200): string {
  const m = e instanceof Error ? e.message : String(e);
  return m
    .split("\n")[0]
    ?.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/[?&][^\s=&]+=[^\s&"']*/g, "")
    .replace(/\b(state|code|bstate|nonce|code_challenge)=\S*/gi, "$1=<hidden>")
    .slice(0, max) as string;
}

export const EXIT = {
  ok: 0,
  failed: 1,
  refused: 2,
  googleBlocked: 3,
  stopped: 4,
} as const;

export interface OneShotOpts {
  suite: string;
  expectSha: string;
  targetsFile: string;
  dryRun: boolean;
  makeCreds: boolean;
  promptTimeoutMs: number;
  chrome: ChromeOpts;
  /** Rehearsal only (local targets): the fake IdP's origin. */
  idp?: string;
  /** Rehearsal only (local targets): https *.localhost served over http. */
  loopback?: boolean;
  /** Rehearsal only (local targets): these flows only. */
  flows?: FlowName[];
}

export interface Human {
  chrome: Chrome;
  prompt: CapturePrompt;
  url: URL;
  armed: Armed;
}

export interface OneShotDeps {
  env: Record<string, string | undefined>;
  out(line: string): void;
  /** One key from the terminal ("" when there is no terminal). */
  key(): Promise<string>;
  /** One answer from the terminal (null when there is no terminal). */
  question(q: string): Promise<string | null>;
  /** Rehearsal only: stands in for the person at the Chrome window. */
  human?(h: Human): Promise<void>;
  /** Each Chrome as it starts (tests). */
  onChrome?(c: Chrome): void;
  /** The suite child's pid (signal forwarding). */
  onSuite?(pid: number): void;
  platform?: NodeJS.Platform;
}

export const usage = `Usage: pnpm -C tests/redline capture [--make-creds] [--dry-run]
  --suite <path>              the frozen suite checkout (default ${DEFAULT_SUITE})
  --expect-sha <sha>          its required commit (default ${DEFAULT_EXPECT_SHA})
  --targets <file>            the kit's targets (default ${join(KIT_DIR, "targets.json")})
  --make-creds                run the redline-creds commands when the admin secrets are missing
  --dry-run                   each prompt up to Google's sign-in page, no credentials, no suite
  --prompt-timeout-min <n>    minutes per prompt before offering a retry (default 5)
  --chrome <path>             Google Chrome's binary (default ${CHROME_MAC})`;

export function parseOpts(
  argv: string[],
): { ok: true; opts: OneShotOpts } | { ok: false; why: string } {
  let v: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values: v } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        suite: { type: "string" },
        "expect-sha": { type: "string" },
        targets: { type: "string" },
        "dry-run": { type: "boolean" },
        "make-creds": { type: "boolean" },
        "prompt-timeout-min": { type: "string" },
        "prompt-timeout-ms": { type: "string" },
        chrome: { type: "string" },
        idp: { type: "string" },
        loopback: { type: "boolean" },
        headless: { type: "boolean" },
        flows: { type: "string" },
        gate: { type: "boolean" },
      },
    }));
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : "bad flags" };
  }
  const str = (k: string) =>
    typeof v[k] === "string" ? (v[k] as string) : undefined;
  const min = Number(str("prompt-timeout-min") ?? "5");
  const ms = str("prompt-timeout-ms");
  const timeout = ms !== undefined ? Number(ms) : min * 60_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    return { ok: false, why: "--prompt-timeout-min must be a positive number" };
  const expectSha = str("expect-sha") ?? DEFAULT_EXPECT_SHA;
  if (!/^[0-9a-f]{40}$/.test(expectSha))
    return { ok: false, why: "--expect-sha must be a full 40-hex commit" };
  const flows = str("flows")?.split(",").filter(Boolean) as
    | FlowName[]
    | undefined;
  return {
    ok: true,
    opts: {
      suite: str("suite") ?? DEFAULT_SUITE,
      expectSha,
      targetsFile: str("targets") ?? join(KIT_DIR, "targets.json"),
      dryRun: v["dry-run"] === true,
      makeCreds: v["make-creds"] === true,
      promptTimeoutMs: timeout,
      chrome: {
        ...(str("chrome") ? { path: str("chrome") as string } : {}),
        ...(v.headless === true ? { headless: true } : {}),
      },
      ...(str("idp") ? { idp: str("idp") as string } : {}),
      ...(v.loopback === true ? { loopback: true } : {}),
      ...(flows?.length ? { flows } : {}),
    },
  };
}

/** Rehearsal flags: allowed with local targets only. */
const rehearsalFlags = (o: OneShotOpts) =>
  [
    o.idp ? "--idp" : "",
    o.loopback ? "--loopback" : "",
    o.chrome.headless ? "--headless" : "",
    o.flows ? "--flows" : "",
    o.promptTimeoutMs < 60_000 ? "--prompt-timeout-ms" : "",
  ].filter(Boolean);

/** A 0600 regular non-empty file, or why not (never read). */
function secretGap(path: string | undefined, what: string): string | null {
  if (!path) return `${what}: no file configured`;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return `${what}: ${path} is missing`;
  }
  if (!st.isFile()) return `${what}: ${path} is not a regular file`;
  if ((st.mode & 0o077) !== 0)
    return `${what}: ${path} must be mode 0600 (chmod 600 ${path})`;
  if (st.size === 0) return `${what}: ${path} is empty`;
  return null;
}

interface RawTargets {
  mode?: unknown;
  secretsDir?: unknown;
  deletedHosts?: unknown;
  a?: Record<string, unknown>;
  b?: Record<string, unknown>;
}

export interface Prereqs {
  gaps: string[];
  raw: RawTargets | null;
  rawText: string;
  /** Installs whose admin secrets are missing (redline-creds writes them). */
  needCreds: { name: string; installId: string; appHost: string }[];
}

/** (a) Everything checkable before the suite loads; each gap names its fix. */
export function prereqs(
  o: OneShotOpts,
  secretFileName: (name: string, kind: "PAT" | "HOOK_KEY") => string,
  platform: NodeJS.Platform = process.platform,
): Prereqs {
  const gaps: string[] = [];
  const out: Prereqs = { gaps, raw: null, rawText: "", needCreds: [] };
  if (platform !== "darwin") gaps.push("this runs on macOS only");
  const chrome = o.chrome.path ?? CHROME_MAC;
  if (!existsSync(chrome))
    gaps.push(
      `Google Chrome is not at ${chrome}: install it from google.com/chrome (or pass --chrome <path>)`,
    );
  const tf = o.targetsFile;
  const g = secretGap(tf, "the kit's targets.json");
  if (g) {
    gaps.push(`${g}; Platform's kit puts it there (0600)`);
    return out;
  }
  try {
    out.rawText = readFileSync(tf, "utf8");
    out.raw = JSON.parse(out.rawText) as RawTargets;
  } catch {
    gaps.push(`${tf} is not JSON: ask Platform for the kit's targets.json`);
    return out;
  }
  const raw = out.raw;
  const mode = raw.mode ?? "staging";
  const rf = rehearsalFlags(o);
  if (mode === "staging" && rf.length)
    gaps.push(`${rf.join(", ")}: rehearsal only, refused with staging targets`);
  if (mode !== "staging" && mode !== "local")
    gaps.push(`${tf}: mode must be staging`);
  if (mode === "local" && !o.idp)
    gaps.push(`${tf} holds local targets: this command is for staging`);
  if (mode !== "staging") return out;
  const dir = typeof raw.secretsDir === "string" ? raw.secretsDir : undefined;
  for (const k of ["a", "b"] as const) {
    const t = raw[k] ?? {};
    const name = typeof t.name === "string" ? t.name : k;
    const installId = typeof t.installId === "string" ? t.installId : "";
    const file = (v: unknown, kind: "PAT" | "HOOK_KEY") =>
      typeof v === "string" && v
        ? v
        : dir
          ? join(dir, secretFileName(name, kind))
          : undefined;
    const pat = secretGap(file(t.patFile, "PAT"), `${name} admin PAT`);
    const hk = secretGap(file(t.hookKeyFile, "HOOK_KEY"), `${name} hook key`);
    if (pat || hk) {
      let appHost = "";
      try {
        appHost = new URL(String(t.app)).host;
      } catch {}
      out.needCreds.push({ name, installId, appHost });
    }
    const ts = secretGap(
      typeof t.turnstileFile === "string" ? t.turnstileFile : undefined,
      `${name} Turnstile token`,
    );
    if (ts)
      gaps.push(
        `${ts}; set turnstileFile on ${name} in ${tf} to the kit's 0600 turnstile-token`,
      );
  }
  return out;
}

const credsCmd = (suite: string, account: string, id: string) =>
  `CLOUDFLARE_ACCOUNT_ID=${account} pnpm -C ${suite} oa:hosted redline-creds --env staging --install ${id} --confirm ${id}`;

/** The hosted account id: env, the kit's file, else asked once and saved. */
async function accountId(d: OneShotDeps): Promise<string | null> {
  const ok = (s: string | undefined | null) =>
    s && /^[0-9a-f]{32}$/.test(s.trim()) ? s.trim() : null;
  const fromEnv = ok(d.env.CLOUDFLARE_ACCOUNT_ID);
  if (fromEnv) return fromEnv;
  try {
    const f = ok(readFileSync(ACCOUNT_ID_FILE, "utf8"));
    if (f) return f;
  } catch {}
  const a = ok(
    await d.question(
      "The hosted Cloudflare account id (32 hex, the dashboard's Account ID; asked once): ",
    ),
  );
  if (a) {
    mkdirSync(dirname(ACCOUNT_ID_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(ACCOUNT_ID_FILE, `${a}\n`, { mode: 0o600 });
  }
  return a;
}

const quiet = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};

/** (b) The admin secrets: print the exact commands, or run them (--make-creds). */
async function makeCreds(
  o: OneShotOpts,
  p: Prereqs,
  d: OneShotDeps,
): Promise<boolean> {
  const acct = await accountId(d);
  const gaps: string[] = [];
  if (!acct)
    gaps.push(
      `CLOUDFLARE_ACCOUNT_ID: put the hosted account id (32 hex) in ${ACCOUNT_ID_FILE} (0600), or export it`,
    );
  if (
    !quiet("/usr/bin/security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_ITEM,
    ])
  )
    gaps.push(
      `Keychain item ${KEYCHAIN_ITEM} (account ${KEYCHAIN_ACCOUNT}) is missing: security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_ITEM} -w  (paste the hosted staging API token)`,
    );
  if (!quiet("gh", ["auth", "status"]))
    gaps.push("gh is not signed in: gh auth login");
  if (!quiet("git", ["config", "user.email"]))
    gaps.push(
      "git config user.email is unset (the audit actor): git config --global user.email <you>",
    );
  for (const n of p.needCreds) {
    const f = join(
      homedir(),
      ".open-artifacts",
      "hosted-staging",
      `${n.appHost}-hook-key`,
    );
    const g = secretGap(f, `${n.name}'s hook key from create`);
    if (g) gaps.push(`${g}; the hosted operator has it from oa:hosted create`);
  }
  const cmds = p.needCreds.map((n) =>
    credsCmd(o.suite, acct ?? "<account id>", n.installId),
  );
  d.out(
    `The admin secrets for ${p.needCreds.map((n) => n.name).join(" and ")} are missing. They come from:`,
  );
  for (const c of cmds) d.out(`  ${c}`);
  if (gaps.length) {
    d.out("Those commands need first:");
    for (const g of gaps) d.out(`  - ${g}`);
    return false;
  }
  if (!o.makeCreds) {
    d.out("Run them, or run this again with --make-creds to run them for you.");
    return false;
  }
  for (const n of p.needCreds) {
    d.out(`Making ${n.name}'s admin secrets (redline-creds)...`);
    const code = await new Promise<number>((r) => {
      const c = spawn(
        "pnpm",
        [
          "-C",
          o.suite,
          "oa:hosted",
          "redline-creds",
          "--env",
          "staging",
          "--install",
          n.installId,
          "--confirm",
          n.installId,
        ],
        {
          stdio: "inherit",
          env: { ...d.env, CLOUDFLARE_ACCOUNT_ID: acct as string },
        },
      );
      c.on("exit", (x) => r(x ?? 1));
    });
    if (code !== 0) {
      d.out(`redline-creds for ${n.name} failed (exit ${code}).`);
      return false;
    }
  }
  return true;
}

/** https *.localhost to http (the local pair; never staging). */
export const loopbackHttp = (u: URL): URL => {
  if (u.protocol !== "https:" || !u.hostname.endsWith(".localhost")) return u;
  const v = new URL(u);
  v.protocol = "http:";
  return v;
};
const httpsOf = (origin: string) => origin.replace(/^http:/, "https:");

interface Ctx {
  o: OneShotOpts;
  d: OneShotDeps;
  suite: Suite;
  T: Targets;
  idp: string;
}

const browserOriginOf = (c: Ctx, t: Target) =>
  c.o.loopback ? httpsOf(t.app) : t.app;
const armOpts = (c: Ctx) => ({
  idp: c.idp,
  ...(c.o.loopback
    ? { proxy: { pattern: "https://*.localhost*", map: loopbackHttp } }
    : {}),
});

/** The install's own state behind a Google URL (the broker's state names it). */
function installStateOf(c: Ctx, url: URL): string {
  const s = url.searchParams.get("state") ?? "";
  return c.suite.capture.decodeBrokerState(s)?.s ?? s;
}

/** The one line per prompt: who, where, what Google will show. */
export function promptLine(p: CapturePrompt, url: URL): string {
  const hd = url.searchParams.get("hd");
  const shows = hd
    ? `Google offers only ${hd} accounts`
    : "Google shows any account: pick this one, the refusal later is the point";
  return `[${p.n}/${p.total}] ${p.install}: sign in as ${p.user} in the Chrome window that just opened (${shows}). Google may ask you to confirm it's you; that's normal. The window closes by itself.`;
}

export const timeoutLines = (p: CapturePrompt, ms: number) => [
  `[${p.n}/${p.total}] No sign-in came back within ${Math.round(ms / 60_000) || `${Math.round(ms / 1000)} s`}${ms >= 60_000 ? " min" : ""}.`,
  `  Redo prompt ${p.n} of ${p.total}: sign in as ${p.user} at ${p.install}. Press r to retry it (Ctrl-C stops).`,
];

export const blockedLines = (p: CapturePrompt, why: string) => [
  `Stopped at prompt ${p.n} of ${p.total} (${p.install}, ${p.user}): ${why}.`,
  "  This is Google refusing to sign in from the browser this script started (its automation or unsupported-browser block), not a red-line test failure. Nothing was retried and nothing was redeemed.",
  "  Tell Platform; the run can't continue on this Mac until Google allows the window.",
];

/** The Chrome CaptureIO: a fresh Chrome per prompt, the callback intercepted. */
export function chromeIO(c: Ctx): CaptureIO & { shut(): Promise<void> } {
  let cur: { chrome: Chrome; armed: Armed } | null = null;
  let last: { url: URL; p: CapturePrompt } | null = null;
  const target = (p: CapturePrompt) =>
    p.install === c.T.a.name ? c.T.a : c.T.b;
  const shut = async () => {
    const x = cur;
    cur = null;
    if (!x) return;
    await x.chrome.close();
  };
  const blocked = (p: CapturePrompt, why: string) =>
    new GoogleBlocked(blockedLines(p, why).join("\n"));
  const open = async (url: URL, p: CapturePrompt) => {
    await shut();
    last = { url, p };
    const t = target(p);
    const chrome = await launchChrome(c.o.chrome);
    c.d.onChrome?.(chrome);
    try {
      const armed = await armCallback(
        chrome,
        { origin: browserOriginOf(c, t), state: installStateOf(c, url) },
        armOpts(c),
      );
      await armed.checkWebdriver();
      await armed.probe();
      cur = { chrome, armed };
      c.d.out(promptLine(p, url));
      await armed.open(url.toString());
      await c.d.human?.({ chrome, prompt: p, url, armed });
    } catch (e) {
      await shut();
      await chrome.close();
      throw e;
    }
  };
  return {
    shut,
    async offer(url, p) {
      await open(url, p);
    },
    async ask(p) {
      if (!cur && last) await open(last.url, last.p);
      const x = cur;
      if (!x) throw new Error("ask before offer");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        x.armed.captured.then((u) => ({ k: "captured" as const, u })),
        x.armed.blocked.then((why) => ({ k: "blocked" as const, why })),
        new Promise<{ k: "timeout" }>((res) => {
          timer = setTimeout(() => res({ k: "timeout" }), c.o.promptTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      // The browser goes at once: the code is held here only.
      await shut();
      if (r.k === "captured")
        return (c.o.loopback ? loopbackHttp(new URL(r.u)) : new URL(r.u)).href;
      if (r.k === "blocked") throw blocked(p, r.why);
      for (const l of timeoutLines(p, c.o.promptTimeoutMs)) c.d.out(l);
      for (;;) {
        const k = await c.d.key();
        if (k === "r") break;
        if (k === "")
          throw new Error(
            `no terminal to read the retry key; run the command again in a terminal (prompt ${p.n} timed out)`,
          );
        c.d.out(`  Press r to retry prompt ${p.n} (Ctrl-C stops).`);
      }
      // A restart: the capture starts this prompt's sign-in again (a fresh
      // state), through its own "the IdP sent no code" path.
      const u = new URL(CALLBACK_PATH, target(p).app);
      u.searchParams.set(
        "state",
        installStateOf(c, (last as { url: URL }).url),
      );
      u.searchParams.set("error", TIMEOUT_MARK);
      return u.href;
    },
    async taken() {
      await shut();
    },
    say(line) {
      if (line.includes(TIMEOUT_MARK)) return;
      c.d.out(line);
    },
  };
}

export interface DryResult {
  flow: FlowName;
  install: string;
  hd: string | null;
  problems: string[];
}

/** (dry run) Each prompt up to Google's sign-in page: URL, hd, interception, no block. */
export async function dryRun(c: Ctx): Promise<DryResult[]> {
  const { CAPTURE_FLOWS, startGoogle, googleUrlOf } = c.suite.signin;
  const flows = c.o.flows ?? (Object.keys(CAPTURE_FLOWS) as FlowName[]);
  const out: DryResult[] = [];
  for (const [i, flow] of flows.entries()) {
    const spec = CAPTURE_FLOWS[flow];
    const t = c.T[spec.at];
    const foreign = "foreign" in spec && spec.foreign;
    const r: DryResult = { flow, install: t.name, hd: null, problems: [] };
    out.push(r);
    const s = await startGoogle(t).catch((e: unknown) => {
      r.problems.push(`sign-in start failed (${safeMessage(e, 120)})`);
      return null;
    });
    if (!s) {
      if (!r.problems.length) r.problems.push("Google sign-in is off");
      continue;
    }
    let url: URL;
    try {
      url = await googleUrlOf(s, {
        dropHd: foreign,
        ...(c.o.idp ? { idp: c.o.idp } : {}),
        ...(c.o.loopback ? { map: loopbackHttp } : {}),
      });
    } catch (e) {
      r.problems.push(`the broker didn't lead to Google (${safeMessage(e)})`);
      c.d.out(
        `dry run [${i + 1}/${flows.length}] ${flow}: PROBLEM: ${r.problems.join("; ")}`,
      );
      continue;
    }
    r.hd = url.searchParams.get("hd");
    const tenant = spec.user.split("@")[1] ?? "";
    if (url.origin !== c.idp) r.problems.push(`the URL is not on ${c.idp}`);
    if (foreign && r.hd !== null)
      r.problems.push("hd is present (it must be absent for this prompt)");
    if (!foreign && r.hd !== tenant)
      r.problems.push(`hd is ${r.hd ?? "absent"}, not ${tenant}`);
    const viaBroker = s.location.pathname === "/google/authorize";
    const bs = c.suite.capture.decodeBrokerState(
      url.searchParams.get("state") ?? "",
    );
    if (viaBroker && (bs?.i !== t.installId || bs?.s !== s.state))
      r.problems.push("the broker state doesn't name this install and start");
    const state = installStateOf(c, url);
    if (state !== s.state)
      r.problems.push("the armed state is not this start's");
    let chrome: Chrome | null = null;
    try {
      chrome = await launchChrome(c.o.chrome);
      c.d.onChrome?.(chrome);
      const armed = await armCallback(
        chrome,
        { origin: browserOriginOf(c, t), state },
        armOpts(c),
      );
      await armed.checkWebdriver();
      await armed.probe();
      if (armed.origin !== browserOriginOf(c, t) || armed.state !== s.state)
        r.problems.push("interception is not armed for this host and state");
      await armed.open(url.toString());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const got = await Promise.race([
        armed.landed.then(() => ({ k: "landed" as const })),
        armed.blocked.then((why) => ({ k: "blocked" as const, why })),
        new Promise<{ k: "timeout" }>((res) => {
          timer = setTimeout(() => res({ k: "timeout" }), 60_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (got.k === "blocked")
        r.problems.push(
          `${got.why}: Google refuses this browser (not a test failure)`,
        );
      if (got.k === "timeout")
        r.problems.push("Google's sign-in page did not load within 60 s");
      if (armed.counts.captured !== 0)
        r.problems.push("something was captured without a sign-in");
    } catch (e) {
      r.problems.push(`browser: ${safeMessage(e, 160)}`);
    } finally {
      await chrome?.close();
    }
    c.d.out(
      `dry run [${i + 1}/${flows.length}] ${flow} at ${t.name} as ${spec.user}: ` +
        (r.problems.length
          ? `PROBLEM: ${r.problems.join("; ")}`
          : `ok (hd ${r.hd ?? "absent, as it must be"}; interception armed for ${t.name}'s callback and this start's state; Google's sign-in page loaded; navigator.webdriver false)`),
    );
  }
  return out;
}

/** Directories this run made (removed on every exit path). */
const scratch = new Set<string>();

/** Synchronous cleanup for signal and exit paths. */
export function cleanupSync(): void {
  killAllChromesSync();
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
    scratch.delete(d);
  }
}

/** The whole one-shot: returns the exit code. */
export async function oneShot(argv: string[], d: OneShotDeps): Promise<number> {
  const parsed = parseOpts(argv);
  if (!parsed.ok) {
    d.out(`capture: ${parsed.why}\n${usage}`);
    return EXIT.refused;
  }
  const o = parsed.opts;
  const refuse = (lines: string[]) => {
    d.out("Refused before anything started:");
    for (const l of lines) d.out(`  - ${l}`);
    return EXIT.refused;
  };
  // (a) prerequisites. secretFileName is the suite's layout; until the
  // suite loads, the same rule (REDLINE_<NAME>_<KIND>).
  const fileName = (n: string, k: "PAT" | "HOOK_KEY") =>
    `REDLINE_${n.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${k}`;
  const p = prereqs(o, fileName, d.platform);
  let suite: Suite | null = null;
  try {
    suite = await loadSuite(o.suite, o.expectSha);
  } catch (e) {
    if (e instanceof BindingRefused) p.gaps.push(...e.gaps);
    else
      p.gaps.push(
        `the suite checkout's modules don't load (${safeMessage(e)})`,
      );
  }
  if (p.gaps.length || !suite || !p.raw) return refuse(p.gaps);
  d.out(
    `Suite: ${suite.dir} at ${suite.sha.slice(0, 12)} (clean); the verdicts bind to it.`,
  );

  // (b) the admin secrets.
  if (p.needCreds.length) {
    if (!(await makeCreds(o, p, d))) return EXIT.refused;
    const again = prereqs(o, suite.targets.secretFileName, d.platform);
    if (again.needCreds.length || again.gaps.length)
      return refuse([
        ...again.gaps,
        ...again.needCreds.map((n) => `${n.name}: admin secrets still missing`),
      ]);
  }

  // (c) the preflight, with the approved broker override built in.
  const local = p.raw.mode === "local";
  const env: Record<string, string | undefined> = {
    ...d.env,
    REDLINE_TARGETS: p.rawText,
    ...BROKER_OVERRIDE,
    ...(!local &&
    p.raw.deletedHosts === undefined &&
    !d.env.REDLINE_DELETED_HOSTS
      ? { REDLINE_DELETED_HOSTS: JSON.stringify(DEFAULT_DELETED_HOSTS) }
      : {}),
  };
  const idp = o.idp ?? GOOGLE_AUTH;
  const { checks, targets: T } = await suite.preflight.preflight(env, {
    ...(o.idp ? { idp: o.idp } : {}),
    ...(o.loopback ? { map: loopbackHttp } : {}),
  });
  d.out(`Preflight:\n${suite.preflight.formatPreflight(checks).trimEnd()}`);
  if (!T || suite.preflight.gaps(checks).length) return EXIT.refused;
  const ctx: Ctx = { o, d, suite, T, idp };

  if (o.dryRun) {
    const r = await dryRun(ctx);
    const bad = r.filter((x) => x.problems.length);
    d.out(
      bad.length
        ? `Dry run: ${bad.length} of ${r.length} prompts have problems (above).`
        : `Dry run green: all ${r.length} prompts reach Google's sign-in page with the right hint and an armed interception.`,
    );
    return bad.length ? EXIT.failed : EXIT.ok;
  }

  // (d) the capture, then the suite with --gate in the frozen checkout.
  const dir = mkdtempSync(join(tmpdir(), "oa-redline-signin-"));
  chmodSync(dir, 0o700);
  scratch.add(dir);
  const io = chromeIO(ctx);
  try {
    d.out(
      `${o.flows?.length ?? 5} Google sign-ins follow, each in a fresh Chrome window. Type only the test accounts' passwords.`,
    );
    const verdicts = await suite.capture.runCaptures(T, dir, io, {
      ...(o.idp ? { idp: o.idp } : {}),
      ...(o.loopback ? { map: loopbackHttp } : {}),
      ...(o.flows ? { flows: o.flows } : {}),
    });
    await io.shut();
    d.out("Captures done. The live suite runs now (with --gate).");
    return await runSuiteIn(
      suite.dir,
      {
        ...env,
        REDLINE_SIGNIN_CAPTURES: dir,
        REDLINE_CAPTURE_RUN: "1",
        REDLINE_CAPTURE_NONCE: verdicts.runNonce,
      },
      { gate: true, ...(d.onSuite ? { onChild: d.onSuite } : {}) },
    );
  } catch (e) {
    if (e instanceof GoogleBlocked) {
      d.out(e.message);
      return EXIT.googleBlocked;
    }
    d.out(`capture: ${safeMessage(e, 300)}`);
    return EXIT.stopped;
  } finally {
    await io.shut();
    rmSync(dir, { recursive: true, force: true });
    scratch.delete(dir);
  }
}
