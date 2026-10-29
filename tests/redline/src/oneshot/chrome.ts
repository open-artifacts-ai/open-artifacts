import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one-shot capture's browser (docs/ops/redline-signin.md). The person's
// own Google Chrome, started as a NORMAL process (no --enable-automation, no
// automation library launch), because Google refuses sign-in in a browser
// that looks automated ("This browser or app may not be secure"). Each
// prompt gets a fresh temporary profile, so one user's Google session never
// reaches the next prompt. The debugging port listens on 127.0.0.1 only, on
// a port Chrome picks.
//
// The driver speaks raw CDP over one WebSocket to the browser endpoint and
// uses ONLY Target and Fetch there. Fetch is enabled on the browser session
// itself, before the sign-in tab exists, so it sees every target's requests
// (the tab's first navigation, popups, service workers) and the sign-in tab
// needs no session at all: no Runtime, no Page, no init script, no
// user-agent override, not even a resume call. (Per-target Fetch after
// auto-attach with waitForDebuggerOnStart missed a new tab's first
// navigation on Chrome 156 in the rehearsal; the browser-level Fetch has
// nothing to race.) The tab is created with Target.createTarget(url).
// navigator.webdriver and the interception probe are checked in the
// throwaway first tab, never in the sign-in tab. The callback is held with
// Fetch at the Request stage, which
// pauses each redirect hop: the install callback arrives as the broker's 302
// target, its first request carrying this prompt's state is captured and
// failed in the browser, so the install never sees it and never retries (no
// r1. screen). Nothing reloads or revisits it: the browser is closed at once.

export const CHROME_MAC =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CALLBACK_PATH = "/auth/callback/google";
const PROFILE_PREFIX = "oa-capture-chrome-";
/** A probe state: never an install's (those are base64url, never this prefix). */
const PROBE_PREFIX = "oa-capture-probe.";

/** Google refused the automated browser: stop, never retry on our own. */
export class GoogleBlocked extends Error {
  override name = "GoogleBlocked";
}

/** Chrome reports navigator.webdriver: the launch looks automated. */
export class LooksAutomated extends Error {
  override name = "LooksAutomated";
}

export interface ChromeOpts {
  /** The Chrome binary (default the installed Google Chrome). */
  path?: string;
  /** Rehearsal only: --headless=new. Changes nothing else. */
  headless?: boolean;
  /** Bound on the launch and each CDP call (default 30 s). */
  timeoutMs?: number;
}

type Params = Record<string, unknown>;
type Listener = (method: string, params: Params, sessionId?: string) => void;

/** A minimal CDP client over one WebSocket (Node's built-in WebSocket). */
export class Cdp {
  /** Every command sent, by session (what a test checks: no Runtime on the sign-in tab). */
  readonly sent: { method: string; sessionId?: string }[] = [];
  private id = 0;
  private pending = new Map<
    number,
    { res: (v: Params) => void; rej: (e: Error) => void }
  >();
  private listeners = new Set<Listener>();
  private closed = false;
  private readonly ws: WebSocket;
  private readonly timeoutMs: number;

