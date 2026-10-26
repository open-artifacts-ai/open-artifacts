import { ANON_ID_HEADER, type ArtifactSummary, LIMITS, R } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANON_ID_KEY,
  isAnonToken,
  resetAnonMemory,
} from "../src/viewer/anonId";
import { createBridge } from "../src/viewer/bridge";
import { asFrame, FakeFrame, stamped } from "./fake-frame";

const ART = {
  id: "art1",
  title: "T",
  format: "html",
  capabilities: { db: true, viewer: true, storage: false },
} as unknown as ArtifactSummary;
const VIEWER = { email: "a@b.c", name: "A" };
const DOC = { id: "d1", data: { x: 1 }, updatedAt: "now", updatedBy: null };

class FakeWS {
  static all: FakeWS[] = [];
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

let win = new EventTarget();
const live: { dispose(): void }[] = [];
const post = vi.fn();
const contentWindow = { postMessage: post };
let frame = new FakeFrame(contentWindow);
let iframe = asFrame(frame);
const URL_ = "https://content.test/a/v1/index.html";
let fetchMock: ReturnType<typeof vi.fn>;

/** Sends as the frame's runtime: stamped with the current nonce unless `raw`. */
const send = (
  data: unknown,
  o: { source?: unknown; origin?: string; raw?: boolean } = {},
) => {
  const ev = new Event("message");
  Object.assign(ev, {
    data: o.raw ? data : stamped(frame, data),
    source: "source" in o ? o.source : contentWindow,
    origin: o.origin ?? "null",
  });
  win.dispatchEvent(ev);
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const call = (method: string, params: unknown, id = "c1") =>
  send({ oa: 1, type: "call", id, method, params });
const mk = (art = ART) => {
  const b = mkRaw(art);
  live.push(b);
  return b;
};
const mkRaw = (art: ArtifactSummary) =>
  createBridge({
    iframe,
    url: URL_,
    artifact: art,
    version: 1,
    viewer: VIEWER,
    theme: "light",
    onPdfText: vi.fn(),
    onThumb: vi.fn(),
  });
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status });

beforeEach(() => {
  FakeWS.all = [];
  frame = new FakeFrame(contentWindow);
  iframe = asFrame(frame);
  win = new EventTarget();
  post.mockReset();
  fetchMock = vi.fn(async () => json(DOC));
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
});
afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bridge message gating", () => {
  it("forged sources get no fetch and no reply", async () => {
    mk();
    const msg = {
      oa: 1,
      type: "call",
      id: "x",
      method: "db.get",
      params: { collection: "c", id: "d" },
    };
    send(msg, { source: window });
    send(msg, { source: { postMessage: vi.fn() } });
    send(msg, { source: null });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores origin !== 'null'", async () => {
    mk();
    send(
      { oa: 1, type: "hello", protocol: 1, kind: "html" },
      { origin: "https://evil" },
    );
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("drops malformed messages silently", async () => {
    mk();
    send({ oa: 1, type: "call", id: "1", method: "nope", params: {} });
    send("garbage");
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("dispose removes the listener", async () => {
    const b = mk();
    b.dispose();
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    await flush();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("hello / welcome", () => {
  it("sends viewer when capability set, targeting '*'", () => {
    mk();
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "welcome",
        viewer: VIEWER,
        theme: "light",
      }),
      "*",
    );
  });

  it("viewer is null when capabilities.viewer is false", () => {
    mk({ ...ART, capabilities: { db: true, viewer: false, storage: false } });
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    expect(post.mock.calls[0]?.[0].viewer).toBeNull();
  });

  it("viewer.get mirrors the same rule", async () => {
    mk({ ...ART, capabilities: { db: true, viewer: false, storage: false } });
    call("viewer.get", {});
    await flush();
    // capability denied: viewer not declared
    expect(post.mock.calls[0]?.[0].error.code).toBe("capability_denied");
  });
});

describe("calls", () => {
  it("capability_denied makes zero fetches", async () => {
    mk();
    call("storage.get", { key: "k" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "result",
      id: "c1",
      ok: false,
      error: { code: "capability_denied" },
    });
  });

  it("params with another artifactId are bad_request with zero fetches", async () => {
    mk();
    call("db.get", { artifactId: "other", collection: "c", id: "d1" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[0].error.code).toBe("bad_request");
  });

  it("db.get hits only this artifact's route and replies ok", async () => {
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(R.dataDoc("art1", "c", "d1"));
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "result",
      ok: true,
      value: DOC,
    });
  });

  it("maps ApiClientError to code/message", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "rate_limited", message: "slow" } }, 429),
    );
    mk();
    call("db.set", { collection: "c", id: "d1", data: { a: 1 } });
    await flush();
    expect(post.mock.calls[0]?.[0].error).toEqual({
      code: "rate_limited",
      message: "slow",
    });
  });

  it("invalid server response becomes an error reply", async () => {
    fetchMock.mockImplementation(async () => json({ nope: 1 }));
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: false });
  });

  it("db.get not_found resolves null", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "not_found", message: "x" } }, 404),
    );
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: true, value: null });
  });

  it("storage.set sends {value}", async () => {
    fetchMock.mockResolvedValue(json({ key: "k", value: 1, updatedAt: "n" }));
    mk({ ...ART, capabilities: { db: false, viewer: false, storage: true } });
    call("storage.set", { key: "k", value: 1 });
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(R.storageKey("art1", "k"));
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"value":1}');
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: true, value: null });
  });
});

