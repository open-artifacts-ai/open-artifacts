import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ArtifactEvent,
  ArtifactEventSchema,
  EVENTS_GONE_CLOSE,
  R,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";
import { createArtifactEvents } from "../src/mocks/index.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGIN = "http://app.localhost";
const art = fixtures.artifacts.find(
  (a) => a.access === "owner" && a.deletedAt === null,
);
if (!art) throw new Error("no owned fixture");
const id = art.id;

function open(path: string) {
  const ws = new WebSocket(`ws://app.localhost${path}`);
  const frames: ArtifactEvent[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(ArtifactEventSchema.parse(JSON.parse(String(e.data))));
    waiters.shift()?.();
  });
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => res(e.code)),
  );
  const count = (n: number) =>
    new Promise<void>((res) => {
      const check = () => (frames.length >= n ? res() : waiters.push(check));
      check();
    });
  return { ws, frames, closed, count };
}

const req = (path: string, method: string, body?: unknown) =>
  fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: "s=1",
      "x-oa-request": "1",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("R.events mock", () => {
  it("hello, then manual emitVersion and emitGone", async () => {
    const events = createArtifactEvents();
    server.use(...events.handlers);
    const s = open(R.events("x1"));
    await s.count(1);
    expect(s.frames[0]).toEqual({ type: "hello", version: 1 });
    expect(events.connections("x1")).toBe(1);
    expect(
      events.emitVersion("x1", {
        version: 2,
        restoredFrom: 1,
        by: { kind: "agent", name: "a" },
      }),
    ).toBe(1);
    await s.count(2);
    expect(s.frames[1]).toMatchObject({
      type: "version",
      version: 2,
      restoredFrom: 1,
      by: { kind: "agent", name: "a" },
    });
    events.emitGone("x1");
    await s.count(3);
    expect(s.frames[2]).toEqual({ type: "gone", reason: "deleted" });
    expect(await s.closed).toBe(EVENTS_GONE_CLOSE);
  });

  it("emitPresence sends one presence frame to each open socket", async () => {
    const events = createArtifactEvents();
    server.use(...events.handlers);
    const a = open(R.events("p1"));
    const b = open(R.events("p1"));
    await Promise.all([a.count(1), b.count(1)]);
    const viewers = [
      {
        key: "aaaaaaaaaaaaaaaa",
        kind: "person" as const,
        name: "Ada",
        named: true,
        color: 1,
      },
    ];
    expect(events.emitPresence("p1", viewers, "aaaaaaaaaaaaaaaa")).toBe(2);
    await Promise.all([a.count(2), b.count(2)]);
    for (const s of [a, b])
      expect(s.frames[1]).toEqual({ type: "presence", viewers, total: 1 });
    const c = open(R.events("p1"));
    await c.count(1);
    expect(c.frames[0]).toEqual({
      type: "hello",
      version: 1,
      you: "aaaaaaaaaaaaaaaa",
    });
  });

  it("wired through createHandlers: publish, restore and delete emit", async () => {
    const events = createArtifactEvents();
    server.use(...createHandlers({ events }), ...events.handlers);
    const s = open(R.events(id));
    await s.count(1);
    expect(s.frames[0]).toEqual({
      type: "hello",
      version: art.currentVersion,
    });
    const p = await req(R.versions(id), "POST", {
      title: "t",
      format: "html",
      content: "<p>x</p>",
    });
    expect(p.status).toBe(201);
    const v = ((await p.json()) as { version: number }).version;
    await s.count(2);
    expect(s.frames[1]).toMatchObject({ type: "version", version: v });
    expect((await req(R.restoreVersion(id, v), "POST")).status).toBe(201);
    await s.count(3);
    expect(s.frames[2]).toMatchObject({
      type: "version",
      version: v + 1,
      restoredFrom: v,
    });
    expect((await req(R.artifact(id), "DELETE")).status).toBe(204);
    await s.count(4);
    expect(s.frames[3]).toEqual({ type: "gone", reason: "deleted" });
    expect(await s.closed).toBe(4403);
  });
});
