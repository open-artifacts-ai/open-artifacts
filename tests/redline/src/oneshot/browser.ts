import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";

// The one-shot capture's browser (docs/ops/redline-signin.md): the person's
// PLAIN Google Chrome on a temporary profile, with no debugging port and no
// automation or blink flags, and a small extension (capture-extension/)
// they load by hand once per run. The extension blocks the installs'
// callback with declarativeNetRequest (so the browser never spends a code),
// reports the blocked URL to this script's 127.0.0.1 listener with a
// per-run token (for Google's pages it sends only a classification:
// sign-in page or block page, and the hd hint), and clears Google's cookies and storage
// before each prompt. The script accepts only this prompt's host and state,
// once.

export const CHROME_MAC =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CALLBACK_PATH = "/auth/callback/google";
export const EXTENSION_SRC = join(
  import.meta.dirname,
  "..",
  "..",
  "capture-extension",
);
/** Where the person loads the extension (the first tab). */
export const EXTENSIONS_PAGE = "chrome://extensions/";
/** A probe state: never an install's (those are base64url, never this prefix). */
const PROBE_PREFIX = "oa-capture-probe.";

/** Google refused the browser: stop, never retry on our own. */
export class GoogleBlocked extends Error {
  override name = "GoogleBlocked";
}

/**
 * The exact Chrome arguments: a profile, no first-run screens, a URL.
 * Nothing else (a unit test asserts this argv).
 */
export function chromeArgs(profile: string, url: string): string[] {
  return [`--user-data-dir=${profile}`, "--no-first-run", url];
}

/**
 * Rehearsal only (`--rehearsal-harness`): the same installed Chrome,
 * headless, with a debugging port for the TEST's harness, which stands in
 * for the person: it does "Load unpacked" (CDP Extensions.loadUnpacked,
 * which needs the unsafe-extension-debugging switch) and types into the
 * fake IdP's form. The script never connects to that port.
 */
export function rehearsalArgs(): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging",
  ];
}

export interface Chrome {
  pid: number;
  profile: string;
  /** Resolves when the Chrome process exits (a crash, or the person quitting it). */
  exited: Promise<void>;
  alive(): boolean;
  /** Kills Chrome's process group and waits for it; safe to call twice. */
  close(): Promise<void>;
}

const live = new Set<ChildProcess>();

const groupKill = (pid: number | undefined, sig: NodeJS.Signals) => {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {}
};

/** Synchronous last resort for exit paths: kill each Chrome group we spawned. */
export function killAllChromesSync(): void {
  for (const p of live) {
    groupKill(p.pid, "SIGKILL");
    live.delete(p);
  }
}

export const liveChromes = () => [...live].map((p) => p.pid as number);

