import type { ArtifactSummary } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridge } from "../src/viewer/bridge";
import { asFrame, FakeFrame, stamped } from "./fake-frame";

const ART = {
  id: "art1",
  title: "T",
  format: "html",
  capabilities: { db: true, viewer: true, storage: false },
} as unknown as ArtifactSummary;
const DOC = { id: "d1", data: { x: 1 }, updatedAt: "now", updatedBy: null };
const URL_ = "https://content.test/a/v1/index.html";
const HELLO = { oa: 1, type: "hello", protocol: 1, kind: "html" };
const GET = {
  oa: 1,
  type: "call",
  id: "x",
  method: "db.get",
  params: { collection: "c", id: "d" },
};

let win: EventTarget;
let frame: FakeFrame;
const post = vi.fn();
const contentWindow = { postMessage: post };
const live: { dispose(): void }[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
// Zero-delay turn on the fake clock: queued promise work and 0 ms timers run.
const flush = () => vi.advanceTimersByTimeAsync(0);
/** Posts `data` as is (no nonce added). */
const raw = (data: unknown) => {
  const ev = new Event("message");
  Object.assign(ev, { data, source: contentWindow, origin: "null" });
  win.dispatchEvent(ev);
};
/** Posts as the frame's runtime would: with the current nonce. */
const send = (data: unknown) => raw(stamped(frame, data));
const nonceOf = (src: string) => /#oa=([\w-]+)$/.exec(src)?.[1];
const mk = (extra: object = {}) => {
  const b = createBridge({
    iframe: asFrame(frame),
    url: URL_,
    artifact: ART,
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

beforeEach(() => {
  vi.useFakeTimers();
  win = new EventTarget();
  frame = new FakeFrame(contentWindow);
  post.mockReset();
  fetchMock = vi.fn(async () => json(DOC));
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
});
afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bridge per-load nonce", () => {
  it("loads the frame at url#oa=<22-char base64url nonce>", () => {
    mk();
    expect(frame.src.startsWith(`${URL_}#oa=`)).toBe(true);
    expect(nonceOf(frame.src)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("appends &oa= when the URL already has a fragment", () => {
    mk({ url: `${URL_}#top` });
    expect(frame.src).toMatch(/#top&oa=[\w-]{22}$/);
  });

  it("drops a message with a wrong or missing nonce", async () => {
    mk();
    raw(HELLO);
    raw({ ...HELLO, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    raw(GET);
    raw({ ...GET, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    send(HELLO);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ type: "welcome" });
  });

  it("an intentional reload re-arms with a fresh nonce; the old one is dropped", () => {
    const a = mk();
    const first = nonceOf(frame.src);
    frame.loaded();
    a.dispose();
    mk();
    const second = nonceOf(frame.src);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    frame.loaded(); // the reload's own load: still armed
    raw({ ...HELLO, nonce: first });
    expect(post).not.toHaveBeenCalled();
    raw({ ...HELLO, nonce: second });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("before the frame's load event, a document without the current nonce is dropped", async () => {
    // A previous load's document (stale nonce) and a renavigated one (no nonce,
    // or a guessed one) both post hello in the pre-load window.
    const a = mk();
    const stale = nonceOf(frame.src);
    a.dispose();
    mk();
    const current = nonceOf(frame.src);
    expect(current).not.toBe(stale);
    raw({ ...HELLO, nonce: stale });
    raw(HELLO);
    raw({ ...HELLO, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    raw({ ...GET, nonce: stale });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Still before load: only the current nonce is answered.
    raw({ ...HELLO, nonce: current });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ type: "welcome" });
  });

  it("a load we didn't start disposes the bridge: no reply, no fetch", async () => {
    const onRenavigated = vi.fn();
    const b = mk({ onRenavigated });
    frame.loaded(); // ours
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    send(GET);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    frame.loaded(); // renavigated by someone else
    expect(onRenavigated).toHaveBeenCalledTimes(1);
    release(json(DOC));
    await flush();
    // Even a message carrying the old nonce gets nothing now.
    send(HELLO);
    send({ ...GET, id: "y" });
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.requestThumbnail()).toBe(false);
  });
});

describe("bridge navigate", () => {
  const NAV = { oa: 1, type: "navigate", url: "https://app.test/a/B" };

  it("welcome carries the app origin", () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "app.test",
      origin: "https://app.test",
    });
    mk();
    send(HELLO);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "welcome",
      appOrigin: "https://app.test",
    });
  });

  it("forwards navigate only with the current nonce, source and null origin", () => {
    const onNavigate = vi.fn();
    mk({ onNavigate });
    raw(NAV);
    raw({ ...NAV, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    const ev = new Event("message");
    Object.assign(ev, {
      data: stamped(frame, NAV),
      source: {},
      origin: "null",
    });
    win.dispatchEvent(ev);
    const ev2 = new Event("message");
    Object.assign(ev2, {
      data: stamped(frame, NAV),
      source: contentWindow,
      origin: "https://content.test",
    });
    win.dispatchEvent(ev2);
    expect(onNavigate).not.toHaveBeenCalled();
    send(NAV);
    expect(onNavigate).toHaveBeenCalledWith("https://app.test/a/B");
  });

  it("drops navigate after a renavigation disposed the bridge", () => {
    const onNavigate = vi.fn();
    mk({ onNavigate });
    frame.loaded(); // ours
    const stale = stamped(frame, NAV);
    frame.loaded(); // not ours
    raw(stale);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("bridge open", () => {
  const OPEN = { oa: 1, type: "open", url: "https://other.example/x" };

  it("forwards open only with the current nonce", () => {
    const onOpen = vi.fn();
    mk({ onOpen });
    raw(OPEN);
    raw({ ...OPEN, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(onOpen).not.toHaveBeenCalled();
    send(OPEN);
    expect(onOpen).toHaveBeenCalledWith("https://other.example/x");
  });
});
