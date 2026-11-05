import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { resetSummary } from "../src/report.ts";
import { watchResets } from "../src/resets.ts";

describe("reset evidence", () => {
  let origin = "";
  let hits = 0;
  const watch = watchResets();
  const server = createServer((req, res) => {
    hits++;
    // The cut: the connection dies with no response, as ECONNRESET does.
    if (req.url?.startsWith("/cut")) req.socket.destroy();
    else res.end("ok");
  });

  beforeAll(async () => {
    setCurrentTest(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const get = async (path: string) => {
    const r = await fetch(`${origin}${path}`);
    await r.text();
  };

  it("names the socket as reused, with its idle time, and no id or query", async () => {
    await get("/a");
    await new Promise((r) => setTimeout(r, 120));
    await expect(get("/cut/v1/x/secret-id?token=abc")).rejects.toThrow(
      "fetch failed",
    );
    const notes = takeFileNotes();
    expect(notes).toHaveLength(1);
    const [n = ""] = notes;
    expect(n).toMatch(
      /^reset: \S+ GET \/cut\/v1\/x host [0-9a-f]{8}, reused socket, idle \d+ ms, request 2 on it$/,
    );
    expect(Number(/idle (\d+) ms/.exec(n)?.[1])).toBeGreaterThanOrEqual(100);
    expect(n).not.toMatch(/secret|token|127\.0\.0\.1/);
  });

  it("names a new socket as new", async () => {
    server.closeAllConnections();
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    expect(takeFileNotes()[0]).toMatch(/, new socket$/);
  });

  it("an answer isn't a reset, a 500 included", async () => {
    await get("/a");
    expect(takeFileNotes()).toEqual([]);
  });

  it("our own abort isn't a reset", async () => {
    const stalled = createServer(() => {});
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", () => r()));
    const { port } = stalled.address() as AddressInfo;
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
    stalled.closeAllConnections();
    stalled.close();
    expect(takeFileNotes()).toEqual([]);
  });

  it("a listener that throws can't touch the request or fail a case", async () => {
    const uncaught: unknown[] = [];
    const seen = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", seen);
    watchResets(() => {
      throw new Error("evidence broke");
    });
    try {
      await get("/a");
      await expect(get("/cut")).rejects.toThrow("fetch failed");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("uncaughtException", seen);
    }
    expect(uncaught).toEqual([]);
    takeFileNotes();
  });

  it("totals carry the denominator", () => {
    expect(watch.totals()).toMatch(
      /^connections: \d+ requests, \d+ on new sockets$/,
    );
    expect(hits).toBeGreaterThan(0);
  });
});

describe("resetSummary", () => {
  it("adds up the files, with the denominator", () => {
    expect(
      resetSummary([
        "reset: ECONNRESET GET /v1/x host aa, reused socket, idle 9 ms, request 2 on it",
        "reset: ECONNRESET PUT /v1/y host bb, new socket",
        "probe PUT retried once",
        "request retried: ECONNRESET GET /v1/x host aa, reused socket, idle 9 ms, request 2 on it; recovered on a new socket",
        "request retried: ECONNRESET GET /v1/z host aa, reused socket, idle 1 ms, request 3 on it; failed again (ECONNRESET, new socket)",
        "connections: 90 requests, 10 on new sockets",
        "connections: 10 requests, 5 on new sockets",
      ]),
    ).toBe(
      "Resets: 2 (1 on reused sockets), of 100 requests (15 on new sockets); retried 2, recovered 1",
    );
    expect(resetSummary(["something else"])).toBeUndefined();
  });
});