const webp = (n = 0) =>
  `data:image/webp;base64,${btoa(`RIFF\0\0\0\0WEBP${"x".repeat(n)}`)}`;

describe("pdf / thumb / resize", () => {
  const opts = (art = ART) => ({
    iframe,
    url: URL_,
    artifact: art,
    version: 1,
    viewer: null,
    theme: "dark" as const,
    onPdfText: vi.fn(),
    onThumb: vi.fn(),
    onResize: vi.fn(),
  });
  const PDF = { ...ART, format: "pdf" } as unknown as ArtifactSummary;

  it("routes pdf text for this version of a pdf artifact", () => {
    const o = { ...opts(), formatOf: () => "pdf" };
    live.push(createBridge(o));
    send({ oa: 1, type: "pdf.text", version: 1, text: "hi" });
    expect(o.onPdfText).toHaveBeenCalledWith("hi");
  });

  it("uses the shown version's format, not the artifact's", () => {
    const o = { ...opts(PDF), formatOf: () => "html" };
    live.push(createBridge(o));
    send({ oa: 1, type: "pdf.text", version: 1, text: "x" });
    expect(o.onPdfText).not.toHaveBeenCalled();
  });

  it("ignores pdf text from non-pdf artifacts or other versions", () => {
    const o = opts();
    live.push(createBridge(o));
    send({ oa: 1, type: "pdf.text", version: 1, text: "x" });
    const p = { ...opts(), formatOf: () => "pdf" };
    live.push(createBridge(p));
    send({ oa: 1, type: "pdf.text", version: 99, text: "x" });
    expect(o.onPdfText).not.toHaveBeenCalled();
    expect(p.onPdfText).not.toHaveBeenCalled();
  });

  it("routes resize and drops out-of-range heights", () => {
    const o = opts();
    live.push(createBridge(o));
    send({ oa: 1, type: "resize", height: 42 });
    expect(o.onResize).toHaveBeenCalledWith(42);
    send({ oa: 1, type: "resize", height: -1 });
    send({ oa: 1, type: "resize", height: 1e9 });
    expect(o.onResize).toHaveBeenCalledTimes(1);
  });

  it("accepts one thumb only after requestThumbnail", () => {
    const o = opts();
    const b = createBridge(o);
    live.push(b);
    send({ oa: 1, type: "thumb.ready", dataUrl: webp() });
    expect(o.onThumb).not.toHaveBeenCalled();
    b.requestThumbnail();
    send({ oa: 1, type: "thumb.ready", dataUrl: webp() });
    send({ oa: 1, type: "thumb.ready", dataUrl: webp() });
    expect(o.onThumb).toHaveBeenCalledTimes(1);
    const blob = o.onThumb.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/webp");
    expect(blob.size).toBe(12);
  });

  it("rejects thumbs that are not RIFF/WEBP or are too large", () => {
    const o = opts();
    const b = createBridge(o);
    live.push(b);
    for (const dataUrl of [
      "data:image/webp;base64,PHN2Zz4=",
      webp(LIMITS.thumbnailBytes),
    ]) {
      b.requestThumbnail();
      send({ oa: 1, type: "thumb.ready", dataUrl });
    }
    expect(o.onThumb).not.toHaveBeenCalled();
  });

  it("malformed base64 never throws from the listener", () => {
    const b = mk();
    b.requestThumbnail();
    expect(() =>
      send({ oa: 1, type: "thumb.ready", dataUrl: "data:image/webp;base64,A" }),
    ).not.toThrow();
  });

  it("requestThumbnail and setTheme post to the frame", () => {
    const b = mk();
    b.requestThumbnail();
    b.setTheme("dark");
    expect(post).toHaveBeenCalledWith({ oa: 1, type: "thumb.request" }, "*");
    expect(post).toHaveBeenCalledWith(
      { oa: 1, type: "theme", theme: "dark" },
      "*",
    );
  });
});

