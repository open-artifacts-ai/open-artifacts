import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { boundFetch, InfraError, setupFetch } from "../src/fetch-timeout.ts";
import { createThrowaway, throwawayRetries } from "../src/fixtures.ts";
import type { Cred } from "../src/http.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { resetSummary } from "../src/report.ts";
import { watchResets } from "../src/resets.ts";
import type { Target } from "../src/targets.ts";
import { transportFetch } from "../src/transport.ts";

// #1133: a setup publish (POST /api/v1/artifacts) whose call site opts in
// with retryFresh: "new-artifact" gets one retry on a new connection, only
// when the first try got no response on a reused socket. A local server on
// 127.0.0.1, port 0, per test: a new origin, so a new pool, and every
// request it logs is ours.

type Hit = { path: string; socket: number; nth: number };

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
    hits.push({ path, socket: rec.id, nth: rec.n });
    // A reset with no response: what the edge did in run 41919316028.
    // The publish route resets on a reused socket too (createThrowaway).
    const reusedResets =
      path === "/reset-reused" || path === "/api/v1/artifacts";
    if (path === "/reset" || (reusedResets && rec.n > 1)) {
      req.resume();
      s.resetAndDestroy();
      return;
    }
    const status = /^\/status\/(\d+)$/.exec(path)?.[1];
    res.statusCode = status ? Number(status) : 201;
    req.resume();
    req.on("end", () => res.end('{"id":"new-id"}'));
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
// As live/setup.ts composes the global fetch; setupFetch unwraps the bound.
const tf = boundFetch(transportFetch(globalThis.fetch, watch));

/** One request on a new socket, read to the end so the socket is reused next. */
async function warm(b: Box): Promise<void> {
  const r = await tf(`${b.origin}/ok`, { signal: AbortSignal.timeout(5_000) });
  await r.text();
  expect(b.hits.at(-1)).toMatchObject({ path: "/ok", nth: 1 });
  await new Promise((r) => setImmediate(r));
}

