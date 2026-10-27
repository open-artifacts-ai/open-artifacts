import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactSummary,
  LIMITS,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CAPTURE_HEADER, verifyCapture } from "../src/content/signing.js";
import type { Env } from "../src/env.js";
import { contentOrigin } from "../src/http/errors.js";
import {
  type ArtifactRuntime,
  runtimeStub,
  THUMB_LAUNCH_BACKOFF_MS,
  THUMB_MAX_ATTEMPTS,
  THUMB_RETRY_MS,
} from "../src/runtime/do.js";
import {
  publish,
  putThumbnail,
  restoreVersion,
} from "../src/services/artifacts.js";
import {
  captureContinue,
  captureThumbnail,
  THUMB,
  type ThumbResult,
} from "../src/services/thumbs.js";
import { getUser } from "../src/services/users.js";
import { decodeBase64 } from "../src/util/base64.js";
import { api, fetchAndWait, login } from "./helpers.js";

// Server-side thumbnails (spec §6.9 stretch): Browser Run, driven from the
// artifact DO's alarm. BROWSER is faked: these tests pin what the job asks of
// the browser (origin, viewport, format, size) and how it treats failures.
const tag = newId().slice(0, 6).toLowerCase();
let owner: Member;
let cookie: string;
const app = createApp();
/** env with a BROWSER binding (a placeholder; captures pass their fake's). */
const withBrowser = {
  ...(env as Env),
  BROWSER: {} as Fetcher,
  SERVER_THUMBNAILS: "on",
} as Env;
const key = (id: string) => `thumbs/${id}.webp`;

const webp = (n: number) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
};

const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};

type Req = { url: string; nav: boolean; main: boolean };
type Fake = {
  /** The BROWSER binding: Browser Run's acquire + DevTools websocket. */
  binding: Fetcher;
  launched: number;
  closed: number;
  goto: string[];
  viewport: unknown;
  /** Fetch.enable patterns: which requests the capture intercepts. */
  patterns: unknown;
  shots: { format: string; quality: number; clip: { scale: number } }[];
  aborted: string[];
  continued: string[];
  /** Readiness polls (Runtime.evaluate), then how often the settle fallback ran. */
  waited: string[];
  idled: number;
  /** Every CDP method the capture sent, in order. */
  methods: string[];
  /** Every CDP command with its params and session. */
  calls: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[];
  /** How often the capture closed the websocket. */
  wsClosed: number;
};

/**
 * A Browser Run binding speaking enough CDP for a capture. Page.navigate
 * replays `requests` (the first is the navigation itself) as Fetch.requestPaused
 * for documents (all the capture intercepts), waiting for each answer.
 */