  private constructor(ws: WebSocket, timeoutMs: number) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    ws.addEventListener("message", (ev) => {
      let m: {
        id?: number;
        result?: Params;
        error?: { message?: string };
        method?: string;
        params?: Params;
        sessionId?: string;
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.rej(new Error(`CDP: ${m.error.message ?? "error"}`));
        else p?.res(m.result ?? {});
      } else if (m.method)
        for (const l of this.listeners)
          l(m.method, m.params ?? {}, m.sessionId);
    });
    ws.addEventListener("close", () => this.fail());
    ws.addEventListener("error", () => this.fail());
  }

  private fail() {
    this.closed = true;
    for (const p of this.pending.values()) p.rej(new Error("CDP: closed"));
    this.pending.clear();
  }

  static connect(url: string, timeoutMs = 30_000): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        rej(new Error("CDP: connect timeout"));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        res(new Cdp(ws, timeoutMs));
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        rej(new Error("CDP: connect failed"));
      });
    });
  }

  send<T = Params>(
    method: string,
    params: Params = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP: closed"));
    const id = ++this.id;
    this.sent.push({ method, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP: ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(t);
          res(v as T);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}

export interface Chrome {
  pid: number;
  port: number;
  /** The temporary profile (removed by close; it holds Google's session cookies). */
  profile: string;
  /** The browser-level CDP connection. */
  cdp: Cdp;
  /** Kills Chrome's process group, waits for it, removes the profile; safe twice. */
  close(): Promise<void>;
}

interface Live {
  proc: ChildProcess;
  profile: string;
}
/** Every Chrome this process started and hasn't closed (for exit paths). */
const live = new Set<Live>();

const groupKill = (pid: number | undefined, sig: NodeJS.Signals) => {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {}
};

/**
 * The synchronous last resort for exit paths (a signal, process.exit): kill
 * each live Chrome's process group (our own children only, by PID) and
 * remove its profile.
 */
export function killAllChromesSync(): void {
  for (const l of live) {
    groupKill(l.proc.pid, "SIGKILL");
    try {
      rmSync(l.profile, { recursive: true, force: true });
    } catch {}
    live.delete(l);
  }
}

/** Chromes started and not yet closed (pid and profile; tests). */
export const liveChromes = () =>
  [...live].map((l) => ({ pid: l.proc.pid, profile: l.profile }));

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

/** The exact Chrome arguments (exported for the doc and a test). */
export function chromeArgs(profile: string, headless = false): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    // Current Chrome sets navigator.webdriver whenever a debugging port is
    // open (no --enable-automation needed); this keeps it false, as in the
    // person's everyday browser (checked in the throwaway tab).
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

/** Starts Chrome on a fresh profile and connects raw CDP to its browser endpoint. */
export async function launchChrome(o: ChromeOpts = {}): Promise<Chrome> {
  const path = o.path ?? CHROME_MAC;
  if (!existsSync(path)) throw new Error(`Google Chrome is not at ${path}`);
  const timeoutMs = o.timeoutMs ?? 30_000;
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  // Its own process group, so close() reaches every helper (by our PID).
  const proc = spawn(path, chromeArgs(profile, o.headless), {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const entry: Live = { proc, profile };
  live.add(entry);
  const exited = new Promise<void>((r) => {
    if (proc.exitCode !== null || proc.signalCode !== null) r();
    else proc.once("exit", () => r());
  });
  let cdp: Cdp | null = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    cdp?.close();
    // SIGTERM the group, SIGKILL after a bound, wait for every process of
    // the group (helpers can outlive the main one and write into the
    // profile), then remove the profile.
    groupKill(proc.pid, "SIGTERM");
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((r) => {
        t = setTimeout(r, 5_000);
      }),
    ]);
    clearTimeout(t);
    if (!(await groupGone(proc.pid, 5_000))) {
      groupKill(proc.pid, "SIGKILL");
      await groupGone(proc.pid, 5_000);
    }
    rmSync(profile, { recursive: true, force: true });
    live.delete(entry);
  };
  try {
    // Chrome prints its CDP endpoint on stderr once it listens: the signal.
    const ws = await new Promise<string>((res, rej) => {
      let buf = "";
      const timer = setTimeout(
        () => rej(new Error("Chrome did not open its debugging port in time")),
        timeoutMs,
      );
      proc.once("exit", () => {
        clearTimeout(timer);
        rej(new Error("Chrome exited at launch"));
      });
      proc.once("error", (e) => {
        clearTimeout(timer);
        rej(e);
      });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (d: string) => {
        buf += d;
        const m = /listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          buf = "";
          res(m[1] as string);
        } else if (buf.length > 65_536) buf = buf.slice(-4096);
      });
    });
    // Keep draining stderr so Chrome never blocks on a full pipe.
    proc.stderr?.removeAllListeners("data");
    proc.stderr?.resume();
    const u = new URL(ws);
    if (u.hostname !== "127.0.0.1")
      throw new Error("Chrome's debugging port is not on 127.0.0.1 only");
    cdp = await Cdp.connect(ws, timeoutMs);
    return {
      pid: proc.pid as number,
      port: Number(u.port),
      profile,
      cdp,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

export interface ArmSpec {
  /** The install's callback origin as the browser sees it (https). */
  origin: string;
  /** This prompt's install state (never an r1. retry's). */
  state: string;
}

export type Judged = "capture" | "probe" | "pass";

/**
 * What the interceptor does with a request: "capture" only for this
 * install's callback path carrying exactly this prompt's state, "probe" for
 * the arming probe, else "pass". Another host, another path, another state
 * and any r1. retry are never captured.
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

/** CDP urlPattern: escape the wildcard characters and the escape itself. */
export const patternOf = (s: string) => s.replace(/[\\*?]/g, (c) => `\\${c}`);

/** Google's block pages, by path. */
const BLOCK_PATHS = [
  /\/signin\/rejected/i,
  /\/deniedsigninrejected/i,
  /\/signin\/v2\/deniedsignin/i,
  /\/signin\/unsupported/i,
];
/** Google's block pages, by text (the dry run's and tests' check). */
const BLOCK_TEXT = [
  /this browser or app may not be secure/i,
  /couldn.t sign you in/i,
  /unsupported browser/i,
  /browser (?:is|isn.t|is not) (?:not )?supported/i,
  /try using a different browser/i,
];

/**
 * A Google automation or unsupported-browser block, from a page's URL (and
 * its text, when known): a short reason, or null. Only pages on the IdP's
 * origin count. The sign-in tab is judged by URL only: reading its text
 * would need Runtime there.
 */
export function blockedBy(
  url: string,
  text: string,
  idp: string,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== idp) return null;
  if (BLOCK_PATHS.some((r) => r.test(u.pathname)))
    return `Google's block page (${u.pathname})`;
  const hit = BLOCK_TEXT.find((r) => r.test(text));
  return hit ? `Google says "${(hit.exec(text) as RegExpExecArray)[0]}"` : null;
}

export interface ArmOpts {
  /** The IdP's origin: its documents are watched for a block page. */
  idp: string;
  /**
   * Rehearsal only: answers browser requests for these hosts from node
   * (loopback http) instead of the network, as the local pair's https
   * origins speak http. Never set on staging.
   */
  proxy?: { pattern: string; map: (u: URL) => URL };
}

export interface Armed extends ArmSpec {
  /** The captured callback URL (as the browser requested it); never logged. */
  captured: Promise<string>;
  /** Resolves with the reason once a Google block page shows. */
  blocked: Promise<string>;
  /** Resolves once an html 2xx IdP page (the sign-in page) arrived in the sign-in tab. */
  landed: Promise<void>;
  /** Paused requests (no URLs). */
  counts: {
    captured: number;
    passed: number;
    probes: number;
    /** Captures that arrived as a redirect hop (the broker's 302 target). */
    viaRedirect: number;
  };
  /** The sign-in tab (after open). The driver holds no session on it. */
  signIn: { targetId: string } | null;
  /** The driver's only page session: the throwaway first tab's. */
  throwawaySessionId: string;
  /** In the throwaway tab: navigator.webdriver is false. */
  checkWebdriver(): Promise<void>;
  /** Sends a probe callback from the throwaway tab; resolves once it was held. */
  probe(): Promise<void>;
  /** Opens the sign-in tab at `url` (Target.createTarget) and closes the throwaway tab. */
  open(url: string): Promise<void>;
  /** Resolves once `n` callback-pattern requests were answered (tests). */
  untilJudged(n: number): Promise<void>;
  /** Resolves with the verdict on the next request for exactly `url` (tests). */
  verdictOf(url: string): Promise<Judged>;
}

const race = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(what)), ms);
    }),
  ]).finally(() => clearTimeout(t));
};