describe("db.subscribe", () => {
  const sub = (id: string, collection = "c") =>
    call("db.subscribe", { collection }, id);
  const unsub = (id: string, collection = "c") =>
    call("db.unsubscribe", { collection }, id);

  it("refcounts one socket per collection", async () => {
    mk();
    sub("1");
    sub("2");
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0]?.url).toBe(
      `wss://app.test${R.dataSubscribe("art1", "c")}`,
    );
    unsub("3");
    await flush();
    expect(FakeWS.all[0]?.closed).toBe(false);
    unsub("4");
    await flush();
    expect(FakeWS.all[0]?.closed).toBe(true);
  });

  it("forwards change events and drops malformed frames", async () => {
    mk();
    sub("1");
    await flush();
    const ws = FakeWS.all[0];
    post.mockClear();
    ws?.onmessage?.({ data: "not json" });
    ws?.onmessage?.({ data: JSON.stringify({ type: "db.change", docs: 5 }) });
    ws?.onmessage?.({ data: new ArrayBuffer(2) });
    expect(post).not.toHaveBeenCalled();
    ws?.onmessage?.({
      data: JSON.stringify({
        type: "db.change",
        collection: "c",
        docs: [DOC],
        deleted: ["z"],
      }),
    });
    expect(post).toHaveBeenCalledWith(
      {
        oa: 1,
        type: "event",
        event: "db.change",
        collection: "c",
        docs: [DOC],
        deleted: ["z"],
      },
      "*",
    );
  });

  it("reconnects with exponential backoff capped at 30s", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, d] of delays.entries()) {
      expect(FakeWS.all).toHaveLength(i + 1);
      FakeWS.all[i]?.onclose?.();
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(FakeWS.all).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWS.all).toHaveLength(i + 2);
    }
  });

  it("dispose closes sockets and stops reconnecting", async () => {
    vi.useFakeTimers();
    const b = mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]?.onclose?.();
    b.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("dispose closes live sockets", async () => {
    const b = mk();
    sub("1");
    await flush();
    b.dispose();
    expect(FakeWS.all[0]?.closed).toBe(true);
  });

  describe("db.resync", () => {
    const resync = (collection: string) => ({
      oa: 1,
      type: "event",
      event: "db.resync",
      collection,
    });
    const resyncs = () =>
      post.mock.calls.filter(([m]) => m?.event === "db.resync");
    const close = (ws: FakeWS | undefined, code: number) =>
      (ws?.onclose as ((e: { code: number }) => void) | null)?.({ code });

    it("posts one on first open", async () => {
      mk();
      sub("1");
      await flush();
      expect(resyncs()).toHaveLength(0);
      FakeWS.all[0]?.onopen?.();
      expect(resyncs()).toEqual([[resync("c"), "*"]]);
    });

    it("posts another on reconnect after 4408", async () => {
      vi.useFakeTimers();
      mk();
      sub("1");
      await vi.advanceTimersByTimeAsync(0);
      FakeWS.all[0]?.onopen?.();
      close(FakeWS.all[0], 4408);
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWS.all).toHaveLength(2);
      FakeWS.all[1]?.onopen?.();
      expect(resyncs()).toHaveLength(2);
    });

    it("posts none when unsubscribed before open", async () => {
      mk();
      sub("1");
      await flush();
      unsub("2");
      await flush();
      FakeWS.all[0]?.onopen?.();
      expect(resyncs()).toHaveLength(0);
    });

    it("posts none after dispose", async () => {
      const b = mk();
      sub("1");
      await flush();
      b.dispose();
      FakeWS.all[0]?.onopen?.();
      expect(resyncs()).toHaveLength(0);
    });

    it("posts one per collection", async () => {
      mk();
      sub("1", "a");
      sub("2", "b");
      await flush();
      FakeWS.all[0]?.onopen?.();
      FakeWS.all[1]?.onopen?.();
      expect(resyncs().map(([m]) => m.collection)).toEqual(["a", "b"]);
    });
  });
});