function fake(
  o: {
    requests?: (url: string) => Req[];
    sizes?: number[];
    /** The acquire answers with this status, or the binding throws it. */
    launchError?: Error | { status: number; text: string };
    /** Page.navigate answers with this CDP error. */
    gotoError?: Error;
    /** The load event never comes (navigation runs past its budget). */
    noLoad?: boolean;
    /** Page.navigate never answers. */
    hang?: boolean;
    onShot?: () => Promise<void>;
    /** false: the readiness signal never comes. */
    ready?: boolean;
    /** Runtime.evaluate never answers (a page stalling its own timers). */
    evalHang?: boolean;
    /** After load, these targets auto-attach (popups, frames…), each on `on`'s session. */
    attach?: {
      targetId: string;
      type: string;
      sessionId: string;
      on?: string;
    }[];
    /** After load, the page opens an alert. */
    dialog?: boolean;
    /** Page.getFrameTree reports this main-frame URL (default: the last one loaded). */
    frameUrl?: string;
    /** The websocket upgrade answers without a socket. */
    upgradeFail?: boolean;
    /** At the screenshot, the browser sends a non-JSON message / closes the socket. */
    garbageAtShot?: boolean;
    closeAtShot?: boolean;
  } = {},
): Fake {
  const sizes = [...(o.sizes ?? [10_000])];
  const listeners = new Map<string, ((e: { data: string }) => void)[]>();
  const emit = (m: unknown) =>
    setTimeout(() => {
      for (const h of listeners.get("message") ?? [])
        h({ data: JSON.stringify(m) });
    }, 0);
  const waiting = new Map<string, (failed: boolean) => void>();
  const TARGET = "T1";
  const SESSION = "S1";
  let req = 0;
  const pause = (r: Req) =>
    new Promise<boolean>((resolve) => {
      const requestId = `r${++req}`;
      waiting.set(requestId, resolve);
      emit({
        method: "Fetch.requestPaused",
        sessionId: SESSION,
        params: {
          requestId,
          request: { url: r.url },
          frameId: r.main ? TARGET : "F2",
          resourceType: r.nav ? "Document" : "Script",
        },
      });
    });
  const reply = (id: number, result: unknown) => emit({ id, result });
  let mainUrl = "about:blank";
  const onCommand = async (m: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }) => {
    f.methods.push(m.method);
    f.calls.push({
      method: m.method,
      params: m.params,
      sessionId: m.sessionId,
    });
    const p = m.params;
    switch (m.method) {
      case "Target.createTarget":
        return reply(m.id, { targetId: TARGET });
      case "Target.attachToTarget":
        return reply(m.id, { sessionId: SESSION });
      case "Emulation.setDeviceMetricsOverride":
        f.viewport = { width: p.width, height: p.height };
        return reply(m.id, {});
      case "Fetch.enable":
        f.patterns = p.patterns;
        return reply(m.id, {});
      case "Fetch.continueRequest":
      case "Fetch.failRequest": {
        const failed = m.method === "Fetch.failRequest";
        waiting.get(String(p.requestId))?.(failed);
        return reply(m.id, {});
      }
      case "Page.navigate": {
        const u = String(p.url);
        f.goto.push(u);
        if (o.hang) return;
        if (o.gotoError)
          return emit({ id: m.id, error: { message: o.gotoError.message } });
        const reqs = (
          o.requests ?? ((x) => [{ url: x, nav: true, main: true }])
        )(u);
        const docs = reqs.filter((r) => r.nav);
        let first = true;
        for (const r of docs) {
          const failed = await pause(r);
          (failed ? f.aborted : f.continued).push(r.url);
          if (!failed && r.main) mainUrl = r.url;
          if (first && failed)
            return reply(m.id, { errorText: "net::ERR_BLOCKED_BY_CLIENT" });
          if (first) reply(m.id, { frameId: TARGET });
          first = false;
        }
        for (const t of o.attach ?? [])
          emit({
            method: "Target.attachedToTarget",
            sessionId: t.on ?? SESSION,
            params: {
              sessionId: t.sessionId,
              targetInfo: { targetId: t.targetId, type: t.type },
              waitingForDebugger: true,
            },
          });
        if (o.dialog)
          emit({
            method: "Page.javascriptDialogOpening",
            sessionId: SESSION,
            params: { type: "alert", message: "hi" },
          });
        if (!o.noLoad)
          emit({
            method: "Page.loadEventFired",
            sessionId: SESSION,
            params: {},
          });
        return;
      }
      case "Page.getFrameTree":
        return reply(m.id, {
          frameTree: { frame: { id: TARGET, url: o.frameUrl ?? mainUrl } },
        });
      case "Runtime.evaluate": {
        if (o.evalHang) return;
        const e = String(p.expression);
        if (e.includes("getEntriesByType")) {
          f.idled++;
          return reply(m.id, { result: { value: true } });
        }
        f.waited.push(e);
        return reply(m.id, { result: { value: o.ready !== false } });
      }
      case "Page.captureScreenshot": {
        f.shots.push(p as never);
        await o.onShot?.();
        if (o.garbageAtShot) {
          setTimeout(() => {
            for (const h of listeners.get("message") ?? [])
              h({ data: "{not json" });
          }, 0);
          return;
        }
        if (o.closeAtShot) {
          setTimeout(() => {
            for (const h of listeners.get("close") ?? []) h({ data: "" });
          }, 0);
          return;
        }
        return reply(m.id, { data: b64(webp(sizes.shift() ?? 10_000)) });
      }
      case "Browser.close":
        f.closed++;
        return reply(m.id, {});
      default:
        return reply(m.id, {});
    }
  };
  const socket = {
    accept() {},
    addEventListener(t: string, h: (e: { data: string }) => void) {
      listeners.set(t, [...(listeners.get(t) ?? []), h]);
    },
    send(msg: string) {
      void onCommand(JSON.parse(msg));
    },
    close() {
      f.wsClosed++;
    },
  };
  const f: Fake = {
    launched: 0,
    closed: 0,
    goto: [],
    viewport: null,
    patterns: null,
    shots: [],
    aborted: [],
    continued: [],
    waited: [],
    idled: 0,
    methods: [],
    calls: [],
    wsClosed: 0,
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(url).toBe("https://fake.host/v1/devtools/browser");
          const err = o.launchError;
          if (err instanceof Error) throw err;
          if (err) return new Response(err.text, { status: err.status });
          f.launched++;
          return Response.json({ sessionId: "sess-1" });
        }
        expect(url).toBe("https://fake.host/v1/devtools/browser/sess-1");
        expect(new Headers(init?.headers).get("upgrade")).toBe("websocket");
        if (o.upgradeFail) return new Response("no", { status: 502 });
        return { status: 101, webSocket: socket } as unknown as Response;
      },
    } as unknown as Fetcher,
  };
  return f;
}

const pub = async (format = "html", content = "<p>x</p>") =>
  (
    await publish(
      env as Env,
      owner,
      { title: `t ${tag}`, format, content } as never,
      null,
    )
  ).id;
