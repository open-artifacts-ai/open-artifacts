import type { ArtifactToShell, DataDoc } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_TIMEOUT_MS,
  HANDSHAKE_MS,
  RAW_VIEW_MESSAGE,
} from "../src/bridge.js";
import {
  createRuntime,
  type OpenArtifacts,
  RuntimeError,
} from "../src/index.js";
import * as schemas from "../src/schemas.js";

type Call = Extract<ArtifactToShell, { type: "call" }>;

const doc = (id: string, data: unknown): DataDoc => ({
  id,
  data,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "u:1",
});

/** Microtask flush (works under fake timers too). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;

const sent = (): ArtifactToShell[] =>
  parent.postMessage.mock.calls.map((c) => c[0] as ArtifactToShell);
const calls = (method?: string): Call[] =>
  sent().filter(
    (m): m is Call =>
      m.type === "call" && (method === undefined || m.method === method),
  );
const fromShell = (data: unknown, source: unknown = parent) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: source as Window }),
  );
const reply = (id: string, value: unknown) =>
  fromShell({ oa: 1, type: "result", id, ok: true, value });

function start(opts: Parameters<typeof createRuntime>[0] = {}): OpenArtifacts {
  return createRuntime({
    loadSchemas: async () => schemas,
    signal: ctl.signal,
    ...opts,
  });
}

beforeEach(() => {
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
});
afterEach(() => {
  ctl.abort();
  vi.useRealTimers();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  document.head.replaceChildren();
});

describe("bridge", () => {
  it("installs window.openArtifacts synchronously on import", () => {
    expect(window.openArtifacts).toBeDefined();
    expect(typeof window.openArtifacts?.db.collection).toBe("function");
  });

  it("sends hello on load; ready resolves on welcome with the theme", async () => {
    const oa = start();
    await flush();
    expect(sent()[0]).toEqual({
      oa: 1,
      type: "hello",
      protocol: 1,
      kind: "html",
    });
    let ready = false;
    void oa.ready.then(() => {
      ready = true;
    });
    const seen: string[] = [];
    oa.onTheme((t) => seen.push(t));
    await flush();
    expect(ready).toBe(false);
    fromShell({
      oa: 1,
      type: "welcome",
      capabilities: { db: true, viewer: false, storage: false },
      viewer: null,
      theme: oa.theme === "dark" ? "light" : "dark",
    });
    await flush();
    expect(ready).toBe(true);
    expect(seen).toHaveLength(1);
    expect(oa.theme).toBe(seen[0]);
  });

  it("ignores messages from a non-parent source", async () => {
    const oa = start();
    const p = oa.db.collection("c").get("a");
    await flush();
    const [c] = calls("db.get");
    expect(c?.params).toEqual({ collection: "c", id: "a" });
    let done = false;
    void p.then(() => {
      done = true;
    });
    fromShell(
      { oa: 1, type: "result", id: c?.id, ok: true, value: null },
      window,
    );
    fromShell(
      { oa: 1, type: "result", id: c?.id, ok: true, value: null },
      null,
    );
    await flush();
    expect(done).toBe(false);
    reply(c?.id ?? "", doc("a", 1));
    await expect(p).resolves.toEqual(doc("a", 1));
  });

  it("ignores malformed messages", async () => {
    const oa = start();
    const p = oa.db.collection("c").get("a");
    await flush();
    const id = calls("db.get")[0]?.id ?? "";
    let done = false;
    p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (const bad of [
      null,
      "result",
      { type: "result", id, ok: true, value: null },
      { oa: 2, type: "result", id, ok: true, value: null },
      { oa: 1, type: "result", id, ok: "yes", value: null },
      { oa: 1, type: "result", id, ok: true, value: null, extra: 1 },
      {
        oa: 1,
        type: "result",
        id,
        ok: false,
        error: { code: "nope", message: "" },
      },
    ])
      fromShell(bad);
    await flush();
    expect(done).toBe(false);
    reply(id, null);
    await expect(p).resolves.toBeNull();
  });

  it("a result resolves the matching call id only", async () => {
    const oa = start();
    const col = oa.db.collection("c");
    const p1 = col.get("a");
    const p2 = col.get("b");
    await flush();
    const [c1, c2] = calls("db.get");
    expect(c1?.id).not.toBe(c2?.id);
    let p1done = false;
    const mark = () => {
      p1done = true;
    };
    p1.then(mark, mark);
    reply(c2?.id ?? "", doc("b", 2));
    await expect(p2).resolves.toEqual(doc("b", 2));
    await flush();
    expect(p1done).toBe(false);
    reply(c2?.id ?? "", doc("b", 3)); // already settled: ignored
    fromShell({
      oa: 1,
      type: "result",
      id: c1?.id,
      ok: false,
      error: { code: "rate_limited", message: "slow down" },
    });
    await expect(p1).rejects.toMatchObject({
      code: "rate_limited",
      message: "slow down",
    });
  });

  // #681 E: one console.warn per page load on the first anon_writes_disabled.
  it("warns once on anon_writes_disabled, never for other errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const oa = start();
      await flush();
      const fail = async (code: string) => {
        const p = oa.db.collection("c").set("a", 1);
        await flush();
        const c = calls("db.set").at(-1);
        fromShell({
          oa: 1,
          type: "result",
          id: c?.id,
          ok: false,
          error: { code, message: "x" },
        });
        await expect(p).rejects.toMatchObject({ code });
      };
      await fail("rate_limited");
      await fail("capability_denied");
      await fail("unauthorized");
      expect(warn).not.toHaveBeenCalled();
      await fail("anon_writes_disabled");
      await fail("anon_writes_disabled");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.join(" "))).toContain(
        "this artifact doesn't allow anonymous writes",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a call with no reply after 15 s", async () => {
    vi.useFakeTimers();
    const oa = start();
    const p = oa.storage.get("k");
    const settled = vi.fn();
    p.catch(settled);
    await flush();
    fromShell({ oa: 1, type: "theme", theme: "light" }); // the shell is there
    await flush();
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({
      code: "internal",
      message: "shell did not respond",
    });
  });

  it("raw view (no parent) rejects every call at once with no_shell", async () => {
    Object.defineProperty(window, "parent", {
      value: window,
      configurable: true,
    });
    const oa = start();
    await expect(oa.ready).resolves.toBeUndefined();
    const noShell = { code: "no_shell", message: RAW_VIEW_MESSAGE };
    await expect(oa.db.collection("c").set("a", 1)).rejects.toMatchObject(
      noShell,
    );
    await expect(oa.viewer.get()).rejects.toMatchObject(noShell);
    await expect(oa.storage.list()).rejects.toMatchObject(noShell);
    await expect(oa.viewer.get()).rejects.toBeInstanceOf(RuntimeError);
  });

  it("framed, no shell yet: a call waiting past HANDSHAKE_MS rejects with no_shell; a late shell revives", async () => {
    vi.useFakeTimers();
    const oa = start();
    const p = oa.viewer.get();
    const settled = vi.fn();
    p.catch(settled);
    let ready = false;
    void oa.ready.then(() => {
      ready = true;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({
      code: "no_shell",
      message: RAW_VIEW_MESSAGE,
    });
    expect(ready).toBe(false);
    // The shell arrives late: it is accepted and later calls work.
    fromShell({
      oa: 1,
      type: "welcome",
      capabilities: { db: true, viewer: false, storage: true },
      viewer: null,
      theme: oa.theme === "dark" ? "light" : "dark",
    });
    await flush();
    expect(ready).toBe(true);
    const q = oa.storage.get("k");
    await flush();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS * 2);
    reply(calls("storage.get")[0]?.id ?? "", 7);
    await expect(q).resolves.toBe(7);
  });

  it("a shell that welcomes in time keeps calls alive past HANDSHAKE_MS", async () => {
    vi.useFakeTimers();
    const oa = start();
    await flush();
    fromShell({
      oa: 1,
      type: "welcome",
      capabilities: { db: true, viewer: false, storage: true },
      viewer: null,
      theme: "light",
    });
    await flush();
    const p = oa.storage.get("k");
    await flush();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS * 2);
    reply(calls("storage.get")[0]?.id ?? "", null);
    await expect(p).resolves.toBeNull();
  });

  it("rejects invalid params locally (RUNTIME_PARAMS), sending nothing", async () => {
    const oa = start();
    await flush();
    parent.postMessage.mockClear();
    await expect(oa.db.collection("bad name").get("a")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      oa.db.collection("c").update("a", { "no-dash": 1 }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(oa.storage.set("a.b", 1)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      oa.db.collection("c").list({ limit: 501 }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("rejects a result that fails RUNTIME_RESULTS", async () => {
    const oa = start();
    const p = oa.db.collection("c").set("a", 1);
    await flush();
    reply(calls("db.set")[0]?.id ?? "", { id: "a" });
    await expect(p).rejects.toMatchObject({ code: "internal" });
  });
});

describe("subscribe", () => {
  it("subscribes once, refetches data:null docs, unsubscribes after the last callback", async () => {
    const oa = start();
    const col = oa.db.collection("votes");
    const a = vi.fn();
    const b = vi.fn();
    const offA = col.subscribe(a);
    const offB = col.subscribe(b);
    await flush();
    const [sub] = calls("db.subscribe");
    expect(calls("db.subscribe")).toHaveLength(1);
    expect(sub?.params).toEqual({ collection: "votes" });
    reply(sub?.id ?? "", null);

    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "votes",
      docs: [doc("small", { n: 1 }), doc("big", null)],
      deleted: ["gone"],
    });
    await flush();
    expect(a).not.toHaveBeenCalled(); // waiting for the refetch
    const get = calls("db.get")[0];
    expect(get?.params).toEqual({ collection: "votes", id: "big" });
    reply(get?.id ?? "", doc("big", { blob: "x".repeat(10) }));
    await flush();
    const expected = {
      docs: [doc("small", { n: 1 }), doc("big", { blob: "x".repeat(10) })],
      deleted: ["gone"],
    };
    expect(a).toHaveBeenCalledWith(expected);
    expect(b).toHaveBeenCalledWith(expected);

    // Other collections are not delivered.
    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "other",
      docs: [doc("x", 1)],
      deleted: [],
    });
    await flush();
    expect(a).toHaveBeenCalledTimes(1);

    offA();
    offA();
    await flush();
    expect(calls("db.unsubscribe")).toHaveLength(0);
    offB();
    await flush();
    expect(calls("db.unsubscribe")).toHaveLength(1);
    expect(calls("db.unsubscribe")[0]?.params).toEqual({ collection: "votes" });
  });

  it("a refetched doc that is gone is reported as deleted", async () => {
    const oa = start();
    const cb = vi.fn();
    oa.db.collection("c").subscribe(cb);
    await flush();
    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "c",
      docs: [doc("big", null)],
      deleted: [],
    });
    await flush();
    reply(calls("db.get")[0]?.id ?? "", null);
    await flush();
    expect(cb).toHaveBeenCalledWith({ docs: [], deleted: ["big"] });
  });

  it("holds every onReady until the one subscription ack arrives", async () => {
    const oa = start();
    const col = oa.db.collection("votes");
    const readyA = vi.fn();
    const readyB = vi.fn();
    col.subscribe(() => {}, { onReady: readyA });
    col.subscribe(() => {}, { onReady: readyB });
    await flush();
    expect(calls("db.subscribe")).toHaveLength(1);
    expect(readyA).not.toHaveBeenCalled();
    expect(readyB).not.toHaveBeenCalled();
    reply(calls("db.subscribe")[0]?.id ?? "", null);
    await flush();
    expect(readyA).toHaveBeenCalledTimes(1);
    expect(readyB).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing onReady: delivery keeps working", async () => {
    const oa = start();
    const col = oa.db.collection("votes");
    const first = vi.fn();
    const second = vi.fn();
    col.subscribe(first, {
      onReady: () => {
        throw new Error("caller bug");
      },
    });
    await flush();
    reply(calls("db.subscribe")[0]?.id ?? "", null);
    await flush();
    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "votes",
      docs: [doc("a", 1)],
      deleted: [],
    });
    await flush();
    expect(first).toHaveBeenCalled();
    // The throwing callback did not drop the set: a later subscriber joins it.
    col.subscribe(second);
    await flush();
    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "votes",
      docs: [doc("b", 2)],
      deleted: [],
    });
    await flush();
    expect(second).toHaveBeenCalled();
    // A second subscribe after the ack doesn't issue another db.subscribe.
    expect(calls("db.subscribe")).toHaveLength(1);
  });

  it("never fires onReady after an unsubscribe before the ack", async () => {
    const oa = start();
    const onReady = vi.fn();
    const off = oa.db.collection("votes").subscribe(() => {}, { onReady });
    await flush();
    off();
    reply(calls("db.subscribe")[0]?.id ?? "", null);
    await flush();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("a failed ack never fires onReady and the next subscribe retries", async () => {
    const oa = start();
    const col = oa.db.collection("votes");
    const onReady = vi.fn();
    col.subscribe(() => {}, { onReady });
    await flush();
    fromShell({
      oa: 1,
      type: "result",
      id: calls("db.subscribe")[0]?.id ?? "",
      ok: false,
      error: { code: "internal", message: "no subscription" },
    });
    await flush();
    expect(onReady).not.toHaveBeenCalled();
    expect(calls("db.subscribe")).toHaveLength(1);
    col.subscribe(() => {});
    await flush();
    expect(calls("db.subscribe")).toHaveLength(2);
  });
});

describe("C4: db.resync", () => {
  it("calls each callback of the collection with { docs: [], deleted: [], resync: true }", async () => {
    const oa = start();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    oa.db.collection("votes").subscribe(a);
    oa.db.collection("votes").subscribe(b);
    oa.db.collection("other").subscribe(other);
    await flush();
    fromShell({
      oa: 1,
      type: "event",
      event: "db.resync",
      collection: "votes",
    });
    await flush();
    const resync = { docs: [], deleted: [], resync: true };
    expect(a).toHaveBeenCalledWith(resync);
    expect(b).toHaveBeenCalledWith(resync);
    expect(other).not.toHaveBeenCalled();
    // Ordinary changes carry no resync flag.
    fromShell({
      oa: 1,
      type: "event",
      event: "db.change",
      collection: "votes",
      docs: [doc("a", 1)],
      deleted: [],
    });
    await flush();
    expect(a).toHaveBeenLastCalledWith({ docs: [doc("a", 1)], deleted: [] });
  });

  it("ignores db.resync for collections without subscribers", async () => {
    const oa = start();
    const cb = vi.fn();
    const off = oa.db.collection("c").subscribe(cb);
    off();
    await flush();
    fromShell({ oa: 1, type: "event", event: "db.resync", collection: "c" });
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("storage.list", () => {
  const page = (from: number, n: number, next: string | null) => ({
    items: Array.from({ length: n }, (_, i) => ({
      key: `k${from + i}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    nextCursor: next,
  });

  it("follows cursors and returns keys", async () => {
    const oa = start();
    const p = oa.storage.list();
    await flush();
    expect(calls("storage.list")[0]?.params).toEqual({ limit: 500 });
    reply(calls("storage.list")[0]?.id ?? "", page(0, 500, "c1"));
    await flush();
    expect(calls("storage.list")[1]?.params).toEqual({
      limit: 500,
      cursor: "c1",
    });
    reply(calls("storage.list")[1]?.id ?? "", page(500, 3, null));
    const keys = await p;
    expect(keys).toHaveLength(503);
    expect(keys[0]).toBe("k0");
    expect(keys[502]).toBe("k502");
  });

  it("stops at 1000 keys", async () => {
    const oa = start();
    const p = oa.storage.list();
    for (let i = 0; i < 2; i++) {
      await flush();
      reply(calls("storage.list")[i]?.id ?? "", page(i * 500, 500, `c${i}`));
    }
    const keys = await p;
    expect(keys).toHaveLength(1000);
    expect(calls("storage.list")).toHaveLength(2);
  });
});

describe("snapshot", () => {
  const PNG = "data:image/webp;base64,AAAA";

  it("answers thumb.request with thumb.ready", async () => {
    const oa = start({
      loadSnapshot: async () => ({ snapshot: async () => PNG }),
    });
    void oa;
    await flush();
    fromShell({ oa: 1, type: "thumb.request" });
    await flush();
    expect(sent()).toContainEqual({ oa: 1, type: "thumb.ready", dataUrl: PNG });
  });

  it("sends nothing when the snapshot fails", async () => {
    start({
      loadSnapshot: async () => ({
        snapshot: async () => {
          throw new Error("boom");
        },
      }),
    });
    await flush();
    parent.postMessage.mockClear();
    fromShell({ oa: 1, type: "thumb.request" });
    await flush();
    expect(sent()).toEqual([]);
  });

  it("is ignored outside the html format (no hello either)", async () => {
    const meta = document.createElement("meta");
    meta.name = "oa-format";
    meta.content = "markdown";
    document.head.append(meta);
    const snap = vi.fn(async () => PNG);
    start({ loadSnapshot: async () => ({ snapshot: snap }) });
    fromShell({ oa: 1, type: "thumb.request" });
    await flush();
    expect(snap).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
  });
});