const publish = (b: Box, path: string) =>
  new Request(`${b.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "rl-throwaway", format: "html" }),
  });

const opted = { ms: 5_000, fetch: tf, retryFresh: "new-artifact" } as const;

const retried = (notes: string[]) =>
  notes.filter((n) => n.startsWith("request retried: "));

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

describe("setupFetch retryFresh: new-artifact (#1133)", () => {
  it("a reset on a reused socket is retried once on a new socket and recovers, with a note the Resets line counts", async () => {
    const b = await box();
    await warm(b);
    const { res, text } = await setupFetch(
      "rl-a",
      publish(b, "/reset-reused"),
      opted,
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(text)).toEqual({ id: "new-id" });
    const tries = b.hits.filter((h) => h.path === "/reset-reused");
    expect(tries).toHaveLength(2);
    expect(tries[0]).toMatchObject({ socket: 1, nth: 2 });
    expect(tries[1]?.socket).not.toBe(1);
    expect(tries[1]?.nth).toBe(1);
    const notes = takeFileNotes();
    const r = retried(notes);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(
      /^request retried: [A-Z_]+ POST \/reset-reused \(new setup artifact\) host [0-9a-f]{8}, reused socket, idle \d+ ms, request 2 on it; recovered on a new socket$/,
    );
    expect(resetSummary(notes)).toMatch(/; retried 1, recovered 1$/);
  });

  it("without the opt-in, the same reset is not retried: infra", async () => {
    const b = await box();
    await warm(b);
    const e = await rejection(
      setupFetch("rl-a", publish(b, "/reset-reused"), { ms: 5_000, fetch: tf }),
    );
    expect(e).toBeInstanceOf(InfraError);
    expect(e.message).toMatch(
      /^infra: setup publish got no response on rl-a \(/,
    );
    expect(b.hits.filter((h) => h.path === "/reset-reused")).toHaveLength(1);
    expect(retried(takeFileNotes())).toEqual([]);
  });

  it("a reset on a new socket is not retried: infra", async () => {
    const b = await box();
    const e = await rejection(setupFetch("rl-a", publish(b, "/reset"), opted));
    expect(e).toBeInstanceOf(InfraError);
    expect(e.message).toMatch(
      /^infra: setup publish got no response on rl-a \(/,
    );
    expect(b.hits).toHaveLength(1);
    expect(b.hits[0]).toMatchObject({ path: "/reset", nth: 1 });
    expect(retried(takeFileNotes())).toEqual([]);
  });

  it("a second reset (the retry's, on its new socket) is infra, noted, never a third try", async () => {
    const b = await box();
    await warm(b);
    const e = await rejection(setupFetch("rl-a", publish(b, "/reset"), opted));
    expect(e).toBeInstanceOf(InfraError);
    expect(e.message).toMatch(
      /^infra: setup publish got no response on rl-a \(/,
    );
    const tries = b.hits.filter((h) => h.path === "/reset");
    expect(tries).toHaveLength(2);
    expect(tries[0]).toMatchObject({ socket: 1, nth: 2 });
    expect(tries[1]?.nth).toBe(1);
    const notes = takeFileNotes();
    const r = retried(notes);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/; failed again \([A-Z_]+, new socket\)$/);
    expect(resetSummary(notes)).toMatch(/; retried 1, recovered 0$/);
  });

  for (const status of [400, 409, 500, 503]) {
    it(`an HTTP ${status} on a reused socket is returned as is, never retried`, async () => {
      const b = await box();
      await warm(b);
      const { res } = await setupFetch(
        "rl-a",
        publish(b, `/status/${status}`),
        opted,
      );
      expect(res.status).toBe(status);
      expect(b.hits.filter((h) => h.path === `/status/${status}`)).toHaveLength(
        1,
      );
      expect(retried(takeFileNotes())).toEqual([]);
    });
  }
});

describe("createThrowaway: retry only for a plain private throwaway (#1133)", () => {
  const pat: Cred = { kind: "pat", token: "x" };
  const target = (b: Box) =>
    ({ name: "rl-b", app: b.origin }) as unknown as Target;
  // createThrowaway's setupFetch uses the global fetch, as in the live suite.
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it("decides by visibility, capabilities and anonymous writes", () => {
    expect(throwawayRetries({})).toBe(true);
    expect(throwawayRetries({ visibility: "private" })).toBe(true);
    expect(throwawayRetries({ visibility: "public" })).toBe(false);
    expect(throwawayRetries({ capabilities: { db: true } })).toBe(false);
    expect(throwawayRetries({ allowAnonymousWrites: true })).toBe(false);
  });

  it("a private throwaway's publish reset on a reused socket is retried and recovers", async () => {
    const b = await box();
    globalThis.fetch = tf;
    await warm(b);
    const w = await createThrowaway(target(b), pat);
    expect(w.id).toBe("new-id");
    expect(b.hits.filter((h) => h.path === "/api/v1/artifacts")).toHaveLength(
      2,
    );
    expect(retried(takeFileNotes())).toHaveLength(1);
  });

  for (const [what, o] of [
    ["public", { visibility: "public" }],
    ["db-enabled", { capabilities: { db: true } }],
    [
      "live.test.ts's anonymous-write",
      {
        visibility: "public",
        capabilities: { db: true },
        allowAnonymousWrites: true,
      },
    ],
  ] as const) {
    it(`a ${what} throwaway's publish reset on a reused socket is not retried: infra`, async () => {
      const b = await box();
      globalThis.fetch = tf;
      await warm(b);
      const e = await rejection(createThrowaway(target(b), pat, o));
      expect(e).toBeInstanceOf(InfraError);
      expect(b.hits.filter((h) => h.path === "/api/v1/artifacts")).toHaveLength(
        1,
      );
      expect(retried(takeFileNotes())).toEqual([]);
    });
  }
});
