import { LIMITS } from "@oa/shared";
import {
  CAPTURE_HEADER,
  signCapture,
  signContent,
} from "../content/signing.js";
import type { Env } from "../env.js";
import { contentOrigin } from "../http/errors.js";
import { logError } from "../log.js";
import { decodeBase64 } from "../util/base64.js";
import { type Cdp, connectCdp, LaunchError } from "./cdp.js";

// Server-side thumbnails (spec §6.9 stretch) through Browser Run, run from the
// artifact DO's alarm (runtime/do.ts), never on a request, and strictly
// best-effort: the client upload (PUT /thumbnail) stays the fallback. Without a
// BROWSER binding, past the day's stop, or when a capture fails, nothing here
// writes anything. Both paths store through writeThumbnail, which keeps the
// stored thumbnail at the newest version written.

export const THUMB = {
  /**
   * The viewport and image size: the client's (packages/runtime snapshot.ts
   * WIDTH × HEIGHT), so server and client thumbnails look alike. `scale` 1:
   * a full-size image costs no measurable CPU over 0.5 (bench-thumbs.ts).
   */
  width: 1200,
  height: 750,
  scale: 1,
  /** webp quality steps, highest first, until it fits LIMITS.thumbnailBytes. */
  qualities: [60, 45, 30, 20] as const,
  /** Whole capture, launch to last screenshot. */
  totalMs: 15_000,
  navigationMs: 8_000,
  /** The signed content URL's lifetime: enough for one capture. */
  urlTtlSec: 60,
  /** Free plan: 1 new browser per 20 s per account; one launch per gap here. */
  launchGapMs: 20_000,
} as const;

/** Server thumbnails run only with a BROWSER binding AND SERVER_THUMBNAILS "on". */
export const serverThumbnails = (
  env: Pick<Env, "BROWSER" | "SERVER_THUMBNAILS">,
): boolean => !!env.BROWSER && env.SERVER_THUMBNAILS === "on";

/**
 * What the job did. "deferred": the launch slot was taken (no browser used);
 * "launch_failed": the browser did not start for a reason other than the
 * daily quota (the DO backs off THUMB_LAUNCH_BACKOFF_MS).
 */
export type ThumbResult =
  | "stored"
  | "skipped"
  | "stopped"
  | "deferred"
  | "launch_failed"
  | "failed"
  | "too_large";

const STOP_KEY = "browser_stop";
const SLOT_KEY = "browser_slot";
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const thumbKey = (id: string) => `thumbs/${id}.webp`;

class TimeoutError extends Error {}

/** Browser Run's 429 (status or text) or its daily "time limit exceeded": stop for the UTC day. */
const isBudgetError = (e: unknown) =>
  (e as { status?: unknown })?.status === 429 ||
  /\b429\b|time limit exceeded/i.test(String((e as Error)?.message ?? e));

/**
 * Per format, the page's own "rendered" signal: renderer pages set
 * <html data-oa-rendered> (packages/render boot), a pdf also needs its first
 * page's canvas; html is ready once loaded with the runtime installed (the
 * capture renders top level, with no shell, so the runtime sends no hello).
 */
const READY: Record<string, string> = {
  html: 'document.readyState === "complete" && "openArtifacts" in window',
  markdown: 'document.documentElement.hasAttribute("data-oa-rendered")',
  code: 'document.documentElement.hasAttribute("data-oa-rendered")',
  pdf: 'document.documentElement.hasAttribute("data-oa-rendered") && !!document.querySelector(".page canvas, .oa-error")',
};

const sameOrigin = (u: string, origin: string) => {
  try {
    return new URL(u).origin === origin;
  } catch {
    return false;
  }
};

/**
 * Stores `bytes` as thumbs/{id}.webp for `version` unless a newer version's
 * thumbnail is stored (→ "stale"; an equal version is replaced). The R2 put is
 * conditional on the object just read, so of two racing writers the older
 * version can never land last; D1 thumbnail_version only moves forward.
 */
