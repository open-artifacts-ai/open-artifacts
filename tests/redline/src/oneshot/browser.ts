import { type ChildProcess, spawn } from "node:child_process";
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
// reports the blocked URL and the IdP's page URLs to this script's 127.0.0.1
// listener with a per-run token, and clears the IdP's cookies and storage
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
 * Rehearsal only (`--rehearsal-chromium`): Chrome for Testing loads the
 * extension from the command line (branded Chrome ignores that switch
 * since 137), runs headless, and opens a debugging port for the
 * TEST's harness (the stand-in person). The script never connects to it.
 */
export function rehearsalArgs(ext: string, withExtension = true): string[] {
  return [
    ...(withExtension
      ? [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`]
      : []),
    "--headless=new",
    "--remote-debugging-port=0",
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
async function groupGone(pid: number | undefined, ms: number): Promise<boolean> {
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

/** Google's block pages (automation, unsupported browser, OAuth errors), by path. */
const BLOCK_PATHS = [
  /\/signin\/rejected/i,
  /\/deniedsigninrejected/i,
  /\/signin\/v2\/deniedsignin/i,
  /\/signin\/unsupported/i,
  /\/signin\/oauth\/error/i,
];

/** A Google block page, from its URL on the IdP's origin: a short reason, or null. */
export function blockedBy(url: string, idp: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== idp) return null;
  if (!BLOCK_PATHS.some((r) => r.test(u.pathname))) return null;
  const err = u.searchParams.get("authError") ?? u.searchParams.get("error");
  const code = err && /^[A-Za-z0-9_]{1,40}$/.test(err) ? `, ${err}` : "";
  return `Google's block page (${u.pathname}${code})`;
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

export interface Report {
  kind: "blocked" | "idp";
  url: string;
  phase?: "request" | "completed";
  status?: number;
}

type Command = { cmd: "clear" } | { cmd: "open"; url: string };

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
  private poll: { res: ServerResponse; t: ReturnType<typeof setTimeout> } | null =
    null;
  private acks = new Map<number, (ok: boolean) => void>();
  private subs = new Set<(r: Report) => void>();
  private nextId = 1;
  private hellos: (() => void)[] = [];

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
    if (req.method !== "POST") return this.reply(res, 405, {});
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
      if (path === "/blocked" || path === "/idp") {
        if (typeof m.url === "string") {
          const r: Report =
            path === "/blocked"
              ? { kind: "blocked", url: m.url }
              : {
                  kind: "idp",
                  url: m.url,
                  phase: m.phase === "completed" ? "completed" : "request",
                  status: typeof m.status === "number" ? m.status : 0,
                };
          for (const s of this.subs) s(r);
        }
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
  /** Resolves with the reason once the IdP shows a block page. */
  blocked: Promise<string>;
  /** Resolves with the URL of the first completed 2xx IdP page (the sign-in page). */
  landed: Promise<string>;
  probed: Promise<void>;
  probeUrl: string;
  counts: { captured: number; passed: number; probes: number };
  off(): void;
}

/** Arms one prompt on the listener's reports. */
export function armPrompt(
  L: Listener,
  spec: ArmSpec,
  o: { idp: string },
): Armed {
  const probe = `${PROBE_PREFIX}${randomBytes(12).toString("base64url")}`;
  const a = { ...spec, probe };
  const captured = deferred<string>();
  const blocked = deferred<string>();
  const landed = deferred<string>();
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
    const why = blockedBy(r.url, o.idp);
    if (why) blocked.res(why);
    else if (
      r.phase === "completed" &&
      (r.status ?? 0) >= 200 &&
      (r.status ?? 0) < 300
    )
      landed.res(r.url);
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
 * 127.0.0.1 for the listener, the IdP for its page URLs), rules.json (the
 * callback block) and config.js (listener, token, patterns).
 */
export function writeExtension(dir: string, c: ExtensionConfig): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(join(EXTENSION_SRC, "background.js"), join(dir, "background.js"));
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
        resourceTypes: ["main_frame", "sub_frame"],
      },
    })),
    ...(c.loopback
      ? [
          {
            id: 100,
            priority: 1,
            action: { type: "redirect", redirect: { transform: { scheme: "http" } } },
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
    clearOrigins: c.clearOrigins,
  };
  const w = (f: string, s: string) =>
    writeFileSync(join(dir, f), s, { mode: 0o600 });
  w("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  w("rules.json", `${JSON.stringify(rules, null, 2)}\n`);
  w("config.js", `self.OA_CAPTURE = ${JSON.stringify(config)};\n`);
}
