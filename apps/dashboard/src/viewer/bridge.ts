import {
  ANON_ID_HEADER,
  AnonViewerSchema,
  type ArtifactSummary,
  type ArtifactToShell,
  DataChangeSchema,
  DataDocSchema,
  type ErrorCode,
  LIMITS,
  METHOD_CAPABILITY,
  PageSchema,
  parseArtifactMessage,
  R,
  RUNTIME_PARAMS,
  RUNTIME_RESULTS,
  type RuntimeMethod,
  type ShellToArtifact,
  StorageEntrySchema,
  StorageKeySchema,
  type StorageSetBody,
} from "@oa/shared";
import type { z } from "zod";
import { ApiClientError, api, type RequestExtra } from "../api/client";
import { isEmbed } from "../embed";
import {
  isAnonToken,
  loadAnonShort,
  loadAnonToken,
  saveAnonShort,
  saveAnonToken,
  withMintLock,
} from "./anonId";
import { frameLoad, loadArtifactFrame } from "./frame";

type Viewer = { email: string; name: string | null };
type Theme = "light" | "dark";

export interface BridgeOptions {
  iframe: HTMLIFrameElement;
  /** The content URL: the bridge loads it into `iframe` with a fresh nonce. */
  url: string;
  artifact: ArtifactSummary;
  version: number;
  /** This version's format; the artifact's own is only the current version's. */
  formatOf?: () => string | undefined;
  viewer: Viewer | null;
  theme: Theme;
  onPdfText: (text: string) => void;
  onThumb: (blob: Blob) => void;
  onResize?: (h: number) => void;
  /** The frame said hello. */
  onHello?: () => void;
  /** A data subscription was closed with 4403: access was revoked. */
  onAccessLost?: () => void;
  /** The frame navigated somewhere we didn't send it: the bridge is disposed. */
  onRenavigated?: () => void;
  /** The artifact asked to open `url` (unvalidated: see navigate.ts). */
  onNavigate?: (url: string) => void;
  /** The artifact asked to open another site's `url` (unvalidated: see createOpener). */
  onOpen?: (url: string) => void;
  /** The viewer first touched the artifact since this load (runtime `interacted`). */
  onInteracted?: () => void;
  /** The document scrolled (runtime `scroll`, throttled). */
  onScroll?: (pos: ScrollPos) => void;
  /** Text selected or a field focused in the frame, or no longer. */
  onEngaged?: (engaged: boolean) => void;
}

/** A document's scroll offset and how far it could scroll. */
export type ScrollPos = { top: number; max: number };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const DocPage = PageSchema(DataDocSchema);
const KeyPage = PageSchema(StorageKeySchema);