export async function writeThumbnail(
  env: Env,
  id: string,
  version: number,
  bytes: Uint8Array,
  by: "server" | "client",
): Promise<"stored" | "stale"> {
  for (let i = 0; i < 3; i++) {
    const prev = await env.FILES.head(thumbKey(id));
    if (prev && Number(prev.customMetadata?.v ?? 0) > version) return "stale";
    const put = await env.FILES.put(thumbKey(id), bytes, {
      onlyIf: prev
        ? { etagMatches: prev.etag }
        : new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { v: String(version), by },
    });
    if (!put) continue;
    await env.DB.prepare(
      `update artifacts set has_thumbnail = 1, thumbnail_version = ?2
       where id = ?1 and deleted_at is null and coalesce(thumbnail_version, 0) <= ?2`,
    )
      .bind(id, version)
      .run();
    return "stored";
  }
  // Lost three races in a row: newer writers are active; let them win.
  return "stale";
}

/**
 * One capture of `version` (the artifact's current one). Order: binding,
 * artifact state (current version, no thumbnail of it yet), the day's stop
 * (D1 counters), then the account-wide launch slot, so skips cost no browser
 * time. Stored through writeThumbnail: a newer client upload meanwhile wins.
 */
export async function captureThumbnail(
  env: Env,
  id: string,
  version: number,
  o: {
    now?: number;
    totalMs?: number;
    navigationMs?: number;
  } = {},
): Promise<ThumbResult> {
  const binding = env.BROWSER;
  if (!binding || !serverThumbnails(env)) return "skipped";
  const now = o.now ?? Date.now();
  const row = await env.DB.prepare(
    "select current_version v, thumbnail_version t, format f from artifacts where id = ? and deleted_at is null",
  )
    .bind(id)
    .first<{ v: number; t: number | null; f: string }>();
  if (row?.v !== version || (row.t ?? 0) >= version) return "skipped";
  const day = utcDay(now);
  const stop = await env.DB.prepare(
    "select 1 x from counters where key = ? and day = ?",
  )
    .bind(STOP_KEY, day)
    .first();
  if (stop) return "stopped";
  const slot = await env.DB.prepare(
    `insert into counters (key, n, day) values (?1, ?2, ?3)
     on conflict (key) do update set n = excluded.n, day = excluded.day
     where counters.n <= ?2 - ?4 returning n`,
  )
    .bind(SLOT_KEY, now, day, THUMB.launchGapMs)
    .first();
  if (!slot) return "deferred";

  let bytes: Uint8Array | null;
  try {
    // A plain frame URL (top level, it redirects) plus the capture header,
    // the one top-level render the content host allows.
    const { prefix } = await signContent(
      env,
      id,
      version,
      now,
      THUMB.urlTtlSec,
    );
    bytes = await shoot(
      binding,
      `${contentOrigin(env)}${prefix}__view`,
      o.totalMs ?? THUMB.totalMs,
      o.navigationMs ?? THUMB.navigationMs,
      READY[row.f] ?? null,
      await signCapture(env, id, version, now, THUMB.urlTtlSec),
    );
  } catch (e) {
    const stopped = isBudgetError(e);
    if (stopped)
      await env.DB.prepare(
        `insert into counters (key, n, day) values (?1, 1, ?2)
         on conflict (key) do update set n = 1, day = excluded.day`,
      )
        .bind(STOP_KEY, day)
        .run();
    const result: ThumbResult = stopped
      ? "stopped"
      : e instanceof LaunchError
        ? "launch_failed"
        : "failed";
    logError(`thumbnail_${result}`, e, { artifactId: id, version });
    return result;
  }
  // No quality step fit LIMITS.thumbnailBytes.
  if (!bytes) return "too_large";
  return (await writeThumbnail(env, id, version, bytes, "server")) === "stored"
    ? "stored"
    : "skipped";
}