const hasThumb = async (id: string) =>
  (
    await env.DB.prepare("select has_thumbnail h from artifacts where id = ?")
      .bind(id)
      .first<{ h: number }>()
  )?.h;
const putRaw = (path: string, body: Uint8Array) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: "PUT",
      headers: { cookie, "x-oa-request": "1", "content-type": "image/webp" },
      body: body as Uint8Array<ArrayBuffer>,
    }),
  );
const thumbVersion = async (id: string) =>
  (
    await env.DB.prepare(
      "select thumbnail_version t from artifacts where id = ?",
    )
      .bind(id)
      .first<{ t: number | null }>()
  )?.t;
const republish = async (id: string) =>
  (
    await publish(
      env as Env,
      owner,
      { id, title: `t ${tag}`, format: "html", content: "<p>2</p>" } as never,
      null,
      undefined,
      "version",
    )
  ).version;
const inDo = <T>(
  id: string,
  cb: (i: ArtifactRuntime) => T | Promise<T>,
  e: Env = env as Env,
) =>
  runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
      return cb(i);
    },
  );
let clock = Date.parse("2026-10-19T12:00:00Z");
/** Each capture gets its own launch slot unless a test says otherwise. */
const next = () => {
  clock += THUMB.launchGapMs;
  return clock;
};
const on = (f: Fake) =>
  ({ ...(env as Env), BROWSER: f.binding, SERVER_THUMBNAILS: "on" }) as Env;
const capture = (id: string, v: number, f: Fake, e: Env = on(f)) =>
  captureThumbnail(e, id, v, { now: next() });