/** True once no process is left in the group (a bounded wait on that condition). */
async function groupGone(
  pid: number | undefined,
  ms: number,
): Promise<boolean> {
  if (!pid) return true;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = Date.now() + ms;
  while (alive()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * The process groups of the processes (other than this one) holding a
 * local TCP endpoint on `port`: who is at the other end of a connection to
 * the listener. Read with lsof and ps; empty when unknown.
 */
export function groupsOnPort(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0) return [];
  try {
    const pids = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter((l) => l.startsWith("p"))
      .map((l) => Number(l.slice(1)))
      .filter((p) => p !== process.pid);
    if (!pids.length) return [];
    return execFileSync("/bin/ps", ["-o", "pgid=", "-p", pids.join(",")], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

/** Starts Chrome (its own process group, so we can quit all of it by our PID). */
export function launchChrome(o: {
  path?: string;
  profile: string;
  url: string;
  /** Rehearsal only: rehearsalArgs(). */
  extra?: string[];
}): Chrome {
  const path = o.path ?? CHROME_MAC;
  if (!existsSync(path)) throw new Error(`Google Chrome is not at ${path}`);
  const proc = spawn(
    path,
    [...(o.extra ?? []), ...chromeArgs(o.profile, o.url)],
    { detached: true, stdio: "ignore" },
  );
  live.add(proc);
  let gone = false;
  const exited = new Promise<void>((r) => {
    proc.once("exit", () => {
      gone = true;
      r();
    });
    proc.once("error", () => {
      gone = true;
      r();
    });
  });
  let closing: Promise<void> | null = null;
  return {
    pid: proc.pid as number,
    profile: o.profile,
    exited,
    alive: () => !gone,
    close() {
      closing ??= (async () => {
        groupKill(proc.pid, "SIGTERM");
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((r) => {
            t = setTimeout(r, 5_000);
          }),
        ]);
        clearTimeout(t);
        // Helpers can outlive the main process for a moment.
        if (!(await groupGone(proc.pid, 5_000))) {
          groupKill(proc.pid, "SIGKILL");
          await groupGone(proc.pid, 5_000);
        }
        live.delete(proc);
      })();
      return closing;
    },
  };
}

/**
 * Google's block pages (automation, unsupported browser, OAuth errors such
 * as disallowed_useragent), as path regex sources. The extension's
 * classifier (capture-extension/classify.js) applies them; the script only
 * ever hears "block".
 */
export const BLOCK_PATTERNS = [
  "/signin/rejected",
  "/deniedsigninrejected",
  "/signin/v2/deniedsignin",
  "/signin/unsupported",
  "/signin/oauth/error",
];

/** What the script is told about a Google page: a classification, never a URL. */
export interface GoogleSeen {
  prompt: string;
  google: "signin" | "block";
  hd: string | null;
}

const PROMPT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HD = /^[a-z0-9.-]{1,253}$/;

/** A /google payload's fields, or null if it holds anything else. */
export function googleSeen(m: Record<string, unknown>): GoogleSeen | null {
  const keys = Object.keys(m)
    .filter((k) => k !== "token")
    .sort();
  if (keys.join(",") !== "google,hd,prompt") return null;
  if (typeof m.prompt !== "string" || !PROMPT_ID.test(m.prompt)) return null;
  if (m.google !== "signin" && m.google !== "block") return null;
  if (m.hd !== null && (typeof m.hd !== "string" || !HD.test(m.hd)))
    return null;
  return { prompt: m.prompt, google: m.google, hd: m.hd as string | null };
}

export interface ArmSpec {
  /** The install's callback origin as the browser sees it (https). */
  origin: string;
  /** This prompt's install state (never an r1. retry's). */
  state: string;
}

export type Judged = "capture" | "probe" | "pass";

/**
 * What the script does with a reported callback: "capture" only for this
 * install's callback path carrying exactly this prompt's state, "probe" for
 * the arming probe, else "pass" (ignored). Another host, another path,
 * another state and any r1. retry are never captured.
 */
export function judge(url: string, a: ArmSpec & { probe: string }): Judged {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "pass";
  }
  if (u.origin !== a.origin || u.pathname !== CALLBACK_PATH) return "pass";
  const state = u.searchParams.get("state") ?? "";
  if (state === a.probe) return "probe";
  if (!state || state.startsWith("r1.") || state !== a.state) return "pass";
  return "capture";
}

export type Report =
  /** An install callback the extension blocked: its URL (the script needs the code). */
  | { kind: "blocked"; url: string }
  /** A Google page in a prompt's tab: a classification only. */
  | ({ kind: "google" } & GoogleSeen);

type Command = { cmd: "clear" } | { cmd: "open"; url: string; prompt?: string };

const deferred = <T>() => {
  let res!: (v: T) => void;
  const p = new Promise<T>((r) => {
    res = r;
  });
  return { p, res };
};

/**
 * The script's end of the extension: an HTTP listener on 127.0.0.1 (a port
 * the OS picks). Every request must carry this run's token; anything else
 * is refused (403) and changes nothing. Commands go out by long poll.
 */
export class Listener {
  readonly token = randomBytes(32).toString("base64url");
  port = 0;
  /** Resolves on the extension's first request with this run's token. */
  readonly checkedIn: Promise<void>;
  /** Requests refused for a bad or missing token (no detail kept). */
  refused = 0;
  private checkIn = deferred<void>();
  private server: Server;
  private queue: (Command & { id: number })[] = [];
  private poll: {
    res: ServerResponse;
    t: ReturnType<typeof setTimeout>;
  } | null = null;
  private acks = new Map<number, (ok: boolean) => void>();
  private subs = new Set<(r: Report) => void>();
  private nextId = 1;
  private hellos: (() => void)[] = [];
  /** Tests: every token-bearing request's path and raw body. */
  tap?: (path: string, body: string) => void;
  /** Accepts a connection only from our own Chrome (by its local port). */
  verify?: (remotePort: number) => boolean | "unknown";
  /** A request from a process that isn't our Chrome (refused). */
  onForeign?: () => void;
  foreign = 0;
  private verified = new Map<number, boolean | "unknown">();

  /** Resolves on the extension's next check-in (/hello with this run's token). */
  nextHello(): Promise<void> {
    return new Promise((r) => this.hellos.push(r));
  }

  constructor() {
    this.checkedIn = this.checkIn.p;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  start(): Promise<void> {
    return new Promise((r) =>
      this.server.listen(0, "127.0.0.1", () => {
        const a = this.server.address();
        this.port = typeof a === "object" && a ? a.port : 0;
        r();
      }),
    );
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private ok(t: unknown): boolean {
    if (typeof t !== "string") return false;
    const a = Buffer.from(t);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private reply(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    if (process.env.OA_CAPTURE_DEBUG === "1")
      console.error(
        `[listener] ${req.method} ${(req.url ?? "").split("?")[0]}`,
      );
    // POST only; no CORS headers (the extension's host permission needs none).
    if (req.method !== "POST") return this.reply(res, 405, {});
    // Only the Chrome this command started may talk to it (a copy loaded in
    // the person's own Chrome must never get a "clear").
    const port = req.socket.remotePort ?? 0;
    if (this.verify) {
      let ok = this.verified.get(port);
      if (ok === undefined) {
        ok = this.verify(port);
        this.verified.set(port, ok);
        req.socket.once("close", () => this.verified.delete(port));
      }
      if (ok !== true) {
        // "unknown": the sender is gone (a closed Chrome): refused, not "another Chrome".
        if (ok === false) {
          this.foreign++;
          this.onForeign?.();
        }
        return this.reply(res, 403, {});
      }
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => {
      body += d;
      if (body.length > 65_536) req.destroy();
    });
    req.on("end", () => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(body) as Record<string, unknown>;
      } catch {
        m = {};
      }
      if (!this.ok(m.token)) {
        this.refused++;
        return this.reply(res, 403, {});
      }
      this.checkIn.res();
      const path = (req.url ?? "").split("?")[0];
      if (path === "/hello") {
        for (const h of this.hellos.splice(0)) h();
        return this.reply(res, 200, {});
      }
      if (path === "/next") return this.next(res);
      if (path === "/ack") {
        const id = typeof m.id === "number" ? m.id : -1;
        this.acks.get(id)?.(m.ok === true);
        this.acks.delete(id);
        return this.reply(res, 200, {});
      }
      this.tap?.(path ?? "", body);
      if (path === "/blocked") {
        if (typeof m.url === "string")
          for (const s of this.subs) s({ kind: "blocked", url: m.url });
        return this.reply(res, 200, {});
      }
      if (path === "/google") {
        // A classification only: anything else (a URL, a path) is refused.
        const g = googleSeen(m);
        if (!g) return this.reply(res, 400, {});
        for (const s of this.subs) s({ kind: "google", ...g });
        return this.reply(res, 200, {});
      }
      return this.reply(res, 404, {});
    });
  }

  private next(res: ServerResponse) {
    const c = this.queue.shift();
    if (c) return this.reply(res, 200, c);
    if (this.poll) {
      clearTimeout(this.poll.t);
      this.reply(this.poll.res, 200, { cmd: "none" });
    }
    const t = setTimeout(() => {
      if (this.poll?.res === res) this.poll = null;
      this.reply(res, 200, { cmd: "none" });
    }, 15_000);
    this.poll = { res, t };
  }

  /** Sends a command; resolves with the extension's ok, or false after `ms`. */
  command(c: Command, ms = 30_000): Promise<boolean> {
    const id = this.nextId++;
    const done = new Promise<boolean>((r) => {
      const t = setTimeout(() => {
        this.acks.delete(id);
        r(false);
      }, ms);
      this.acks.set(id, (ok) => {
        clearTimeout(t);
        r(ok);
      });
    });
    const p = this.poll;
    if (p) {
      this.poll = null;
      clearTimeout(p.t);
      this.reply(p.res, 200, { ...c, id });
    } else this.queue.push({ ...c, id });
    return done;
  }

  on(fn: (r: Report) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  close(): Promise<void> {
    if (this.poll) {
      clearTimeout(this.poll.t);
      this.poll = null;
    }
    return new Promise((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
}

export interface Armed extends ArmSpec {
  /** The captured callback URL (as the browser requested it); never logged. */
  captured: Promise<string>;
  /** Resolves once the extension classifies this prompt's tab as a Google block page. */
  blocked: Promise<string>;
  /** Resolves with the hd hint once this prompt's tab shows the sign-in page. */
  landed: Promise<string | null>;
  probed: Promise<void>;
  probeUrl: string;
  /** This prompt's id: its tab's classifications carry it. */
  prompt: string;
  counts: { captured: number; passed: number; probes: number };
  off(): void;
}

/** Arms one prompt on the listener's reports. */
export function armPrompt(L: Listener, spec: ArmSpec): Armed {
  const probe = `${PROBE_PREFIX}${randomBytes(12).toString("base64url")}`;
  const prompt = `p-${randomBytes(9).toString("base64url")}`;
  const a = { ...spec, probe };
  const captured = deferred<string>();
  const blocked = deferred<string>();
  const landed = deferred<string | null>();
  const probed = deferred<void>();
  const counts = { captured: 0, passed: 0, probes: 0 };
  const off = L.on((r) => {
    if (r.kind === "blocked") {
      const j = judge(r.url, a);
      if (j === "probe") {
        counts.probes++;
        probed.res();
      } else if (j === "capture") {
        counts.captured++;
        if (counts.captured === 1) captured.res(r.url);
      } else counts.passed++;
      return;
    }
    if (r.prompt !== prompt) return;
    if (r.google === "block") blocked.res("Google showed its block page");
    else landed.res(r.hd);
  });
  const u = new URL(CALLBACK_PATH, spec.origin);
  u.searchParams.set("state", probe);
  return {
    ...spec,
    captured: captured.p,
    blocked: blocked.p,
    landed: landed.p,
    probed: probed.p,
    probeUrl: u.href,
    prompt,
    counts,
    off,
  };
}

const matchOf = (origin: string, path = "/*") => {
  const u = new URL(origin);
  // Match patterns without a port match every port.
  return `${u.protocol}//${u.hostname}${path}`;
};

export interface ExtensionConfig {
  /** The installs' callback origins as the browser sees them. */
  installs: string[];
  listener: string;
  token: string;
  /** The IdP's origin (Google's; the fake's in the rehearsal). */
  idp: string;
  /** Origins whose cookies and storage are cleared before each prompt. */
  clearOrigins: string[];
  /** Rehearsal only: https *.localhost is answered over http. */
  loopback?: boolean;
}

/** Google's cookie and storage origins, cleared before each prompt. */
export const GOOGLE_CLEAR = [
  "https://accounts.google.com",
  "https://www.google.com",
  "https://google.com",
];

/**
 * Writes this run's copy of the extension into `dir`: background.js, and
 * the generated manifest.json (host permissions: the two install origins,
 * 127.0.0.1 for the listener, the IdP to classify its pages), rules.json (the
 * callback block) and config.js (listener, token, patterns).
 */
export function writeExtension(dir: string, c: ExtensionConfig): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["background.js", "classify.js"])
    copyFileSync(join(EXTENSION_SRC, f), join(dir, f));
  const hosts = [
    ...c.installs.map((o) => matchOf(o)),
    "http://127.0.0.1/*",
    matchOf(c.idp),
    ...(c.loopback ? ["https://*.localhost/*"] : []),
  ];
  const manifest = {
    manifest_version: 3,
    name: "Open Artifacts red-line capture",
    version: "1.0.0",
    description:
      "Holds the red-line sign-in callbacks for the capture script on this Mac (temporary profile only).",
    background: { service_worker: "background.js" },
    permissions: ["declarativeNetRequest", "webRequest", "browsingData"],
    host_permissions: [...new Set(hosts)],
    declarative_net_request: {
      rule_resources: [{ id: "callbacks", enabled: true, path: "rules.json" }],
    },
  };
  const rules = [
    ...c.installs.map((o, i) => ({
      id: i + 1,
      priority: 2,
      action: { type: "block" },
      condition: {
        urlFilter: `|${new URL(o).origin}${CALLBACK_PATH}`,
        resourceTypes: ["main_frame"],
      },
    })),
    ...(c.loopback
      ? [
          {
            id: 100,
            priority: 1,
            action: {
              type: "redirect",
              redirect: { transform: { scheme: "http" } },
            },
            condition: {
              regexFilter: "^https://[^/]*\\.localhost[:/]",
              resourceTypes: ["main_frame"],
            },
          },
        ]
      : []),
  ];
  const config = {
    listener: c.listener,
    token: c.token,
    callbackPatterns: c.installs.map((o) => matchOf(o, `${CALLBACK_PATH}*`)),
    idpPatterns: [matchOf(c.idp)],
    idp: new URL(c.idp).origin,
    blockPatterns: BLOCK_PATTERNS,
    clearOrigins: c.clearOrigins,
  };
  const w = (f: string, s: string) =>
    writeFileSync(join(dir, f), s, { mode: 0o600 });
  w("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  w("rules.json", `${JSON.stringify(rules, null, 2)}\n`);
  w("config.js", `self.OA_CAPTURE = ${JSON.stringify(config)};\n`);
}