/** In-page poll of `cond` every 50 ms for up to `ms`; resolves true once it holds. */
const pollFor = (cond: string, ms: number) =>
  `new Promise((r) => { const end = Date.now() + ${ms}; (function f() {
    let ok = false; try { ok = !!(${cond}); } catch {}
    if (ok) return r(true); if (Date.now() >= end) return r(false); setTimeout(f, 50);
  })(); })`;

/**
 * networkidle2-style settle without the Network domain: resolves once the
 * page's resource-timing count has not grown for 500 ms, at most 2 s.
 */
const SETTLE = `new Promise((r) => { const end = Date.now() + 2000; let n = -1, at = Date.now();
  (function f() { const c = performance.getEntriesByType("resource").length;
    if (c !== n) { n = c; at = Date.now(); }
    if (Date.now() - at >= 500 || Date.now() >= end) return r(true); setTimeout(f, 100);
  })(); })`;

type Capture = { scope: string; value: string };

/**
 * Fetch.continueRequest params for a paused document request. The capture
 * header goes only on the page's main-frame document requests under the
 * signed content prefix (`scope`, which ends in "/"): never on subresources
 * (not intercepted), frames, or other origins, and never as a global extra
 * header, so nothing but the content host sees it and page script can't read
 * it. `headers` replaces the request's headers, so the originals are kept.
 */
export function captureContinue(
  p: Record<string, unknown>,
  target: string,
  capture: Capture,
): Record<string, unknown> {
  const req = p.request as
    | { url?: string; headers?: Record<string, string> }
    | undefined;
  const url = req?.url ?? "";
  if (
    p.frameId !== target ||
    p.resourceType !== "Document" ||
    !url.startsWith(capture.scope) ||
    !capture.scope.endsWith("/")
  )
    return { requestId: p.requestId };
  const headers = Object.entries(req?.headers ?? {})
    .filter(([k]) => k.toLowerCase() !== CAPTURE_HEADER.toLowerCase())
    .map(([name, value]) => ({ name, value: String(value) }));
  headers.push({ name: CAPTURE_HEADER, value: capture.value });
  return { requestId: p.requestId, headers };
}

/**
 * Opens one browser (cdp.ts), loads `url` with every top-level navigation
 * (and redirect) of the page pinned to its origin, and screenshots the
 * THUMB.width × THUMB.height layout at THUMB.scale as webp, lowering the quality until it fits.
 * Only document requests are intercepted (Fetch domain); subresources are
 * left to the content host's CSP, and the Network domain is never enabled.
 * Popups are closed before they run (auto-attach) and dialogs dismissed. The browser is fresh (no cookies
 * or storage) and always closed, at `totalMs` at the latest. null: too large
 * at every quality.
 */