const debug = (s: string) => {
  if (process.env.OA_CAPTURE_DEBUG === "1") console.error(`[cdp] ${s}`);
};

/**
 * Arms the browser: Fetch on the BROWSER session (before any sign-in tab
 * exists, so not even a new tab's first navigation, a popup's or a service
 * worker's request slips past), and the request handler. The first
 * callback request carrying this prompt's state is captured and failed;
 * later ones for the same state are failed too, so a code is never spent
 * by the browser. The only page session the driver opens is on the
 * throwaway first tab (webdriver check, probe).
 */
export async function armCallback(
  c: Chrome,
  spec: ArmSpec,
  o: ArmOpts,
): Promise<Armed> {
  const cdp = c.cdp;
  const probeState = `${PROBE_PREFIX}${randomBytes(12).toString("base64url")}`;
  const a = { ...spec, probe: probeState };
  const counts = { captured: 0, passed: 0, probes: 0, viaRedirect: 0 };
  const deferred = <T>() => {
    let res!: (v: T) => void;
    const p = new Promise<T>((r) => {
      res = r;
    });
    return { p, res };
  };
  const captured = deferred<string>();
  const blocked = deferred<string>();
  const landed = deferred<void>();
  const probed = deferred<void>();
  const judgedWaiters = new Set<{ n: number; res: () => void }>();
  const verdictWaiters = new Map<string, (j: Judged) => void>();
  const patterns = [
    {
      urlPattern: `${patternOf(spec.origin)}${CALLBACK_PATH}*`,
      requestStage: "Request",
    },
    // The IdP's responses: a block page, or the sign-in page.
    { urlPattern: `${patternOf(o.idp)}/*`, requestStage: "Response" },
    ...(o.proxy
      ? [{ urlPattern: o.proxy.pattern, requestStage: "Request" }]
      : []),
  ];
  /** The throwaway tab (its main frame id is its target id). */
  let throwaway = "";
  let signIn: Armed["signIn"] = null;

  const answer = (method: string, params: Params) =>
    cdp.send(method, params).catch(() => ({}));

  const onPaused = async (p: Params) => {
    const id = p.requestId as string;
    const req = p.request as { url: string; method: string };
    const url = req.url;
    const fromThrowaway = throwaway !== "" && p.frameId === throwaway;
    try {
      const u = new URL(url);
      debug(
        `paused ${p.resourceType} ${p.responseStatusCode ?? "req"} ${u.origin}${u.pathname}${fromThrowaway ? " (throwaway)" : ""}`,
      );
      if (typeof p.responseStatusCode === "number" || p.responseErrorReason) {
        // An IdP response.
        const nav = p.resourceType === "Document" || p.resourceType === "Other";
        const headers =
          (p.responseHeaders as
            | { name: string; value: string }[]
            | undefined) ?? [];
        const html = headers.some(
          (h) =>
            h.name.toLowerCase() === "content-type" &&
            /text\/html/i.test(h.value),
        );
        const why = nav ? blockedBy(url, "", o.idp) : null;
        if (why && !fromThrowaway) blocked.res(why);
        const st = p.responseStatusCode as number | undefined;
        if (
          nav &&
          html &&
          !why &&
          !fromThrowaway &&
          st &&
          st >= 200 &&
          st < 300
        )
          landed.res();
        await answer(
          st !== undefined ? "Fetch.continueResponse" : "Fetch.continueRequest",
          { requestId: id },
        );
        return;
      }
      const j = judge(url, a);
      const vw = verdictWaiters.get(url);
      if (vw) {
        verdictWaiters.delete(url);
        vw(j);
      }
      if (j === "probe") {
        counts.probes++;
        await answer("Fetch.failRequest", {
          requestId: id,
          errorReason: "BlockedByClient",
        });
        probed.res();
        return;
      }
      if (j === "capture") {
        counts.captured++;
        if (counts.captured === 1 && p.redirectedRequestId)
          counts.viaRedirect++;
        await answer("Fetch.failRequest", {
          requestId: id,
          errorReason: "BlockedByClient",
        });
        if (counts.captured === 1) captured.res(url);
        return;
      }
      counts.passed++;
      const mapped = o.proxy ? o.proxy.map(u) : u;
      if (o.proxy && mapped.href !== u.href) {
        const res = await fetch(mapped, {
          method: req.method,
          redirect: "manual",
        });
        const body = Buffer.from(await res.arrayBuffer());
        const responseHeaders: { name: string; value: string }[] = [];
        res.headers.forEach((value, name) => {
          if (name !== "set-cookie") responseHeaders.push({ name, value });
        });
        for (const v of res.headers.getSetCookie())
          responseHeaders.push({ name: "set-cookie", value: v });
        await answer("Fetch.fulfillRequest", {
          requestId: id,
          responseCode: res.status,
          responseHeaders,
          body: body.toString("base64"),
        });
        return;
      }
      await answer("Fetch.continueRequest", { requestId: id });
    } catch {
      await answer("Fetch.continueRequest", { requestId: id });
    } finally {
      const total = counts.captured + counts.passed + counts.probes;
      for (const w of [...judgedWaiters])
        if (total >= w.n) {
          judgedWaiters.delete(w);
          w.res();
        }
    }
  };

  cdp.on((method, params, sessionId) => {
    if (method === "Fetch.requestPaused" && !sessionId) void onPaused(params);
    else if (method === "Target.targetInfoChanged") {
      const ti = params.targetInfo as { targetId: string; url: string };
      if (throwaway && ti.targetId !== throwaway) {
        const why = blockedBy(ti.url, "", o.idp);
        if (why) blocked.res(why);
      }
    }
  });
  // Target-info events (URLs) for the block watch; Fetch for everything.
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Fetch.enable", { patterns });
  // The tab Chrome opened (about:blank): the throwaway tab.
  const { targetInfos } = await cdp.send<{
    targetInfos: { targetId: string; type: string }[];
  }>("Target.getTargets");
  const blank = targetInfos.find((t) => t.type === "page");
  if (!blank) throw new Error("Chrome has no first tab");
  throwaway = blank.targetId;
  const { sessionId: throwawaySessionId } = await cdp.send<{
    sessionId: string;
  }>("Target.attachToTarget", { targetId: blank.targetId, flatten: true });

  return {
    ...spec,
    captured: captured.p,
    blocked: blocked.p,
    landed: landed.p,
    counts,
    throwawaySessionId,
    get signIn() {
      return signIn;
    },
    async checkWebdriver() {
      const r = await cdp.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "navigator.webdriver", returnByValue: true },
        throwawaySessionId,
      );
      if (r.result.value !== false)
        throw new LooksAutomated(
          "Chrome reports navigator.webdriver: this launch looks automated to Google",
        );
    },
    async probe() {
      const u = new URL(CALLBACK_PATH, spec.origin);
      u.searchParams.set("state", probeState);
      // A navigation in a tab of its own, as the real callback is (the
      // browser-level Fetch holds navigations), closed once held.
      const { targetId } = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url: u.href },
      );
      try {
        await race(
          probed.p,
          10_000,
          "the callback interceptor did not hold its probe",
        );
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => 0);
      }
    },
    verdictOf(url: string) {
      return race(
        new Promise<Judged>((res) => verdictWaiters.set(url, res)),
        30_000,
        "that request was not judged in time",
      );
    },
    untilJudged(n: number) {
      const total = counts.captured + counts.passed + counts.probes;
      if (total >= n) return Promise.resolve();
      return race(
        new Promise<void>((res) => judgedWaiters.add({ n, res })),
        30_000,
        `requests were not judged in time (want ${n}, have ${JSON.stringify(counts)})`,
      );
    },
    async open(url: string) {
      const { targetId } = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url },
      );
      signIn = { targetId };
      // The throwaway tab goes; the sign-in tab is the only one left.
      await cdp
        .send("Target.closeTarget", { targetId: blank.targetId })
        .catch(() => 0);
    },
  };
}
