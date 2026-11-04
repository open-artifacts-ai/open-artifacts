import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { boundFetch, InfraError } from "../src/fetch-timeout.ts";
import { HttpError } from "../src/http.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { levelOf, NO_RESPONSE_KEY } from "../src/report.ts";
import { watchResets } from "../src/resets.ts";
import { callerRetries, idempotent, transportFetch } from "../src/transport.ts";

// #1133: a local server that resets a socket on its second request (or on
// every request), driven through transportFetch on the real global fetch.
// Each test gets its own server on 127.0.0.1, port 0: a new origin, so a new
// pool, and every request it logs is ours.

type Hit = { method: string; path: string; socket: number; nth: number };

interface Box {
  origin: string;
  hits: Hit[];
  close: () => Promise<void>;
}

const open: Box[] = [];
afterEach(async () => {
  for (const b of open.splice(0)) await b.close();
  takeFileNotes();
});

async function box(): Promise<Box> {
  const hits: Hit[] = [];
  const ids = new WeakMap<Socket, { id: number; n: number }>();
  let next = 0;
  const server: Server = createServer((req, res) => {
    const s = req.socket;
    let rec = ids.get(s);
    if (!rec) {
      rec = { id: ++next, n: 0 };
      ids.set(s, rec);
    }
    rec.n++;
    const path = req.url ?? "";
    hits.push({ method: req.method ?? "", path, socket: rec.id, nth: rec.n });
    // A reset with no response: what the edge did in run 41908283483.
    if (path === "/reset" || (path === "/reset-reused" && rec.n > 1)) {
      req.resume();
      s.resetAndDestroy();
      return;
    }
    const status = /^\/status\/(\d+)$/.exec(path)?.[1];
    res.statusCode = status ? Number(status) : 200;
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  server.keepAliveTimeout = 30_000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const b: Box = {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  open.push(b);
  return b;
}

const watch = watchResets();
// As live/setup.ts composes it: the bound outside, so markers survive its copy.
const tf = boundFetch(transportFetch(globalThis.fetch, watch));
// Every request is bounded: a hung server fails the test, never holds it.
const bounded = (init: RequestInit = {}): RequestInit => ({
  ...init,
  signal: AbortSignal.timeout(5_000),
});

/** One request on a new socket, read to the end so the socket is reused next. */
async function warm(b: Box): Promise<void> {
  const r = await tf(`${b.origin}/ok`, bounded());
  await r.text();
  expect(b.hits.at(-1)).toMatchObject({ path: "/ok", nth: 1 });
  // undici hands the socket back to its pool after the body's end, within
  // the same turn of the loop: one turn later it is idle. Every test checks
  // its first try went out on socket 1 as request 2, so a miss fails loudly.
  await new Promise((r) => setImmediate(r));
}

const retried = () =>
  takeFileNotes().filter((n) => n.startsWith("request retried: "));

/** What the reporter sees for a case that threw `e`. */
const levelFor = (e: unknown) =>
  levelOf("failed", undefined, [e as { message?: unknown }]);

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

beforeAll(() => {
  setCurrentTest(() => undefined);
});

describe("transportFetch (#1133)", () => {
  it("a GET reset on a reused socket is retried once on a new socket and recovers, with a note", async () => {
    const b = await box();
    await warm(b);
    const res = await tf(`${b.origin}/reset-reused`, bounded());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const tries = b.hits.filter((h) => h.path === "/reset-reused");
    expect(tries).toHaveLength(2);
    // The first went out on the warm socket; the retry on a new one.
    expect(tries[0]).toMatchObject({ socket: 1, nth: 2 });
    expect(tries[1]?.socket).not.toBe(1);
    expect(tries[1]?.nth).toBe(1);
    const notes = retried();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(
      /^request retried: [A-Z_]+ GET \/reset-reused host [0-9a-f]{8}, reused socket, idle \d+ ms, request 2 on it; recovered on a new socket$/,
    );
    expect(notes[0]).not.toContain("127.0.0.1");
  });

  it("a POST reset on a reused socket is not retried and reports infra", async () => {
    const b = await box();
    await warm(b);
    const e = await rejection(
      tf(`${b.origin}/reset-reused`, bounded({ method: "POST", body: "x" })),
    );
    expect(e.message).toBe("fetch failed");
    expect(b.hits.filter((h) => h.path === "/reset-reused")).toHaveLength(1);
    expect(retried()).toEqual([]);
    const tag = (e as unknown as Record<string, unknown>)[NO_RESPONSE_KEY];
    expect(tag).toMatch(
      /^infra: no_response [A-Z_]+ POST \/reset-reused host [0-9a-f]{8}, reused socket, idle \d+ ms, request 2 on it; not retried: POST is not safe to repeat$/,
    );
    expect(levelFor(e)).toEqual({ level: "infra", reason: tag });
  });

  it("a POST marked idempotent at its call site is retried like a GET", async () => {
    const b = await box();
    await warm(b);
    const res = await tf(
      `${b.origin}/reset-reused`,
      idempotent(bounded({ method: "POST", body: "x" })),
    );
    expect(res.status).toBe(200);
    expect(b.hits.filter((h) => h.path === "/reset-reused")).toHaveLength(2);
    expect(retried()).toHaveLength(1);
  });

  it("a GET whose caller runs its own retry gets none here, and still reports infra", async () => {
    const b = await box();
    await warm(b);
    const e = await rejection(
      tf(`${b.origin}/reset-reused`, callerRetries(bounded())),
    );
    expect(b.hits.filter((h) => h.path === "/reset-reused")).toHaveLength(1);
    expect(retried()).toEqual([]);
    expect(levelFor(e).level).toBe("infra");
  });

  it("a reset on a new socket is not retried, and reports infra", async () => {
    const b = await box();
    const e = await rejection(tf(`${b.origin}/reset`, bounded()));
    expect(b.hits.filter((h) => h.path === "/reset")).toHaveLength(1);
    expect(retried()).toEqual([]);
    expect((e as unknown as Record<string, unknown>)[NO_RESPONSE_KEY]).toMatch(
      /, new socket; not retried: not on a reused socket$/,
    );
    expect(levelFor(e).level).toBe("infra");
  });

  for (const status of [500, 403]) {
    it(`an HTTP ${status} on a reused socket is never retried or reclassified`, async () => {
      const b = await box();
      await warm(b);
      const res = await tf(`${b.origin}/status/${status}`, bounded());
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(b.hits.filter((h) => h.path === `/status/${status}`)).toEqual([
        expect.objectContaining({ socket: 1, nth: 2 }),
      ]);
      expect(retried()).toEqual([]);
      // The case that judges it fails on the status: fail, not infra.
      const judged = new HttpError("GET /status", res, text);
      expect(levelFor(judged).level).toBe("fail");
    });
  }

  it("a second reset after the retry reports infra, and the note says it failed again", async () => {
    const b = await box();
    await warm(b);
    const e = await rejection(tf(`${b.origin}/reset`, bounded()));
    const tries = b.hits.filter((h) => h.path === "/reset");
    expect(tries).toHaveLength(2);
    expect(tries[0]).toMatchObject({ socket: 1, nth: 2 });
    expect(tries[1]?.nth).toBe(1);
    const notes = retried();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/; failed again \([A-Z_]+, new socket\)$/);
    expect((e as unknown as Record<string, unknown>)[NO_RESPONSE_KEY]).toMatch(
      /; retried once on a new connection, [A-Z_]+ again \(new socket\)$/,
    );
    expect(levelFor(e).level).toBe("infra");
  });

  it("our own abort is not a transport blip: no tag, no retry, still a fail", async () => {
    const b = await box();
    await warm(b);
    const ac = new AbortController();
    ac.abort();
    const e = await rejection(
      tf(`${b.origin}/reset-reused`, { signal: ac.signal }),
    );
    expect(e.name).toBe("AbortError");
    expect(
      (e as unknown as Record<string, unknown>)[NO_RESPONSE_KEY],
    ).toBeUndefined();
    expect(retried()).toEqual([]);
    expect(levelFor(e).level).toBe("fail");
  });

  it("an assertion failure still reports fail; an InfraError stays infra", () => {
    expect(levelFor(new Error("expected 403, got 200")).level).toBe("fail");
    expect(levelFor(new InfraError("setup x")).level).toBe("infra");
    // Every error must be infra: one assertion beside a blip is a fail.
    const blip = Object.assign(new TypeError("fetch failed"), {
      [NO_RESPONSE_KEY]: "infra: no_response ECONNRESET GET /x host 00",
    });
    expect(
      levelOf("failed", undefined, [blip, new Error("assertion")]).level,
    ).toBe("fail");
    // A tag that isn't ours (no "infra: ") is never read as infra.
    const forged = Object.assign(new Error("x"), { [NO_RESPONSE_KEY]: "x" });
    expect(levelFor(forged).level).toBe("fail");
  });
});
