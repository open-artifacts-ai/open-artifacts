import {
  type ArtifactSummary,
  accessChangedCloseReason,
  LIMITS,
  R,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/api/client";
import { createBridge } from "../src/viewer/bridge";
import {
  createSideEffects,
  truncateUtf8,
} from "../src/viewer/useArtifactSideEffects";
import { asFrame, FakeFrame, stamped } from "./fake-frame";

let n = 0;
const art = (o: Partial<ArtifactSummary> = {}) =>
  ({
    id: `fx${++n}`,
    format: "html",
    currentVersion: 3,
    thumbnailUrl: null,
    thumbnailVersion: null,
    access: "editor",
    capabilities: { db: true, viewer: true, storage: false },
    ...o,
  }) as unknown as ArtifactSummary;

const setup = (
  a: ArtifactSummary,
  o: {
    version?: number;
    info?: { format: string; textIndexed: boolean } | undefined;
  } = {},
) => {
  const requestThumbnail = vi.fn(() => true);
  const put = vi.fn(async () => {});
  const invalidate = vi.fn();
  const fx = createSideEffects({
    artifact: a,
    version: o.version ?? a.currentVersion,
    getInfo: () =>
      "info" in o ? o.info : { format: a.format, textIndexed: false },
    requestThumbnail,
    put,
    invalidate,
  });
  return { fx, requestThumbnail, put, invalidate };
};
const blob = (size: number) => new Blob([new Uint8Array(size)]);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("thumbnails", () => {
  it("requests a thumbnail for a space manager", () => {
    const { fx, requestThumbnail } = setup(art({ access: "manager" }));
    fx.onHello();
    expect(requestThumbnail).toHaveBeenCalledTimes(1);
  });
  it("never requests one for a viewer", () => {
    const { fx, requestThumbnail } = setup(art({ access: "viewer" }));
    fx.onHello();
    expect(requestThumbnail).not.toHaveBeenCalled();
  });
  it("requests once after hello for an editor without a thumbnail", () => {
    const { fx, requestThumbnail } = setup(art());
    fx.onHello();
    fx.onHello();
    expect(requestThumbnail).toHaveBeenCalledTimes(1);
  });
  it("does not request when the thumbnail is current", () => {
    const { fx, requestThumbnail } = setup(
      art({ thumbnailUrl: "/t?v=3", thumbnailVersion: 3 }),
    );
    fx.onHello();
    expect(requestThumbnail).not.toHaveBeenCalled();
  });
  it("requests when the thumbnail is stale", () => {
    const { fx, requestThumbnail } = setup(
      art({ thumbnailUrl: "/t?v=2", thumbnailVersion: 2 }),
    );
    fx.onHello();
    expect(requestThumbnail).toHaveBeenCalledTimes(1);
  });
  it("does not request while viewing an older version", () => {
    const { fx, requestThumbnail } = setup(art(), { version: 2 });
    fx.onHello();
    expect(requestThumbnail).not.toHaveBeenCalled();
  });
  it("treats 409 as up to date: refreshes, no log", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { fx, put, invalidate } = setup(art());
    put.mockRejectedValue(new ApiClientError("conflict", "stale", 409));
    fx.onThumb(blob(10));
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
  it("does not request for a viewer", () => {
    const { fx, requestThumbnail } = setup(art({ access: "viewer" }));
    fx.onHello();
    expect(requestThumbnail).not.toHaveBeenCalled();
  });
  it("drops an oversized blob", async () => {
    const { fx, put } = setup(art());
    fx.onThumb(blob(LIMITS.thumbnailBytes + 1));
    await flush();
    expect(put).not.toHaveBeenCalled();
  });
  it("uploads then invalidates", async () => {
    const a = art();
    const { fx, put, invalidate } = setup(a);
    const b = blob(10);
    fx.onThumb(b);
    await flush();
    expect(put).toHaveBeenCalledWith(
      `${R.thumbnail(a.id)}?v=3`,
      b,
      "image/webp",
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it("fails silently", async () => {
    const { fx, put, invalidate } = setup(art());
    put.mockRejectedValue(new Error("x"));
    fx.onThumb(blob(10));
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("pdf text", () => {
  const pdf = () => art({ format: "pdf" });
  it("is sent only once per version", async () => {
    const a = pdf();
    const s = setup(a);
    s.fx.onPdfText("hello");
    s.fx.onPdfText("hello");
    await flush();
    const t = setup(a);
    t.fx.onPdfText("hello");
    await flush();
    expect(s.put).toHaveBeenCalledTimes(1);
    expect(s.put).toHaveBeenCalledWith(
      R.versionText(a.id, 3),
      "hello",
      "text/plain",
    );
    expect(t.put).not.toHaveBeenCalled();
    expect(s.invalidate).toHaveBeenCalledTimes(1);
  });
  it("keeps text that arrives before version info and sends it once info lands", async () => {
    const a = pdf();
    let info: { format: string; textIndexed: boolean } | undefined;
    const s = setup(a);
    const fx = createSideEffects({
      artifact: a,
      version: 3,
      getInfo: () => info,
      requestThumbnail: s.requestThumbnail,
      put: s.put,
      invalidate: s.invalidate,
    });
    fx.onPdfText("old");
    fx.onPdfText("latest");
    await flush();
    expect(s.put).not.toHaveBeenCalled();
    info = { format: "pdf", textIndexed: false };
    fx.flushPending();
    fx.flushPending();
    await flush();
    expect(s.put).toHaveBeenCalledTimes(1);
    expect((s.put.mock.calls[0] as unknown[])[1]).toBe("latest");
  });
  it("does not mark the thumbnail asked when no request was issued", () => {
    const a = art();
    const s = setup(a);
    s.requestThumbnail.mockReturnValueOnce(false);
    s.fx.onHello();
    s.fx.onHello();
    expect(s.requestThumbnail).toHaveBeenCalledTimes(2);
  });
  it("skips a non-current version", async () => {
    const a = pdf();
    const { fx, put } = setup(a, { version: 2 });
    fx.onPdfText("x");
    await flush();
    expect(put).not.toHaveBeenCalled();
  });
  it("skips when already indexed, non-pdf, unknown info, or a viewer", async () => {
    for (const [a, o] of [
      [pdf(), { info: { format: "pdf", textIndexed: true } }],
      [pdf(), { info: { format: "html", textIndexed: false } }],
      [art({ format: "pdf", access: "viewer" }), {}],
    ] as const) {
      const { fx, put } = setup(a, o);
      fx.onPdfText("x");
      await flush();
      expect(put).not.toHaveBeenCalled();
    }
  });
  it("truncates by UTF-8 bytes without splitting a surrogate pair", async () => {
    const max = LIMITS.extractedTextBytes;
    const enc = new TextEncoder();
    const cut = truncateUtf8("a".repeat(max - 2) + "😀", max);
    expect(cut).toBe("a".repeat(max - 2));
    const fit = "a".repeat(max - 4) + "😀";
    expect(truncateUtf8(fit, max)).toBe(fit);
    expect(
      enc.encode(truncateUtf8("é".repeat(max), max)).length,
    ).toBeLessThanOrEqual(max);
    const a = pdf();
    const { fx, put } = setup(a);
    fx.onPdfText("a".repeat(max - 2) + "😀");
    await flush();
    expect((put.mock.calls[0] as unknown[])[1]).toBe("a".repeat(max - 2));
  });
});

describe("bridge follow-ups", () => {
  class FakeWS {
    static all: FakeWS[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: { code: number; reason?: string }) => void) | null = null;
    constructor(public url: string) {
      FakeWS.all.push(this);
    }
    close() {}
  }
  let win: EventTarget;
  const post = vi.fn();
  const contentWindow = { postMessage: post };
  const live: { dispose(): void }[] = [];
  let frame = new FakeFrame(contentWindow);
  beforeEach(() => {
    frame = new FakeFrame(contentWindow);
    FakeWS.all = [];
    post.mockReset();
    win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("WebSocket", FakeWS);
    vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
  });
  afterEach(() => {
    for (const b of live.splice(0)) b.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const mk = (extra: object = {}) => {
    const b = createBridge({
      iframe: asFrame(frame),
      url: "https://content.test/a/v1/index.html",
      artifact: art(),
      version: 1,
      viewer: null,
      theme: "light",
      onPdfText: vi.fn(),
      onThumb: vi.fn(),
      ...extra,
    });
    live.push(b);
    return b;
  };
  const send = (data: unknown) => {
    const ev = new Event("message");
    Object.assign(ev, {
      data: stamped(frame, data),
      source: contentWindow,
      origin: "null",
    });
    win.dispatchEvent(ev);
  };
  const sub = async () => {
    send({
      oa: 1,
      type: "call",
      id: "c",
      method: "db.subscribe",
      params: { collection: "c" },
    });
    await flush();
    return FakeWS.all[0];
  };

  it("calls onHello on hello", () => {
    const onHello = vi.fn();
    mk({ onHello });
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    expect(onHello).toHaveBeenCalledTimes(1);
  });
  it("close 4403 notifies onAccessLost and still reconnects", async () => {
    const onAccessLost = vi.fn();
    mk({ onAccessLost });
    const ws = await sub();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ws.onclose?.({ code: 4403 });
    vi.advanceTimersByTime(1_000);
    expect(onAccessLost).toHaveBeenCalledTimes(1);
    expect(FakeWS.all).toHaveLength(2);
  });
  // #816: a data socket opened just as access changed is closed 4403 with a
  // retry hint in its reason; the reconnect holds at least that long.
  it("a 4403 with a retry hint reconnects no sooner than it says", async () => {
    mk({ onAccessLost: vi.fn() });
    const ws = await sub();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ws.onclose?.({ code: 4403, reason: accessChangedCloseReason(3_000) });
    vi.advanceTimersByTime(2_999);
    expect(FakeWS.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("a 4403 without a hint (access revoked) keeps the usual backoff", async () => {
    mk({ onAccessLost: vi.fn() });
    const ws = await sub();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ws.onclose?.({ code: 4403, reason: "access revoked" });
    vi.advanceTimersByTime(1_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it("one 4403 burst across subscriptions fires onAccessLost once", async () => {
    const onAccessLost = vi.fn();
    mk({ onAccessLost });
    const sockets = [];
    for (const c of ["a", "b", "c"]) {
      send({
        oa: 1,
        type: "call",
        id: c,
        method: "db.subscribe",
        params: { collection: c },
      });
      await flush();
      sockets.push(FakeWS.all[FakeWS.all.length - 1]);
    }
    for (const ws of sockets) ws.onclose?.({ code: 4403 });
    expect(onAccessLost).toHaveBeenCalledTimes(1);
  });
  it("other close codes still reconnect", async () => {
    const onAccessLost = vi.fn();
    mk({ onAccessLost });
    const ws = await sub();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ws.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1_000);
    expect(FakeWS.all).toHaveLength(2);
    expect(onAccessLost).not.toHaveBeenCalled();
  });
  it("forwards db.change docs with data: null unchanged", async () => {
    mk();
    const ws = await sub();
    const doc = { id: "d", data: null, updatedAt: "t", updatedBy: null };
    ws.onmessage?.({
      data: JSON.stringify({
        type: "db.change",
        collection: "c",
        docs: [doc],
        deleted: [],
      }),
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db.change", docs: [doc] }),
      "*",
    );
  });
});