describe("db.offline", () => {
  const sub = (id: string, collection = "c") =>
    call("db.subscribe", { collection }, id);
  const offlines = () =>
    post.mock.calls.filter(([m]) => m?.event === "db.offline");
  const resyncs = () =>
    post.mock.calls.filter(([m]) => m?.event === "db.resync");
  const close = (ws: FakeWS | undefined, code = 1006) =>
    (ws?.onclose as ((e: { code: number }) => void) | null)?.({ code });

  it("a refused first socket is offline at once, once, then resyncs on recovery", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    close(FakeWS.all[0]);
    expect(offlines()).toEqual([
      [{ oa: 1, type: "event", event: "db.offline", collection: "c" }, "*"],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    close(FakeWS.all[1]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all).toHaveLength(3);
    expect(offlines()).toHaveLength(1);
    FakeWS.all[2]?.onopen?.();
    expect(resyncs()).toHaveLength(1);
  });

  it("a dropped socket is offline after 3 failed reconnects, and again for a new outage", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]?.onopen?.();
    close(FakeWS.all[0]);
    for (const [i, wait] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(offlines()).toHaveLength(0);
      close(FakeWS.all[i]);
    }
    expect(offlines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    FakeWS.all[4]?.onopen?.();
    expect(resyncs()).toHaveLength(2);
    // A blip that recovers on the first retry stays silent.
    close(FakeWS.all[4]);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWS.all[5]?.onopen?.();
    expect(offlines()).toHaveLength(1);
  });

  it("a handshake that hangs is closed after 10 s and counts as a failure", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(FakeWS.all[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all[0]?.closed).toBe(true);
    // The browser then fires close: a first socket that never opened is offline.
    close(FakeWS.all[0]);
    expect(offlines()).toHaveLength(1);
  });

  it("an open socket is never closed by the connect timeout", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]?.onopen?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWS.all[0]?.closed).toBe(false);
  });

  it("a dropped socket is offline once it has been down 30 s", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]?.onopen?.();
    close(FakeWS.all[0]);
    await vi.advanceTimersByTimeAsync(31_000);
    close(FakeWS.all[1]);
    expect(offlines()).toHaveLength(1);
  });
});

describe("bridge limits", () => {
  it("caps subscribed collections at 32 and replies rate_limited", async () => {
    mk();
    for (let i = 0; i < 33; i++)
      call("db.subscribe", { collection: `c${i}` }, `s${i}`);
    await flush();
    expect(FakeWS.all).toHaveLength(32);
    const last = post.mock.calls.find((c) => c[0].id === "s32")?.[0];
    expect(last.error.code).toBe("rate_limited");
  });

  it("caps in-flight calls at 64 with no extra fetch", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    mk({ ...ART, capabilities: { db: false, viewer: false, storage: true } });
    for (let i = 0; i < 65; i++) call("storage.get", { key: "k" }, `g${i}`);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(64);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      id: "g64",
      error: { code: "rate_limited" },
    });
  });

  it("posts nothing for a call that resolves after dispose", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (release = r)),
    );
    const b = mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    b.dispose();
    release(json(DOC));
    await flush();
    await flush();
    expect(post).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });
});