type Sub = {
  ws: WebSocket | null;
  refs: number;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const MAX_SUBSCRIPTIONS = 32;
const MAX_IN_FLIGHT = 64;

/** Decodes a webp data URL; null unless it is a RIFF/WEBP image within the size limit. */
function dataUrlToBlob(dataUrl: string): Blob | null {
  let bin: string;
  try {
    bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  } catch {
    return null;
  }
  if (
    bin.length > LIMITS.thumbnailBytes ||
    bin.slice(0, 4) !== "RIFF" ||
    bin.slice(8, 12) !== "WEBP"
  )
    return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/webp" });
}

const qs = (p: { cursor?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (p.cursor !== undefined) q.set("cursor", p.cursor);
  if (p.limit !== undefined) q.set("limit", String(p.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/**
 * One bridge per intentional frame load. It loads `opts.url` itself (through
 * loadArtifactFrame, so with a fresh nonce) and accepts a message only if its
 * source is the frame's window and it carries that nonce. A `load` that isn't
 * the one it started is a renavigation (by the artifact or anything that can
 * navigate the frame): the bridge disposes itself and answers nothing more.
 */
export function createBridge(opts: BridgeOptions) {
  const {
    iframe,
    artifact,
    onPdfText,
    onThumb,
    onResize,
    onHello,
    onAccessLost,
    onInteracted,
  } = opts;
  const id = artifact.id; // the only artifact id any route is ever built from
  // Framed, the artifact never learns who is viewing, whatever the caller passed.
  const embed = isEmbed();
  const viewer = artifact.capabilities.viewer && !embed ? opts.viewer : null;
  // The anonId header rides only on anonymous calls (viewer null for any
  // reason: signed out, or embed mode) to artifacts that allow anonymous
  // writes; never signed in, never into the frame.
  const anon =
    (opts.viewer === null || embed) && artifact.allowAnonymousWrites === true;
  /** The first token-less call that mints (writes, anon-id); others wait so one id is minted. */
  let minting: Promise<void> | null = null;
  const subs = new Map<string, Sub>();
  let disposed = false;
  let thumbPending = false;
  let lostFired = false;
  let inFlight = 0;
  const abort = new AbortController();

  // The sandboxed frame has an opaque origin, so the only valid targetOrigin is "*".
  // Replies carry no secrets beyond what this frame is already entitled to, and the
  // recipient is pinned to iframe.contentWindow.
  const reply = (msg: ShellToArtifact) => {
    if (disposed) return;
    iframe.contentWindow?.postMessage(msg, "*");
  };
  const ok = (rid: string, value: unknown) =>
    reply({ oa: 1, type: "result", id: rid, ok: true, value });
  const fail = (rid: string, code: ErrorCode, message: string) =>
    reply({
      oa: 1,
      type: "result",
      id: rid,
      ok: false,
      error: { code, message },
    });

  const connect = (col: string, s: Sub) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Framed: the server treats the socket as anonymous (its cookie still rides along).
    const path = R.dataSubscribe(id, col);
    const hint = isEmbed() ? `${path.includes("?") ? "&" : "?"}embed=1` : "";
    const ws = new WebSocket(`${proto}//${location.host}${path}${hint}`);
    s.ws = ws;
    ws.onopen = () => {
      s.attempt = 0;
      lostFired = false;
      // Changes during a gap aren't replayed; tell the frame to refetch on every open.
      if (s.ws === ws && s.refs > 0)
        reply({ oa: 1, type: "event", event: "db.resync", collection: col });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const ch = DataChangeSchema.safeParse(raw);
      if (!ch.success || ch.data.collection !== col) return;
      reply({
        oa: 1,
        type: "event",
        event: "db.change",
        collection: col,
        docs: ch.data.docs,
        deleted: ch.data.deleted,
      });
    };
    ws.onclose = (e) => {
      if (disposed || s.ws !== ws || s.refs <= 0) return;
      s.ws = null;
      // 4403 hits every socket on any access change; tell the shell once, then retry as usual.
      if (e?.code === 4403 && !lostFired) {
        lostFired = true;
        onAccessLost?.();
      }
      const delay = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** s.attempt++,
      );
      s.timer = setTimeout(() => {
        if (!disposed && s.refs > 0) connect(col, s);
      }, delay);
    };
  };

  const stop = (s: Sub) => {
    clearTimeout(s.timer);
    const ws = s.ws;
    s.ws = null;
    ws?.close();
  };

  const subscribe = (col: string): boolean => {
    let s = subs.get(col);
    if (!s) {
      if (subs.size >= MAX_SUBSCRIPTIONS) return false;
      s = { ws: null, refs: 0, attempt: 0 };
      subs.set(col, s);
    }
    if (s.refs++ === 0) connect(col, s);
    return true;
  };
  const unsubscribe = (col: string) => {
    const s = subs.get(col);
    if (!s || s.refs === 0) return;
    if (--s.refs === 0) {
      stop(s);
      subs.delete(col);
    }
  };

  const nullIfNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "not_found") return null;
      throw e;
    }
  };

  const anonCall = async <T>(
    mints: boolean,
    go: (extra?: RequestExtra) => Promise<T>,
  ): Promise<T> => {
    if (!anon) return go();
    // Re-check after each wait: a failed mint leaves no token, and only one
    // waiter may become the next minter.
    if (mints) while (!loadAnonToken() && minting) await minting;
    const send = (token: string | null) =>
      go({
        ...(token ? { headers: { [ANON_ID_HEADER]: token } } : {}),
        onResponse: (res) => {
          const t = res.headers.get(ANON_ID_HEADER);
          if (isAnonToken(t)) saveAnonToken(t);
        },
      });
    if (!mints || loadAnonToken()) return send(loadAnonToken());
    // This call mints. Other tabs may be minting too: inside the browser-wide
    // lock, re-read the token so the browser keeps one id (#681).
    const p = withMintLock(() => send(loadAnonToken()), abort.signal);
    const done: Promise<void> = p.then(
      () => {},
      () => {},
    );
    minting = done.then(() => {
      minting = null;
    });
    return p;
  };

  // Aborted on dispose so in-flight calls stop and never reply.
  const http = {
    get: <T>(path: string, schema: z.ZodType<T>) =>
      anonCall(path === R.anonId(id), (x) =>
        api.get(path, schema, abort.signal, x),
      ),
    send: <T = void>(
      method: "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      body: unknown,
      schema?: z.ZodType<T>,
    ) =>
      // POST is only db.query, a read: writes are PUT/PATCH/DELETE and mint
      // (bridge.test.ts "write methods" pins this).
      anonCall(method !== "POST", (x) =>
        api.send(method, path, body, schema, abort.signal, x),
      ),
  };

  async function run(
    method: RuntimeMethod,
    p: Record<string, any>,
  ): Promise<unknown> {
    switch (method) {
      case "db.get":
        return nullIfNotFound(
          http.get(R.dataDoc(id, p.collection, p.id), DataDocSchema),
        );
      case "db.list":
        return http.get(R.dataCollection(id, p.collection) + qs(p), DocPage);
      case "db.query":
        return http.send(
          "POST",
          R.dataQuery(id, p.collection),
          p.query,
          DocPage,
        );
      case "db.set":
        return http.send(
          "PUT",
          R.dataDoc(id, p.collection, p.id),
          p.data ?? null,
          DataDocSchema,
        );
      case "db.update":
        return http.send(
          "PATCH",
          R.dataDoc(id, p.collection, p.id),
          p.patch,
          DataDocSchema,
        );
      case "db.delete":
        await http.send("DELETE", R.dataDoc(id, p.collection, p.id), undefined);
        return null;
      case "db.subscribe":
        if (!subscribe(p.collection))
          throw new ApiClientError(
            "rate_limited",
            "Too many subscriptions",
            429,
          );
        return null;
      case "db.unsubscribe":
        unsubscribe(p.collection);
        return null;
      case "viewer.get":
        return viewer;
      case "viewer.anonId":
        // Only the per-artifact short id; the signed token stays here.
        // Cached per token id and artifact: the route is rate limited per IP,
        // and a failed lookup would cost the page its id (#681).
        if (!anon) return null;
        {
          const cached = loadAnonShort(loadAnonToken(), id);
          if (cached) return cached;
          const { anonId } = await http.get(R.anonId(id), AnonViewerSchema);
          saveAnonShort(loadAnonToken(), id, anonId);
          return anonId;
        }
      case "storage.get": {
        const e = await nullIfNotFound(
          http.get(R.storageKey(id, p.key), StorageEntrySchema),
        );
        return e ? e.value : null;
      }
      case "storage.set": {
        const body: StorageSetBody = { value: p.value ?? null };
        await http.send(
          "PUT",
          R.storageKey(id, p.key),
          body,
          StorageEntrySchema,
        );
        return null;
      }
      case "storage.delete":
        await http.send("DELETE", R.storageKey(id, p.key), undefined);
        return null;
      case "storage.list":
        return http.get(R.storage(id) + qs(p), KeyPage);
    }
  }

  async function handleCall(m: Extract<ArtifactToShell, { type: "call" }>) {
    const method = m.method;
    if (inFlight >= MAX_IN_FLIGHT)
      return fail(m.id, "rate_limited", "Too many concurrent calls");
    if (!artifact.capabilities[METHOD_CAPABILITY[method]])
      return fail(
        m.id,
        "capability_denied",
        `Capability not declared for ${method}`,
      );
    const params = RUNTIME_PARAMS[method].safeParse(m.params);
    if (!params.success)
      return fail(m.id, "bad_request", `Invalid params for ${method}`);
    inFlight++;
    try {
      const value = await run(method, params.data as Record<string, any>);
      const checked = RUNTIME_RESULTS[method].safeParse(value);
      if (!checked.success) return fail(m.id, "internal", "Invalid response");
      ok(m.id, checked.data);
    } catch (e) {
      // The artifact protocol only knows the API's codes.
      if (e instanceof ApiClientError)
        fail(m.id, e.code === "cpu_limit" ? "internal" : e.code, e.message);
      else fail(m.id, "internal", "Internal error");
    } finally {
      inFlight--;
    }
  }

  const onMessage = (ev: Event) => {
    try {
      handle(ev as MessageEvent);
    } catch {
      // Nothing from the untrusted frame may throw out of the listener.
    }
  };

  const handle = (e: MessageEvent) => {
    if (disposed) return;
    if (e.source !== iframe.contentWindow || e.origin !== "null") return;
    const m = parseArtifactMessage(e.data);
    if (!m || m.nonce !== current.nonce) return;
    switch (m.type) {
      case "hello":
        reply({
          oa: 1,
          type: "welcome",
          capabilities: artifact.capabilities,
          viewer,
          theme: opts.theme,
          // The runtime turns plain links to this app into navigate requests.
          appOrigin: location.origin,
        });
        onHello?.();
        break;
      case "call":
        void handleCall(m);
        break;
      case "pdf.text":
        if (
          (opts.formatOf?.() ??
            (opts.version === artifact.currentVersion
              ? artifact.format
              : undefined)) === "pdf" &&
          m.version === opts.version
        )
          onPdfText(m.text);
        break;
      case "thumb.ready": {
        if (!thumbPending) break;
        thumbPending = false;
        const blob = dataUrlToBlob(m.dataUrl);
        if (blob) onThumb(blob);
        break;
      }
      case "navigate":
        opts.onNavigate?.(m.url);
        break;
      case "open":
        opts.onOpen?.(m.url);
        break;
      case "resize":
        if (Number.isFinite(m.height) && m.height >= 0 && m.height <= 100_000)
          onResize?.(m.height);
        break;
      case "interacted":
        onInteracted?.();
        break;
      case "scroll":
        opts.onScroll?.({ top: m.top, max: m.max });
        break;
      case "engaged":
        opts.onEngaged?.(m.engaged);
        break;
    }
  };

  const dispose = () => {
    disposed = true;
    abort.abort();
    window.removeEventListener("message", onMessage);
    iframe.removeEventListener("load", onLoad);
    for (const s of subs.values()) stop(s);
    subs.clear();
  };
  const onLoad = () => {
    if (disposed) return;
    if (frameLoad(iframe) === current && current.expected) {
      current.expected = false;
      return;
    }
    // Not our src assignment: whatever is in the frame now never had the nonce.
    dispose();
    opts.onRenavigated?.();
  };

  window.addEventListener("message", onMessage);
  iframe.addEventListener("load", onLoad);
  const current = loadArtifactFrame(iframe, opts.url);

  return {
    dispose,
    requestThumbnail(): boolean {
      if (disposed) return false;
      thumbPending = true;
      reply({ oa: 1, type: "thumb.request" });
      return true;
    },
    setTheme(t: Theme) {
      reply({ oa: 1, type: "theme", theme: t });
    },
    /** After a live swap: scroll to the previous version's position. */
    scrollTo(pos: ScrollPos) {
      reply({ oa: 1, type: "scroll.to", top: pos.top, max: pos.max });
    },
  };
}
