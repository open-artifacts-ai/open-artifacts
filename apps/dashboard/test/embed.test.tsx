// Embed mode (framed /a/<id>/full): fail-closed self-detection, anonymous
// request options, the bridge's socket hint and viewer, and the router lock.
import type { ArtifactSummary } from "@oa/shared";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, requestInit } from "../src/api/client";
import {
  detectEmbed,
  isFullPath,
  lockToPath,
  setEmbedForTests,
} from "../src/embed";
import { createBridge } from "../src/viewer/bridge";
import { asFrame, FakeFrame, stamped } from "./fake-frame";

afterEach(() => {
  setEmbedForTests(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectEmbed", () => {
  it("is false at top level", () => {
    const w = {} as Window & typeof globalThis;
    expect(detectEmbed({ self: w, top: w })).toBe(false);
  });
  it("is true in a frame", () => {
    const a = {} as Window & typeof globalThis;
    const b = {} as Window & typeof globalThis;
    expect(detectEmbed({ self: a, top: b })).toBe(true);
  });
  it("fails closed: a throwing top means framed", () => {
    const w = {} as Window & typeof globalThis;
    const throws = {
      self: w,
      get top(): Window & typeof globalThis {
        throw new DOMException("cross-origin", "SecurityError");
      },
    };
    expect(detectEmbed(throws)).toBe(true);
  });
  it("is false in this (top-level) test document", () => {
    expect(detectEmbed()).toBe(false);
  });
});

describe("requestInit", () => {
  it("top level: same-origin credentials, no embed hint", () => {
    const init = requestInit({ method: "GET" });
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("X-OA-Embed")).toBe(false);
  });
  it("framed: credentials omit and X-OA-Embed: 1, over whatever was asked", () => {
    setEmbedForTests(true);
    const init = requestInit({
      method: "POST",
      credentials: "include",
      headers: { "X-OA-Request": "1" },
    });
    expect(init.credentials).toBe("omit");
    const h = new Headers(init.headers);
    expect(h.get("X-OA-Embed")).toBe("1");
    expect(h.get("X-OA-Request")).toBe("1");
  });
  it("framed: every api call goes out that way", async () => {
    setEmbedForTests(true);
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await api.getText("/api/v1/x");
    await api.send("POST", "/api/v1/y", { a: 1 });
    await api.putBody("/api/v1/z", "b", "text/plain");
    expect(f).toHaveBeenCalledTimes(3);
    for (const [, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).get("X-OA-Embed")).toBe("1");
    }
  });
  it("framed: XHR uploads (which always carry cookies) are refused", async () => {
    setEmbedForTests(true);
    const open = vi.spyOn(XMLHttpRequest.prototype, "open");
    await expect(
      api.putRaw("/api/v1/u", new Blob(["x"]), "text/plain"),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("bridge, framed", () => {
  const ART = {
    id: "art1",
    title: "T",
    format: "html",
    capabilities: { db: true, viewer: true, storage: false },
  } as unknown as ArtifactSummary;
  const urls: string[] = [];
  const post = vi.fn();
  const contentWindow = { postMessage: post };
  let frame = new FakeFrame(contentWindow);
  let win = new EventTarget();
  let bridge: { dispose(): void } | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  const send = (data: unknown) => {
    const ev = new Event("message");
    Object.assign(ev, {
      data: stamped(frame, data),
      source: contentWindow,
      origin: "null",
    });
    win.dispatchEvent(ev);
  };
  const mk = (art: ArtifactSummary) => {
    bridge?.dispose();
    frame = new FakeFrame(contentWindow);
    bridge = createBridge({
      iframe: asFrame(frame),
      url: "https://content.test/a/v1/index.html",
      artifact: art,
      version: 1,
      // Even if a caller passed one, the frame never gets it.
      viewer: { email: "a@b.c", name: "A" },
      theme: "light",
      onPdfText: vi.fn(),
      onThumb: vi.fn(),
    });
    frame.loaded();
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    urls.length = 0;
    post.mockReset();
    win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string) {
          urls.push(url);
        }
        close() {}
      },
    );
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setEmbedForTests(true);
    mk(ART);
  });
  afterEach(() => bridge?.dispose());

  it("the data socket carries embed=1", async () => {
    send({
      oa: 1,
      type: "call",
      id: "s",
      method: "db.subscribe",
      params: { collection: "votes" },
    });
    await flush();
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0] as string);
    expect(u.searchParams.get("embed")).toBe("1");
    expect(u.searchParams.get("collection")).toBe("votes");
  });

  it("welcome and viewer.get carry no viewer", async () => {
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    send({ oa: 1, type: "call", id: "v", method: "viewer.get", params: {} });
    await flush();
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "welcome",
      viewer: null,
    });
    expect(post.mock.calls[1]?.[0]).toMatchObject({
      id: "v",
      ok: true,
      value: null,
    });
    expect(JSON.stringify(post.mock.calls)).not.toContain("a@b.c");
  });

  it("viewer.anonId works for anonymous-write artifacts, anonymously", async () => {
    mk({
      ...ART,
      visibility: "public",
      dataWriters: "viewers",
    } as ArtifactSummary);
    const token = `${"a".repeat(22)}.${"b".repeat(43)}`;
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ anonId: "abcd1234" }), {
          status: 200,
          headers: { "X-OA-Anon-Id": token },
        }),
    );
    send({ oa: 1, type: "call", id: "a", method: "viewer.anonId", params: {} });
    await vi.waitFor(() =>
      expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
        id: "a",
        ok: true,
        value: "abcd1234",
      }),
    );
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/artifacts/art1/anon-id");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("X-OA-Embed")).toBe("1");
    // The signed token never enters the frame.
    expect(JSON.stringify(post.mock.calls)).not.toContain(token);
  });
});