async function shoot(
  binding: Fetcher,
  url: string,
  totalMs: number,
  navigationMs: number,
  ready: string | null,
  /** The CAPTURE_HEADER value; sent only on main-frame documents under `url`'s prefix. */
  captureValue: string,
): Promise<Uint8Array | null> {
  const origin = new URL(url).origin;
  const capture: Capture = {
    scope: url.slice(0, url.lastIndexOf("/") + 1),
    value: captureValue,
  };
  let cdp: Cdp | null = null;
  let done = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      timers.push(setTimeout(r, ms));
    });
  const deadline = sleep(totalMs).then(() => {
    throw new TimeoutError("thumbnail capture timed out");
  });
  const run = async (): Promise<Uint8Array | null> => {
    const c = await connectCdp(binding);
    // Connected after the deadline: close it here, nobody else will.
    if (done) {
      await c.close();
      throw new TimeoutError("thumbnail capture timed out");
    }
    cdp = c;
    let target = "";
    let left = false;
    ({ targetId: target } = await c.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    ));
    const { sessionId: s } = await c.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target, flatten: true },
    );
    // Targets the page starts attach paused (setAutoAttach below): a popup
    // (or a popup's popup, attached through it) is closed before it runs;
    // frames and workers resume and load like any subresource.
    c.on("Target.attachedToTarget", (p) => {
      const t = p.targetInfo as { targetId: string; type: string };
      if (t.type === "page")
        void c
          .send("Target.closeTarget", { targetId: t.targetId })
          .catch(() => {});
      else
        void c
          .send("Runtime.runIfWaitingForDebugger", {}, String(p.sessionId))
          .catch(() => {});
    });
    c.on("Fetch.requestPaused", (p, sid) => {
      if (sid !== s) return;
      const reqUrl = (p.request as { url?: string } | undefined)?.url ?? "";
      // A page target's main frame id is its target id.
      if (p.frameId === target && !sameOrigin(reqUrl, origin)) {
        left = true;
        void c
          .send(
            "Fetch.failRequest",
            { requestId: p.requestId, errorReason: "BlockedByClient" },
            s,
          )
          .catch(() => {});
      } else
        void c
          .send("Fetch.continueRequest", captureContinue(p, target, capture), s)
          .catch(() => {});
    });
    c.on("Page.javascriptDialogOpening", (_p, sid) => {
      void c
        .send("Page.handleJavaScriptDialog", { accept: false }, sid)
        .catch(() => {});
    });
    let loaded = () => {};
    const load = new Promise<void>((r) => {
      loaded = r;
    });
    c.on("Page.loadEventFired", (_p, sid) => {
      if (sid === s) loaded();
    });
    await Promise.all([
      c.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        s,
      ),
      c.send("Page.enable", {}, s),
      c.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "*", resourceType: "Document" }] },
        s,
      ),
      c.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: THUMB.width,
          height: THUMB.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        s,
      ),
    ]);
    const t0 = Date.now();
    const nav = await c.send<{ errorText?: string }>(
      "Page.navigate",
      { url },
      s,
    );
    const offHost = () => new Error("navigation left the content host");
    if (left) throw offHost();
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    // A slow page is shot as it is.
    await Promise.race([load, sleep(navigationMs)]);
    if (left) throw offHost();
    // The page's readiness signal, within the same 8 s; else the settle.
    // With the budget spent, shoot as it is. Each poll is also bounded here,
    // Worker-side: the page owns its Date and setTimeout and can stall them.
    const leftMs = navigationMs - (Date.now() - t0);
    if (leftMs > 0) {
      const evaluate = (expression: string, ms: number) =>
        Promise.race([
          c
            .send<{ result?: { value?: unknown } }>(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              s,
            )
            .then((r) => r.result?.value === true),
          sleep(ms).then(() => false),
        ]);
      const signalled =
        ready !== null && (await evaluate(pollFor(ready, leftMs), leftMs));
      // No signal: settle, within what is left of the same budget (a poll
      // that timed out has spent it, so the page is shot as it is).
      const settleMs = Math.min(2_000, navigationMs - (Date.now() - t0));
      if (!signalled && settleMs > 0) await evaluate(SETTLE, settleMs);
    }
    if (left) throw offHost();
    // Defense in depth beside `left`: where the main frame is, per the browser.
    const { frameTree } = await c.send<{
      frameTree: { frame: { url: string } };
    }>("Page.getFrameTree", {}, s);
    if (!sameOrigin(frameTree.frame.url, origin)) throw offHost();
    for (const quality of THUMB.qualities) {
      const { data } = await c.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format: "webp",
          quality,
          clip: {
            x: 0,
            y: 0,
            width: THUMB.width,
            height: THUMB.height,
            scale: THUMB.scale,
          },
          captureBeyondViewport: false,
        },
        s,
      );
      const shot = decodeBase64(data);
      if (!shot) throw new Error("screenshot is not base64");
      if (shot.byteLength <= LIMITS.thumbnailBytes) return shot;
    }
    return null;
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    done = true;
    for (const t of timers) clearTimeout(t);
    await (cdp as Cdp | null)?.close();
  }
}