describe("anonymous id", () => {
  const TOKEN = `${"a".repeat(21)}A.${"b".repeat(42)}A`;
  const TOKEN2 = `${"c".repeat(21)}A.${"d".repeat(42)}A`;
  const OPT_IN = { ...ART, allowAnonymousWrites: true } as ArtifactSummary;
  const mkAnon = (
    art: ArtifactSummary,
    viewer: typeof VIEWER | null = null,
  ) => {
    const b = createBridge({
      iframe,
      url: URL_,
      artifact: art,
      version: 1,
      viewer,
      theme: "light",
      onPdfText: vi.fn(),
      onThumb: vi.fn(),
    });
    live.push(b);
    return b;
  };
  const headerOf = (i: number) =>
    new Headers(
      (fetchMock.mock.calls[i]?.[1] as RequestInit | undefined)?.headers,
    ).get(ANON_ID_HEADER);
  const withToken = (t: string, body: unknown = DOC) =>
    new Response(JSON.stringify(body), { headers: { [ANON_ID_HEADER]: t } });
  let store: Map<string, string>;
  const okStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const blocked = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const resultOf = (rid: string) =>
    post.mock.calls.find((c) => c[0].id === rid)?.[0];

  beforeEach(() => {
    store = new Map();
    resetAnonMemory();
  });

  it("stores a minted token under one key and sends it on later calls", async () => {
    vi.stubGlobal("localStorage", okStorage);
    fetchMock.mockImplementationOnce(async () => withToken(TOKEN));
    mkAnon(OPT_IN);
    call("db.get", { collection: "c", id: "d1" }, "a");
    await flush();
    expect(headerOf(0)).toBeNull();
    expect([...store]).toEqual([[ANON_ID_KEY, TOKEN]]);
    call("db.set", { collection: "c", id: "d1", data: 1 }, "b");
    await flush();
    expect(headerOf(1)).toBe(TOKEN);
  });

  it("replaces the token when the server mints a new one", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, TOKEN);
    fetchMock.mockImplementationOnce(async () => withToken(TOKEN2));
    mkAnon(OPT_IN);
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(headerOf(0)).toBe(TOKEN);
    expect(store.get(ANON_ID_KEY)).toBe(TOKEN2);
  });

  it("accepts 2-part (v1) and 3-part (v2) tokens, rejects malformed ones", () => {
    const id = `${"a".repeat(21)}A`;
    const sig = `${"b".repeat(42)}A`;
    expect(isAnonToken(`${id}.${sig}`)).toBe(true);
    expect(isAnonToken(`${id}.t2k9z0.${sig}`)).toBe(true);
    for (const bad of [
      `${id}.t2k9z0.x.${sig}`, // 4 parts
      `${id}.T2K9Z0.${sig}`, // uppercase iat
      `${id}.t2k9z0.${sig}A`, // wrong sig length
      `${id}.t2k9z0.${sig.slice(1)}`,
      `${id}..${sig}`, // empty iat
      `${id}.${"1".repeat(11)}.${sig}`, // iat too long
    ])
      expect(isAnonToken(bad)).toBe(false);
  });

  it("stores a renewed 3-part token in place of the old one", async () => {
    vi.stubGlobal("localStorage", okStorage);
    const RENEWED = `${"a".repeat(21)}A.t2k9z0.${"e".repeat(42)}A`;
    store.set(ANON_ID_KEY, TOKEN);
    fetchMock.mockImplementationOnce(async () => withToken(RENEWED));
    mkAnon(OPT_IN);
    call("db.set", { collection: "c", id: "d1", data: 1 }, "a");
    await flush();
    expect(headerOf(0)).toBe(TOKEN);
    expect(store.get(ANON_ID_KEY)).toBe(RENEWED);
    call("db.set", { collection: "c", id: "d1", data: 2 }, "b");
    await flush();
    expect(headerOf(1)).toBe(RENEWED);
  });

  it("falls back to memory when storage is blocked, never throwing", async () => {
    vi.stubGlobal("localStorage", blocked);
    fetchMock.mockImplementationOnce(async () => withToken(TOKEN));
    mkAnon(OPT_IN);
    call("db.get", { collection: "c", id: "d1" }, "a");
    await flush();
    expect(resultOf("a")).toMatchObject({ ok: true });
    call("db.get", { collection: "c", id: "d1" }, "b");
    await flush();
    expect(headerOf(1)).toBe(TOKEN);
  });

  it("works with no localStorage at all", async () => {
    vi.stubGlobal("localStorage", undefined);
    fetchMock.mockImplementationOnce(async () => withToken(TOKEN));
    mkAnon(OPT_IN);
    call("db.get", { collection: "c", id: "d1" }, "a");
    await flush();
    call("db.get", { collection: "c", id: "d1" }, "b");
    await flush();
    expect(headerOf(1)).toBe(TOKEN);
  });

  it("ignores a malformed token from the server or storage", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, "bad token");
    fetchMock.mockImplementationOnce(async () => withToken("nope"));
    mkAnon(OPT_IN);
    call("db.get", { collection: "c", id: "d1" }, "a");
    await flush();
    expect(headerOf(0)).toBeNull();
    expect(store.get(ANON_ID_KEY)).toBe("bad token");
  });

  it("concurrent first writes wait for one minted token; reads don't", async () => {
    vi.stubGlobal("localStorage", okStorage);
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (release = r)),
    );
    mkAnon(OPT_IN);
    call("db.set", { collection: "c", id: "d1", data: 1 }, "a");
    call("db.set", { collection: "c", id: "d2", data: 2 }, "b");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    call("db.get", { collection: "c", id: "d1" }, "r");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mock.calls.pop();
    release(withToken(TOKEN));
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(1)).toBe(TOKEN);
  });

  it("after a failed first mint, a burst of writes mints exactly once more", async () => {
    vi.stubGlobal("localStorage", okStorage);
    let fail!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (fail = r)),
    );
    fetchMock.mockImplementationOnce(async () => withToken(TOKEN));
    mkAnon(OPT_IN);
    call("db.set", { collection: "c", id: "d0", data: 0 }, "a");
    await flush();
    for (const n of [1, 2, 3])
      call("db.set", { collection: "c", id: `d${n}`, data: n }, `w${n}`);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fail(json({ error: { code: "internal", message: "boom" } }, 500));
    for (let i = 0; i < 6; i++) await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Only one of the three went token-less (the one mint); the rest carry it.
    expect([1, 2, 3].map(headerOf).filter((h) => h === null)).toHaveLength(1);
    expect([1, 2, 3].map(headerOf).filter((h) => h === TOKEN)).toHaveLength(2);
    expect(resultOf("a")).toMatchObject({ ok: false });
  });

  it("write methods: db writes are never POST (POST is only db.query)", async () => {
    vi.stubGlobal("localStorage", okStorage);
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/query")
        ? json({ items: [], nextCursor: null })
        : json(DOC),
    );
    mkAnon(OPT_IN);
    call("db.set", { collection: "c", id: "d1", data: 1 }, "s");
    call("db.update", { collection: "c", id: "d1", patch: { x: 1 } }, "u");
    call("db.delete", { collection: "c", id: "d1" }, "d");
    call("db.query", { collection: "c", query: {} }, "q");
    for (let i = 0; i < 4; i++) await flush();
    const sent = fetchMock.mock.calls
      .map((c) => `${(c[1] as RequestInit).method} ${c[0]}`)
      .sort();
    const doc = R.dataDoc("art1", "c", "d1");
    expect(sent).toEqual(
      [
        `DELETE ${doc}`,
        `PATCH ${doc}`,
        `POST ${R.dataQuery("art1", "c")}`,
        `PUT ${doc}`,
      ].sort(),
    );
  });

  it("no header when signed in, even with a stored token", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, TOKEN);
    fetchMock.mockImplementation(async () => withToken(TOKEN2));
    mkAnon(OPT_IN, VIEWER);
    call("db.set", { collection: "c", id: "d1", data: 1 }, "a");
    call("viewer.get", {}, "b");
    call("viewer.anonId", {}, "c");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headerOf(0)).toBeNull();
    expect(store.get(ANON_ID_KEY)).toBe(TOKEN);
    expect(resultOf("b")?.value).toEqual(VIEWER);
    expect(resultOf("c")).toMatchObject({ ok: true, value: null });
  });

  it("no header on an artifact without allowAnonymousWrites", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, TOKEN);
    mkAnon(ART);
    call("db.get", { collection: "c", id: "d1" }, "a");
    call("viewer.get", {}, "b");
    call("viewer.anonId", {}, "c");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headerOf(0)).toBeNull();
    expect(resultOf("b")?.value).toBeNull();
    expect(resultOf("c")).toMatchObject({ ok: true, value: null });
  });

  it("regression: viewer.get stays null for an anonymous viewer of an opt-in artifact", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, TOKEN);
    mkAnon(OPT_IN);
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    call("viewer.get", {}, "g");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resultOf("g")).toMatchObject({ ok: true, value: null });
    expect(
      post.mock.calls.find((c) => c[0].type === "welcome")?.[0].viewer,
    ).toBeNull();
  });

  it("viewer.anonId gives the frame only the short id, never the token", async () => {
    vi.stubGlobal("localStorage", okStorage);
    store.set(ANON_ID_KEY, TOKEN);
    fetchMock.mockImplementation(async () => json({ anonId: "aaaaaaaa" }));
    mkAnon(OPT_IN);
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    call("viewer.anonId", {}, "v");
    await flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(R.anonId("art1"));
    expect(headerOf(0)).toBe(TOKEN);
    expect(resultOf("v")).toMatchObject({ ok: true, value: "aaaaaaaa" });
    expect(JSON.stringify(post.mock.calls)).not.toContain(TOKEN.slice(0, 22));
  });

  it("viewer.anonId needs the viewer capability", async () => {
    mkAnon({
      ...OPT_IN,
      capabilities: { db: true, viewer: false, storage: false },
    });
    call("viewer.anonId", {}, "v");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resultOf("v")?.error.code).toBe("capability_denied");
  });
});