describe("lockToPath", () => {
  const FULL = "/a/abc/full";
  let unlock: () => void = () => {};
  afterEach(() => unlock());

  it("isFullPath matches only /a/<id>/full", () => {
    expect(isFullPath(FULL)).toBe(true);
    expect(isFullPath("/A/abc/FULL/")).toBe(true);
    for (const p of ["/a/abc", "/a/abc/v/2", "/", "/a/abc/full/x", "/settings"])
      expect(isFullPath(p)).toBe(false);
  });

  it("drops router navigation to another path, allows same-path", async () => {
    const history = createMemoryHistory({ initialEntries: [FULL] });
    unlock = lockToPath({ history }, FULL);
    history.push("/settings/profile");
    await Promise.resolve();
    expect(history.location.pathname).toBe(FULL);
    history.replace("/a/other/full");
    await Promise.resolve();
    expect(history.location.pathname).toBe(FULL);
    history.replace(`${FULL}?x=1`);
    await vi.waitFor(() => expect(history.location.search).toBe("?x=1"));
  });

  it("drops raw history.pushState / replaceState to another path", () => {
    window.history.replaceState(null, "", FULL);
    unlock = lockToPath(
      { history: createMemoryHistory({ initialEntries: [FULL] }) },
      FULL,
    );
    window.history.pushState(null, "", "/settings");
    window.history.replaceState(null, "", "/");
    expect(location.pathname).toBe(FULL);
    window.history.replaceState(null, "", `${FULL}#h`);
    expect(location.hash).toBe("#h");
  });

  it("link clicks open a new tab with noopener and never reach app handlers", () => {
    unlock = lockToPath(
      { history: createMemoryHistory({ initialEntries: [FULL] }) },
      FULL,
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const a = document.createElement("a");
    a.href = "/settings/profile";
    const inner = document.createElement("span");
    a.append(inner);
    const appHandler = vi.fn();
    a.addEventListener("click", appHandler);
    document.body.append(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    inner.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(appHandler).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      `${location.origin}/settings/profile`,
      "_blank",
      "noopener",
    );
    a.href = "javascript:alert(1)";
    inner.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    a.remove();
  });
});