beforeAll(async () => {
  const l = await login(`thumbs-${tag}@x.com`);
  cookie = l.cookie;
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
beforeEach(async () => {
  await env.DB.prepare(
    "delete from counters where key in ('browser_stop', 'browser_slot')",
  ).run();
});

describe("captureThumbnail", () => {
  it("without a BROWSER binding: skipped, no browser", async () => {
    const id = await pub();
    const f = fake();
    expect(await capture(id, 1, f, env as Env)).toBe("skipped");
    expect(f.launched).toBe(0);
  });

  it('off unless SERVER_THUMBNAILS is "on": a bound BROWSER alone is never called', async () => {
    for (const v of [undefined, "off", "ON", ""]) {
      const id = await pub();
      const f = fake();
      const e = {
        ...(env as Env),
        BROWSER: f.binding,
        SERVER_THUMBNAILS: v,
      } as Env;
      expect(await capture(id, 1, f, e)).toBe("skipped");
      expect(f.launched).toBe(0);
      expect(f.methods).toEqual([]);
    }
  });

  it("screenshots the signed content URL at 1200×750 (the client's size) as webp and stores it", async () => {
    for (const format of ["html", "markdown", "code", "pdf"]) {
      const id = await pub(format, format === "pdf" ? "%PDF-1.4" : "x");
      const f = fake();
      expect(await capture(id, 1, f)).toBe("stored");
      expect(f.goto).toHaveLength(1);
      const u = new URL(f.goto[0] ?? "");
      expect(u.origin).toBe(contentOrigin(env as Env));
      expect(u.pathname).toMatch(
        new RegExp(`^/c/\\d+\\.[A-Za-z0-9_-]{43}/${id}/v1/__view$`),
      );
      // The capture header rides the navigation's continueRequest only.
      const cont = f.calls.filter((x) => x.method === "Fetch.continueRequest");
      const hdrs = cont[0]?.params.headers as
        | { name: string; value: string }[]
        | undefined;
      const cap = hdrs?.find((h) => h.name === CAPTURE_HEADER)?.value;
      expect(await verifyCapture(env as Env, cap, id, 1, clock)).toBe(true);
      expect(f.methods).not.toContain("Network.setExtraHTTPHeaders");
      expect(u.search).toBe("");
      // Short-lived: well under the viewer's LIMITS.signedUrlTtlSec.
      const exp = Number(/\/c\/(\d+)\./.exec(u.pathname)?.[1]);
      expect(exp * 1000 - clock).toBeLessThanOrEqual(THUMB.urlTtlSec * 1000);
      expect(f.viewport).toEqual({ width: 1200, height: 750 });
      expect(f.shots[0]).toMatchObject({
        format: "webp",
        clip: { width: 1200, height: 750, scale: 1 },
      });
      expect(f.shots[0]?.quality).toBeLessThanOrEqual(60);
      // No Network domain: its per-request events are most of puppeteer's CPU.
      expect(f.methods.some((m) => m.startsWith("Network."))).toBe(false);
      expect(f.closed).toBe(1);
      expect(await hasThumb(id)).toBe(1);
      const obj = await env.FILES.head(key(id));
      expect(obj?.customMetadata).toMatchObject({ v: "1", by: "server" });
      expect(await thumbVersion(id)).toBe(1);
    }
  });

  it("aborts a top-level navigation or redirect off the content host; subresources pass", async () => {
    const id = await pub();
    const f = fake({
      requests: (u) => [
        { url: u, nav: true, main: true },
        { url: "https://cdn.example/x.js", nav: false, main: true },
        { url: "https://frame.example/", nav: true, main: false },
        { url: "https://evil.example/", nav: true, main: true },
      ],
    });
    expect(await capture(id, 1, f)).toBe("failed");
    expect(f.aborted).toEqual(["https://evil.example/"]);
    // Only documents are intercepted: subresources follow the CSP untouched.
    expect(f.patterns).toEqual([{ urlPattern: "*", resourceType: "Document" }]);
    expect(f.continued).toContain("https://frame.example/");
    expect(f.continued).not.toContain("https://cdn.example/x.js");
    expect(f.shots).toHaveLength(0);
    expect(f.closed).toBe(1);
    expect(await hasThumb(id)).toBe(0);
    expect(await env.FILES.head(key(id))).toBeNull();
  });

  it("a hung page hits the hard timeout and the browser is closed", async () => {
    const id = await pub();
    const f = fake({ hang: true });
    const t0 = Date.now();
    expect(
      await captureThumbnail(on(f), id, 1, { now: next(), totalMs: 50 }),
    ).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(f.closed).toBe(1);
    expect(await hasThumb(id)).toBe(0);
  });

  it("waits for the page's readiness signal per format; idle settle only without one", async () => {
    const expected: Record<string, RegExp> = {
      html: /openArtifacts/,
      markdown: /data-oa-rendered/,
      code: /data-oa-rendered/,
      pdf: /data-oa-rendered.*\.page canvas/,
    };
    for (const [format, re] of Object.entries(expected)) {
      const id = await pub(format, format === "pdf" ? "%PDF-1.4" : "x");
      const f = fake();
      expect(await capture(id, 1, f)).toBe("stored");
      expect(f.waited).toHaveLength(1);
      expect(f.waited[0]).toMatch(re);
      expect(f.idled).toBe(0);
    }
    const id = await pub();
    const slow = fake({ ready: false });
    expect(await capture(id, 1, slow)).toBe("stored");
    expect(slow.idled).toBe(1);
  });

  it("stops the day on each quota signal: 429 status, 429 text, time limit exceeded", async () => {
    for (const err of [
      { status: 429, text: "Too Many Requests" },
      new Error("code: 429: Too Many Requests"),
      new Error("Browser time limit exceeded for today"),
    ]) {
      await env.DB.prepare(
        "delete from counters where key = 'browser_stop'",
      ).run();
      const id = await pub();
      expect(await capture(id, 1, fake({ launchError: err }))).toBe("stopped");
      const g = fake();
      expect(await capture(id, 1, g)).toBe("stopped");
      expect(g.launched).toBe(0);
    }
  });

  it("a goto that uses up the navigation budget is shot as it is (no 0 ms = endless wait)", async () => {
    const id = await pub("markdown", "x");
    const f = fake({ noLoad: true });
    expect(
      await captureThumbnail(on(f), id, 1, {
        now: next(),
        navigationMs: 20,
        totalMs: 3_000,
      }),
    ).toBe("stored");
    expect(f.waited).toEqual([]);
    expect(f.idled).toBe(0);
    expect(f.shots.length).toBeGreaterThan(0);
    expect(f.closed).toBe(1);
  });

  it("a page that stalls its own timers can't hold the capture: evaluate is bounded Worker-side", async () => {
    const id = await pub("markdown", "x");
    const f = fake({ evalHang: true });
    const t0 = Date.now();
    expect(
      await captureThumbnail(on(f), id, 1, {
        now: next(),
        navigationMs: 50,
        totalMs: 1_500,
      }),
    ).toBe("stored");
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(f.shots.length).toBeGreaterThan(0);
  });

  it("popups (and popups of popups) are closed before they run; frames are resumed", async () => {
    const id = await pub();
    const f = fake({
      attach: [
        { targetId: "P1", type: "page", sessionId: "PS1" },
        { targetId: "P2", type: "page", sessionId: "PS2", on: "PS1" },
        { targetId: "F1", type: "iframe", sessionId: "FS1" },
      ],
    });
    expect(await capture(id, 1, f)).toBe("stored");
    const auto = f.calls.filter((c) => c.method === "Target.setAutoAttach");
    expect(auto).toEqual([
      {
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        },
        sessionId: "S1",
      },
    ]);
    const closedTargets = f.calls
      .filter((c) => c.method === "Target.closeTarget")
      .map((c) => c.params.targetId);
    expect(closedTargets.sort()).toEqual(["P1", "P2"]);
    expect(
      f.calls.filter((c) => c.method === "Runtime.runIfWaitingForDebugger"),
    ).toEqual([
      {
        method: "Runtime.runIfWaitingForDebugger",
        params: {},
        sessionId: "FS1",
      },
    ]);
    // No target discovery: its targetInfoChanged events are a flood.
    expect(f.methods).not.toContain("Target.setDiscoverTargets");
  });

  it("checks the main frame's URL (browser-side) before the screenshot", async () => {
    const id = await pub();
    const f = fake({ frameUrl: "https://evil.example/" });
    expect(await capture(id, 1, f)).toBe("failed");
    expect(f.methods).toContain("Page.getFrameTree");
    expect(f.shots).toHaveLength(0);
    expect(f.closed).toBe(1);
  });

  it("a JavaScript dialog is dismissed", async () => {
    const id = await pub();
    const f = fake({ dialog: true });
    expect(await capture(id, 1, f)).toBe("stored");
    expect(
      f.calls.find((c) => c.method === "Page.handleJavaScriptDialog"),
    ).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
      sessionId: "S1",
    });
  });

  it("a failed websocket upgrade after the acquire is a launch failure and is logged", async () => {
    const id = await pub();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fake({ upgradeFail: true });
      expect(await capture(id, 1, f)).toBe("launch_failed");
      expect(f.launched).toBe(1);
      const logged = err.mock.calls.map((c) => String(c[0]));
      expect(
        logged.some(
          (l) =>
            l.includes('"evt":"thumbnail_session_orphaned"') &&
            l.includes('"sessionId":"sess-1"'),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("a malformed CDP message fails the capture cleanly and the browser is still closed", async () => {
    const id = await pub();
    const f = fake({ garbageAtShot: true });
    const t0 = Date.now();
    expect(
      await captureThumbnail(on(f), id, 1, { now: next(), totalMs: 3_000 }),
    ).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(f.closed).toBe(1);
    expect(f.wsClosed).toBe(1);
  });

  it("the socket closing mid-capture rejects the capture at once; the socket is closed", async () => {
    const id = await pub();
    const f = fake({ closeAtShot: true });
    const t0 = Date.now();
    expect(
      await captureThumbnail(on(f), id, 1, { now: next(), totalMs: 3_000 }),
    ).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(f.wsClosed).toBe(1);
  });

  it("a launch error that is not the quota does not stop the day", async () => {
    const id = await pub();
    const f = fake({ launchError: new Error("WebSocket connection failed") });
    expect(await capture(id, 1, f)).toBe("launch_failed");
    expect(
      await env.DB.prepare(
        "select 1 x from counters where key = 'browser_stop'",
      ).first(),
    ).toBeNull();
    const g = fake();
    expect(await capture(id, 1, g)).toBe("stored");
    expect(g.launched).toBe(1);
  });

  it("a launch error or quota 429 stops captures for the UTC day", async () => {
    const id = await pub();
    const f = fake({
      launchError: new Error(
        "Unable to create new browser: code: 429: message: Browser time limit exceeded for today",
      ),
    });
    expect(await capture(id, 1, f)).toBe("stopped");
    const g = fake();
    expect(await capture(id, 1, g)).toBe("stopped");
    expect(g.launched).toBe(0);
    // The next UTC day starts afresh.
    clock += 86_400_000;
    expect(await capture(id, 1, g)).toBe("stored");
  });

  it("a quota error mid-session also stops the day; a page error does not", async () => {
    const id = await pub();
    const bad = fake({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    expect(await capture(id, 1, bad)).toBe("failed");
    const quota = fake({
      gotoError: new Error("code: 429: Browser time limit exceeded for today"),
    });
    expect(await capture(id, 1, quota)).toBe("stopped");
    expect(quota.closed).toBe(1);
    expect(await capture(id, 1, fake())).toBe("stopped");
  });

  it("lowers the quality until the webp fits LIMITS.thumbnailBytes", async () => {
    const id = await pub();
    const big = LIMITS.thumbnailBytes + 1;
    const f = fake({ sizes: [big, big, LIMITS.thumbnailBytes] });
    expect(await capture(id, 1, f)).toBe("stored");
    const q = f.shots.map((s) => s.quality);
    expect(q).toHaveLength(3);
    expect(q[0]).toBeGreaterThan(q[1] ?? 0);
    expect(q[1]).toBeGreaterThan(q[2] ?? 0);
    expect((await env.FILES.head(key(id)))?.size).toBe(LIMITS.thumbnailBytes);

    const id2 = await pub();
    const never = fake({ sizes: Array(10).fill(big) });
    expect(await capture(id2, 1, never)).toBe("too_large");
    expect(never.shots.length).toBe(THUMB.qualities.length);
    expect(await env.FILES.head(key(id2))).toBeNull();
  });

  it("skips a version that already has a thumbnail, and a stale or deleted version", async () => {
    const id = await pub();
    expect(await capture(id, 1, fake())).toBe("stored");
    const f = fake();
    expect(await capture(id, 1, f)).toBe("skipped");
    expect(await capture(id, 2, f)).toBe("skipped"); // not the current version
    expect(f.launched).toBe(0);
  });

  it("regenerates on every new version: v1's thumbnail is replaced by v2's", async () => {
    const id = await pub();
    await putThumbnail(env as Env, owner, id, webp(64)); // client, v1
    expect(await thumbVersion(id)).toBe(1);
    const v2 = await republish(id);
    expect(await capture(id, v2, fake({ sizes: [5_000] }))).toBe("stored");
    expect(await thumbVersion(id)).toBe(2);
    expect((await env.FILES.head(key(id)))?.customMetadata).toMatchObject({
      v: "2",
      by: "server",
    });
  });

  it("thumbnailUrl carries ?v=<thumbnailVersion> as a cache buster", async () => {
    const id = await pub();
    const get = async () =>
      (await (
        await api(app, R.artifact(id), cookie)
      ).json()) as ArtifactSummary;
    expect(await get()).toMatchObject({
      thumbnailUrl: null,
      thumbnailVersion: null,
    });
    await capture(id, 1, fake());
    const s1 = await get();
    expect(s1.thumbnailVersion).toBe(1);
    expect(s1.thumbnailUrl).toBe(`http://app.localhost${R.thumbnail(id)}?v=1`);
    const v2 = await republish(id);
    await capture(id, v2, fake());
    expect((await get()).thumbnailUrl).toBe(
      `http://app.localhost${R.thumbnail(id)}?v=2`,
    );
    // The image route itself ignores the buster.
    const img = await api(app, `${R.thumbnail(id)}?v=2`, cookie);
    expect(img.status).toBe(200);
  });

  it("client vs server ordering: the newer version always ends up stored", async () => {
    // A client still showing v1 uploads while the server captures v2.
    const id = await pub();
    const v2 = await republish(id);
    const g = fake({
      sizes: [5_000],
      onShot: () => putThumbnail(env as Env, owner, id, webp(64), 1),
    });
    expect(await capture(id, v2, g)).toBe("stored");
    expect(await thumbVersion(id)).toBe(2);
    expect((await env.FILES.head(key(id)))?.size).toBe(5_000);
    // A late v1 upload is refused with 409 and changes nothing.
    await expect(
      putThumbnail(env as Env, owner, id, webp(64), 1),
    ).rejects.toMatchObject({ code: "conflict" });
    const r = await putRaw(`${R.thumbnail(id)}?v=1`, webp(64));
    expect(r.status).toBe(409);
    expect(await thumbVersion(id)).toBe(2);

    // The server capturing v1 while a client uploads v2 (published meanwhile).
    const id2 = await pub();
    const h = fake({
      onShot: async () => {
        const v = await republish(id2);
        await putThumbnail(env as Env, owner, id2, webp(88), v);
      },
    });
    expect(await capture(id2, 1, h)).toBe("skipped");
    expect(await thumbVersion(id2)).toBe(2);
    expect((await env.FILES.head(key(id2)))?.size).toBe(88);
  });

  it("client ?v= must be a version that exists", async () => {
    const id = await pub();
    for (const v of ["0", "x", "2"]) {
      const r = await putRaw(`${R.thumbnail(id)}?v=${v}`, webp(64));
      expect(r.status).toBe(400);
    }
  });

  it("one browser launch per THUMB.launchGapMs across all artifacts", async () => {
    const a = await pub();
    const b = await pub();
    const t = next();
    const f = fake();
    expect(await captureThumbnail(on(f), a, 1, { now: t })).toBe("stored");
    expect(await captureThumbnail(on(f), b, 1, { now: t + 1_000 })).toBe(
      "deferred",
    );
    expect(f.launched).toBe(1);
  });
});

describe("capture header (#292)", () => {
  const scope = "http://content.localhost/c/1.sig/AAAA/v1/";
  const cap = { scope, value: "9.mac" };
  const paused = (
    url: string,
    o: { frameId?: string; type?: string } = {},
  ) => ({
    requestId: "r1",
    frameId: o.frameId ?? "T1",
    resourceType: o.type ?? "Document",
    request: { url, headers: { Accept: "text/html", "X-OA-Capture": "x" } },
  });

  it("goes only on main-frame documents under the signed prefix, originals kept", () => {
    const ok = captureContinue(paused(`${scope}__view`), "T1", cap);
    expect(ok.headers).toEqual([
      { name: "Accept", value: "text/html" },
      { name: CAPTURE_HEADER, value: "9.mac" },
    ]);
    // Nested entry redirect / in-artifact navigation under the same prefix.
    expect(
      captureContinue(paused(`${scope}sub/index.html`), "T1", cap).headers,
    ).toBeDefined();
    for (const p of [
      paused(`${scope}a.js`, { type: "Script" }), // subresource
      paused(`${scope}__view`, { frameId: "F2" }), // a frame
      paused("https://evil.example/c/1.sig/AAAA/v1/__view"), // other origin
      paused("http://content.localhost.evil.example/c/1.sig/AAAA/v1/"),
      paused("http://content.localhost/c/1.sig/BBBB/v1/__view"), // other artifact
      paused("http://content.localhost/c/1.sig/AAAA/v12/__view"), // other version
    ])
      expect(captureContinue(p, "T1", cap)).toEqual({ requestId: "r1" });
  });

  it("a capture never sends it to a frame's document or off the prefix", async () => {
    const id = await pub("html", "x");
    const f = fake({
      requests: (u) => [
        { url: u, nav: true, main: true },
        {
          url: `${new URL(u).origin}/p/${id}/v1/x.html`,
          nav: true,
          main: true,
        },
        { url: `${u.replace("__view", "frame.html")}`, nav: true, main: false },
      ],
    });
    await capture(id, 1, f);
    const cont = f.calls.filter((x) => x.method === "Fetch.continueRequest");
    expect(cont.map((x) => !!x.params.headers)).toEqual([true, false, false]);
    expect(f.methods).not.toContain("Network.setExtraHTTPHeaders");
  });
});

describe("decodeBase64", () => {
  it("decodes with Uint8Array.fromBase64 or, without it, atob", () => {
    const bytes = webp(70_000).map((_, i) => (i * 7) % 251);
    const enc = b64(bytes);
    expect(decodeBase64(enc)).toEqual(bytes);
    expect(decodeBase64(enc, null)).toEqual(bytes);
    expect(decodeBase64("not base64!", null)).toBeNull();
  });
});

describe("thumbnail job on the artifact DO", () => {
  it("publish and restore queue one debounced job (latest version) only with BROWSER", async () => {
    const id = await pub();
    expect(await inDo(id, (i) => i.pendingThumbnail())).toBeNull();

    await inDo(id, (i) => i.scheduleIndex(id, 2, true), withBrowser);
    await inDo(id, (i) => i.scheduleIndex(id, 3, true), withBrowser);
    await inDo(id, (i) => i.scheduleIndex(id, 2, true), withBrowser);
    expect(
      await inDo(id, (i) => i.pendingThumbnail(), withBrowser),
    ).toMatchObject({ artifactId: id, version: 3, attempts: 0 });
    // An index-only enqueue never adds one.
    const other = await pub();
    await inDo(other, (i) => i.scheduleIndex(other, 1), withBrowser);
    expect(await inDo(other, (i) => i.pendingThumbnail())).toBeNull();
  });

  it("with BROWSER bound but SERVER_THUMBNAILS unset, publish and restore schedule nothing", async () => {
    const id = await pub();
    const f = fake();
    const gated = { ...(env as Env), BROWSER: f.binding } as Env;
    await inDo(id, () => {}, gated);
    await publish(
      gated,
      owner,
      { id, title: `t ${tag}`, format: "html", content: "<p>2</p>" } as never,
      null,
      undefined,
      "version",
    );
    await restoreVersion(gated, owner, id, 1, null);
    expect(await inDo(id, (i) => i.pendingThumbnail(), gated)).toBeNull();
    expect(await inDo(id, (i) => i.thumbnailJob(), gated)).toBeNull();
    // The index job is still queued; running the alarm calls no browser.
    await inDo(id, (i) => i.alarm(), gated);
    expect(f.launched).toBe(0);
  });

  it("gate off: a job queued while it was on stays dormant (unread, no attempt, no alarm)", async () => {
    const id = await pub();
    let calls = 0;
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm(); // indexes only
        // Drive the alarm by hand: a real one firing now would run the capture.
        await (
          i as unknown as { ctx: DurableObjectState }
        ).ctx.storage.deleteAlarm();
      },
      withBrowser,
    );
    const off = { ...withBrowser, SERVER_THUMBNAILS: "off" } as Env;
    await inDo(
      id,
      async (i) => {
        i.thumbnailer = async () => {
          calls++;
          return "stored";
        };
        await i.alarm();
        expect(calls).toBe(0);
        expect(i.thumbnailJob()).toMatchObject({
          state: "pending",
          attempts: 0,
        });
        expect(
          await (
            i as unknown as { ctx: DurableObjectState }
          ).ctx.storage.getAlarm(),
        ).toBeNull();
      },
      off,
    );
  });

  it("restoreVersion enqueues a thumbnail job for the new version", async () => {
    const id = await pub();
    // The DO reads BROWSER from its own env: give this instance one.
    await inDo(id, () => {}, withBrowser);
    await restoreVersion(withBrowser, owner, id, 1, null);
    expect(
      await inDo(id, (i) => i.pendingThumbnail(), withBrowser),
    ).toMatchObject({ version: 2 });
  });

  it("never captures in the alarm run that indexed; re-arms at once for it", async () => {
    const id = await pub();
    const order: string[] = [];
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {
          order.push("index");
        };
        i.thumbnailer = async () => {
          order.push("thumb");
          return "stored";
        };
        const t = Date.now();
        await i.alarm();
        expect(order).toEqual(["index"]);
        const at = await (
          i as unknown as { ctx: DurableObjectState }
        ).ctx.storage.getAlarm();
        expect(at).not.toBeNull();
        expect(at ?? 0).toBeLessThanOrEqual(Date.now());
        expect(at ?? 0).toBeGreaterThanOrEqual(t - 1);
        await i.alarm();
        expect(order).toEqual(["index", "thumb"]);
        expect(i.thumbnailJob()).toMatchObject({ state: "done", attempts: 1 });
      },
      withBrowser,
    );
  });

  it("counts the attempt before launching; a killed run is retried once, then abandoned", async () => {
    const id = await pub();
    const seen: (number | undefined)[] = [];
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm(); // indexes only
        // Drive the alarm by hand from here on (no real alarm interleaving).
        const storage = (i as unknown as { ctx: DurableObjectState }).ctx
          .storage;
        await storage.deleteAlarm();
        // A capture that never returns stands in for a CPU-limit kill.
        i.thumbnailer = async () => {
          seen.push(i.thumbnailJob()?.attempts);
          return new Promise<never>(() => {});
        };
        void i.alarm();
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toEqual([1]);
        expect(i.pendingThumbnail()).toMatchObject({ attempts: 1 });
        // Armed before launching, so the runtime comes back after a kill.
        const armed = await storage.getAlarm();
        expect(armed ?? 0).toBeGreaterThan(Date.now() + THUMB_RETRY_MS - 5_000);
        // Its retry alarm comes THUMB_RETRY_MS later.
        i.now = () => Date.now() + THUMB_RETRY_MS;
        void i.alarm();
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toEqual([1, 2]);
        i.now = () => Date.now() + 2 * THUMB_RETRY_MS;
        await i.alarm();
        expect(seen).toEqual([1, 2]);
        expect(i.thumbnailJob()).toMatchObject({
          state: "no_thumb",
          attempts: THUMB_MAX_ATTEMPTS,
        });
      },
      withBrowser,
    );
  });

  it("a failed capture is not retried; a deferral uses the one retry", async () => {
    const id = await pub();
    const results: ThumbResult[] = ["failed"];
    const err = vi.spyOn(console, "error");
    const noThumb = () =>
      err.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((e) => e?.evt === "thumbnail_no_thumb");
    const failed = (v: number) =>
      env.DB.prepare(
        "select thumb_failed f from versions where artifact_id = ? and version = ?",
      )
        .bind(id, v)
        .first("f");
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm();
        let calls = 0;
        i.thumbnailer = async () => {
          calls++;
          return results.shift() ?? "stored";
        };
        await i.alarm();
        expect(calls).toBe(1);
        expect(i.thumbnailJob()).toMatchObject({ state: "no_thumb" });
        expect(noThumb()).toEqual([
          {
            evt: "thumbnail_no_thumb",
            artifactId: id,
            version: 1,
            result: "failed",
            attempts: 1,
          },
        ]);
        expect(await failed(1)).toBe(1);

        await i.scheduleIndex(id, 2, true);
        await i.alarm(); // indexes v2
        results.push("deferred", "deferred");
        await i.alarm();
        expect(i.pendingThumbnail()).toMatchObject({ version: 2, attempts: 1 });
        i.now = () => Date.now() + THUMB.launchGapMs;
        await i.alarm();
        expect(calls).toBe(3);
        expect(i.thumbnailJob()).toMatchObject({
          version: 2,
          state: "no_thumb",
          attempts: 2,
        });
        expect(noThumb()[1]).toMatchObject({
          version: 2,
          result: "deferred",
          attempts: 2,
        });
      },
      withBrowser,
    );
    err.mockRestore();
  });

  it("a non-quota launch error backs off an hour, retries once, then gives up", async () => {
    const id = await pub();
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm();
        let calls = 0;
        i.thumbnailer = async () => {
          calls++;
          return "launch_failed";
        };
        const t = Date.now();
        await i.alarm();
        const job = i.pendingThumbnail();
        expect(job).toMatchObject({ attempts: 1 });
        expect(job?.due ?? 0).toBeGreaterThanOrEqual(
          t + THUMB_LAUNCH_BACKOFF_MS,
        );
        await i.alarm(); // not due yet
        expect(calls).toBe(1);
        i.now = () => Date.now() + THUMB_LAUNCH_BACKOFF_MS + 1_000;
        await i.alarm();
        expect(calls).toBe(2);
        expect(i.thumbnailJob()).toMatchObject({
          state: "no_thumb",
          attempts: 2,
        });
      },
      withBrowser,
    );
  });
});
