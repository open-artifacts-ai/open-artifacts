// Viewer presence on the ArtifactRuntime events sockets (#539 Task 3): join,
// grace, coalescing, ping/pong, stale sweep and hibernation, driven through
// the DO's own fetch (the route's header contract) with a clock override.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  newId,
  PRESENCE_COALESCE_MS,
  PRESENCE_GRACE_MS,
  PRESENCE_PING,
  PRESENCE_PONG,
  PRESENCE_STALE_MS,
  PRESENCE_SWEEP_MS,
  type PresenceEntry,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { presenceStub, SKEW_MS } from "../src/runtime/presence.js";

type Msg = { type: string; [k: string]: unknown };
type Sock = {
  ws: WebSocket;
  msgs: Msg[];
  raw: string[];
  closed: Promise<number>;
  presence: () => { viewers: PresenceEntry[]; total: number }[];
  next: (type: string) => Promise<Msg>;
  settle: () => Promise<void>;
};

const T0 = 1_800_000_000_000;
let ipSeq = 0;
const key = (c: string) => c.repeat(16);

const stubOf = (id: string) =>
  runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>;
const inDo = <T>(
  id: string,
  fn: (i: ArtifactRuntime, s: DurableObjectState) => T | Promise<T>,
) => runInDurableObject(stubOf(id), fn);
const clock = (id: string, ms: number) =>
  inDo(id, (i) => {
    i.now = () => ms;
  });
const alarm = (id: string) => runDurableObjectAlarm(stubOf(id));

type Opts = {
  actor?: string;
  ident?: Record<string, unknown> | null;
  ping?: boolean;
  authzAt?: number;
};
const seat = (c: string, over: Record<string, unknown> = {}) => ({
  key: key(c),
  kind: "anon",
  name: null,
  guest: false,
  ...over,
});

function wrap(ws: WebSocket): Sock {
  const msgs: Msg[] = [];
  const raw: string[] = [];
  const waiters: { type: string; res: (m: Msg) => void }[] = [];
  const pongs: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    const s = String(e.data);
    raw.push(s);
    if (s === PRESENCE_PONG) {
      pongs.shift()?.();
      return;
    }
    const m = JSON.parse(s) as Msg;
    msgs.push(m);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0]?.res(m);
  });
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
  );
  ws.accept();
  let read = 0;
  return {
    ws,
    msgs,
    raw,
    closed,
    presence: () =>
      msgs.filter((m) => m.type === "presence") as unknown as ReturnType<
        Sock["presence"]
      >,
    next: (type) => {
      for (; read < msgs.length; ) {
        const m = msgs[read++];
        if (m?.type === type) return Promise.resolve(m);
      }
      return new Promise((res) =>
        waiters.push({
          type,
          res: (m) => {
            read = msgs.indexOf(m) + 1;
            res(m);
          },
        }),
      );
    },
    // Everything the DO sent before this call has arrived once its pong has.
    settle: () =>
      new Promise<void>((res) => {
        pongs.push(res);
        ws.send(PRESENCE_PING);
      }),
  };
}

const upgrade = (id: string, o: Opts = {}) => {
  const actor = o.actor ?? `ip:198.51.100.${(++ipSeq % 250) + 1}`;
  const h: Record<string, string> = {
    Upgrade: "websocket",
    "X-OA-Actor": actor,
    "X-OA-Authz-At": String(o.authzAt ?? Date.now()),
    "X-OA-Version": "1",
    "X-OA-Named": "0",
  };
  if (o.ident !== null)
    h["X-OA-Viewer-Presence"] = JSON.stringify(o.ident ?? seat("a"));
  if (o.ping) h["X-OA-Ping"] = "1";
  return runtimeStub(env, id).fetch("https://runtime.invalid/events", {
    headers: h,
  });
};

async function join(id: string, o: Opts = {}): Promise<Sock> {
  const r = await upgrade(id, o);
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}

/** A joined socket whose own roster frame has arrived. */
async function joined(id: string, c: string, o: Opts = {}) {
  const s = await join(id, { ...o, ident: o.ident ?? seat(c) });
  await s.next("hello");
  await s.next("presence");
  return s;
}

const names = (f: { viewers: PresenceEntry[] }) => f.viewers.map((v) => v.key);
const fresh = () => newId();
const at = new Map<string, number>();
/** Moves one artifact's clock a coalesce window ahead (T0 first), so joins are not coalesced. */
const step = async (id: string, ms = PRESENCE_COALESCE_MS + 100) => {
  const t = (at.get(id) ?? T0 - ms) + ms;
  at.set(id, t);
  await clock(id, t);
  return t;
};

describe("viewer presence: join and roster", () => {
  it("hello carries you; the joiner gets the current roster right after hello", async () => {
    const id = fresh();
    const a = await join(id, { ident: seat("a") });
    const hello = await a.next("hello");
    expect(hello.you).toBe(key("a"));
    const p = (await a.next("presence")) as unknown as {
      viewers: PresenceEntry[];
      total: number;
    };
    expect(names(p)).toEqual([key("a")]);
    expect(p.total).toBe(1);
    // The first message is the hello, the second the roster.
    expect(a.msgs.slice(0, 2).map((m) => m.type)).toEqual([
      "hello",
      "presence",
    ]);
  });

  it("a second socket's join reaches the first as one presence frame", async () => {
    const id = fresh();
    await step(id);
    const a = await joined(id, "a");
    await step(id);
    const b = await joined(id, "b");
    await a.settle();
    await b.settle();
    expect(a.presence()).toHaveLength(2);
    expect(names(a.presence()[1] as never)).toEqual([key("b"), key("a")]);
    // The joiner is not sent the same roster twice.
    expect(b.presence()).toHaveLength(1);
  });

  it("three joins inside PRESENCE_COALESCE_MS send one frame, flushed by the alarm", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + 10);
    await joined(id, "b");
    await joined(id, "c");
    await a.settle();
    // b's join was inside the window: nothing yet, a flush is pending.
    expect(a.presence()).toHaveLength(1);
    expect(await inDo(id, (i) => i.pendingViewerPresence().sentAt)).toBe(T0);
    await clock(id, T0 + PRESENCE_COALESCE_MS);
    await alarm(id);
    await a.settle();
    expect(a.presence()).toHaveLength(2);
    expect(a.presence()[1]?.total).toBe(3);
  });

  it("two sockets of one key show once; closing one keeps the face", async () => {
    const id = fresh();
    await step(id);
    const a = await joined(id, "a");
    await step(id);
    const b1 = await joined(id, "b");
    await step(id);
    const b2 = await joined(id, "b");
    await a.settle();
    expect(a.presence().at(-1)?.total).toBe(2);
    b1.ws.close(1000);
    await b1.closed;
    await step(id, PRESENCE_GRACE_MS + 10);
    await alarm(id);
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toContain(key("b"));
    expect(a.presence().at(-1)?.total).toBe(2);
    b2.ws.close(1000);
  });

  it("a clean close leaves after PRESENCE_GRACE_MS, not before", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + PRESENCE_COALESCE_MS);
    const b = await joined(id, "b");
    await a.next("presence");
    await clock(id, T0 + 10_000);
    b.ws.close(1000);
    await b.closed;
    await a.settle();
    const before = a.presence().length;
    await clock(id, T0 + 10_000 + PRESENCE_GRACE_MS - 1000);
    await alarm(id);
    await a.settle();
    expect(a.presence()).toHaveLength(before);
    await clock(id, T0 + 10_000 + PRESENCE_GRACE_MS);
    await alarm(id);
    await a.settle();
    expect(a.presence()).toHaveLength(before + 1);
    expect(names(a.presence().at(-1) as never)).toEqual([key("a")]);
  });

  it("a reconnect inside the grace keeps the original since and position", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + 2000);
    const b = await joined(id, "b");
    await clock(id, T0 + 4000);
    const c = await joined(id, "c");
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toEqual([
      key("c"),
      key("b"),
      key("a"),
    ]);
    await clock(id, T0 + 10_000);
    b.ws.close(1000);
    await b.closed;
    await clock(id, T0 + 13_000);
    const b2 = await joined(id, "b");
    expect(names(b2.presence().at(-1) as never)).toEqual([
      key("c"),
      key("b"),
      key("a"),
    ]);
    await c.settle();
    await clock(id, T0 + 20_000);
    await alarm(id);
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toEqual([
      key("c"),
      key("b"),
      key("a"),
    ]);
  });

  it("a rejoin after the grace gets a fresh since (moves to first)", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + 2000);
    const b = await joined(id, "b");
    await clock(id, T0 + 10_000);
    b.ws.close(1000);
    await b.closed;
    await clock(id, T0 + 10_000 + PRESENCE_GRACE_MS + 1);
    await alarm(id);
    await clock(id, T0 + 30_000);
    const b2 = await joined(id, "b");
    expect(names(b2.presence().at(-1) as never)).toEqual([key("b"), key("a")]);
    await a.settle();
  });
});

describe("viewer presence: ping, stale sockets and the alarm", () => {
  it('"ping" gets "pong" and does not close the socket; any other message still closes 1008', async () => {
    const id = fresh();
    const a = await joined(id, "a", { ping: true });
    await a.settle();
    expect(a.raw).toContain(PRESENCE_PONG);
    a.ws.send("hi");
    expect(await a.closed).toBe(1008);
  });

  it("a pinging socket with no auto-response for PRESENCE_STALE_MS is closed by the alarm and leaves", async () => {
    const id = fresh();
    // The runtime stamps auto-responses with the real clock, so this test
    // keeps `now` near it: b joined 61 s ago and never pinged, a pings now.
    const real = Date.now();
    await clock(id, real - PRESENCE_STALE_MS - 1000);
    const b = await joined(id, "b", { ping: true });
    await clock(id, real - PRESENCE_STALE_MS);
    const a = await joined(id, "a", { ping: true });
    await a.settle();
    await clock(id, real);
    await alarm(id);
    expect(await b.closed).toBe(1001);
    await clock(id, real + PRESENCE_GRACE_MS);
    await alarm(id);
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toEqual([key("a")]);
  });

  it("a socket opened without X-OA-Ping is never swept as stale", async () => {
    const id = fresh();
    await clock(id, T0);
    const old = await joined(id, "a");
    await clock(id, T0 + PRESENCE_STALE_MS * 4);
    await alarm(id);
    await old.settle();
    expect(old.ws.readyState).toBe(1);
    expect(await inDo(id, (_i, s) => s.getWebSockets("~vp").length)).toBe(1);
  });

  it("while a ping=1 socket is open the alarm is armed at most PRESENCE_SWEEP_MS ahead; with only non-pinging sockets no sweep alarm is armed", async () => {
    const a = fresh();
    await clock(a, T0);
    await joined(a, "a", { ping: true });
    const t = await inDo(a, (_i, s) => s.storage.getAlarm());
    expect(t).not.toBeNull();
    expect(t as number).toBeLessThanOrEqual(T0 + PRESENCE_SWEEP_MS);
    const b = fresh();
    await clock(b, T0);
    await joined(b, "a");
    const u = await inDo(b, (_i, s) => s.storage.getAlarm());
    expect(u === null || u > T0 + PRESENCE_SWEEP_MS).toBe(true);
  });

  it("after a fresh instance on the same storage, the roster is rebuilt from attachments and viewer_presence_left", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + 2000);
    const b = await joined(id, "b");
    await clock(id, T0 + 10_000);
    b.ws.close(1000);
    await b.closed;
    expect(
      await inDo(id, (_i, s) =>
        s.storage.sql
          .exec("select count(*) as n from viewer_presence_left")
          .one(),
      ),
    ).toEqual({ n: 1 });
    // Hibernation: a new instance sees only storage and the sockets' attachments.
    await inDo(id, async (_i, s) => {
      const next = new ArtifactRuntime(s, env);
      next.now = () => T0 + 10_000 + PRESENCE_GRACE_MS;
      await next.alarm();
    });
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toEqual([key("a")]);
  });

  it("a socket without X-OA-Viewer-Presence gets no presence frames and is not counted", async () => {
    const id = fresh();
    const a = await joined(id, "a");
    const e = await join(id, { ident: null });
    const hello = await e.next("hello");
    expect(hello.you).toBeUndefined();
    await e.settle();
    expect(e.presence()).toHaveLength(0);
    await a.settle();
    expect(a.presence()).toHaveLength(1);
    expect(await inDo(id, (_i, s) => s.getWebSockets("~vp").length)).toBe(1);
    // A joiner after it still sees one face.
    const b = await joined(id, "b");
    expect(b.presence()[0]?.total).toBe(2);
  });
});

describe("viewer presence: gates and cleanup", () => {
  it("a stale socket never joins: gone with retryAfterMs then 4403; no frame for others; no grace row", async () => {
    const id = fresh();
    await stubOf(id).closeSockets("x");
    const ok = await join(id, {
      ident: seat("a"),
      authzAt: Date.now() + SKEW_MS + 1000,
    });
    await ok.next("hello");
    await ok.next("presence");
    const stale = await join(id, {
      ident: seat("b"),
      authzAt: Date.now() - 1,
    });
    const gone = await stale.next("gone");
    expect(typeof gone.retryAfterMs).toBe("number");
    expect(await stale.closed).toBe(4403);
    await ok.settle();
    expect(ok.presence()).toHaveLength(1);
    expect(names(ok.presence()[0] as never)).toEqual([key("a")]);
    expect(
      await inDo(id, (_i, s) =>
        s.storage.sql
          .exec("select count(*) as n from viewer_presence_left")
          .one(),
      ),
    ).toEqual({ n: 0 });
  });

  it("a socket whose UserPresence.touch refuses never joins and writes no grace row", async () => {
    const id = fresh();
    const uid = `vp-${newId()}`;
    const p = presenceStub(env, uid);
    if (!p) throw new Error("USER_PRESENCE is not bound");
    await p.closeAll("revoked");
    const a = await joined(id, "a");
    const r = await join(id, {
      actor: `u:${uid}`,
      ident: seat("u", { kind: "person", name: "Una" }),
      authzAt: Date.now() - 1,
    });
    expect(await r.closed).toBe(4403);
    await a.settle();
    expect(a.presence()).toHaveLength(1);
    expect(
      await inDo(id, (_i, s) =>
        s.storage.sql
          .exec("select count(*) as n from viewer_presence_left")
          .one(),
      ),
    ).toEqual({ n: 0 });
  });

  it('closeActor("u:{id}") removes that person at once, with no grace row', async () => {
    const id = fresh();
    const uid = `vp-${newId()}`;
    await step(id);
    const a = await joined(id, "a");
    await step(id);
    const u = await joined(id, "u", {
      actor: `u:${uid}`,
      ident: seat("u", { kind: "person", name: "Una" }),
    });
    await a.settle();
    expect(a.presence().at(-1)?.total).toBe(2);
    await step(id);
    await stubOf(id).closeActor(`u:${uid}`, "revoked");
    await u.closed;
    await a.next("presence").catch(() => null);
    await a.settle();
    expect(names(a.presence().at(-1) as never)).toEqual([key("a")]);
    expect(
      await inDo(id, (_i, s) =>
        s.storage.sql
          .exec("select count(*) as n from viewer_presence_left")
          .one(),
      ),
    ).toEqual({ n: 0 });
  });

  it("closeSockets and destroy clear viewer_presence_left and viewer_presence_state", async () => {
    const id = fresh();
    const a = await joined(id, "a");
    const b = await joined(id, "b");
    b.ws.close(1000);
    await b.closed;
    const count = (table: string) =>
      inDo(id, (_i, s) =>
        s.storage.sql.exec(`select count(*) as n from ${table}`).one(),
      );
    expect(await count("viewer_presence_left")).toEqual({ n: 1 });
    expect(await count("viewer_presence_state")).toEqual({ n: 1 });
    await stubOf(id).closeSockets("x");
    await a.closed;
    expect(await count("viewer_presence_left")).toEqual({ n: 0 });
    expect(await count("viewer_presence_state")).toEqual({ n: 0 });
    // closeAllSockets (the platform suspend) adds no grace rows either. The
    // close handlers are driven inside the DO, right after the close, so the
    // count can't be read before they ran.
    const c = await joined(id, "c", { authzAt: Date.now() + SKEW_MS + 1000 });
    const left = await inDo(id, async (i, s) => {
      const sockets = s.getWebSockets();
      i.closeAllSockets("suspend");
      for (const ws of sockets) await i.webSocketClose(ws, 4403);
      return s.storage.sql
        .exec("select count(*) as n from viewer_presence_left")
        .one();
    });
    await c.closed;
    expect(left).toEqual({ n: 0 });
    expect(await count("viewer_presence_left")).toEqual({ n: 0 });
    await stubOf(id).destroy();
  });

  it('presence frames carry no "u:", "ip:" or email substrings', async () => {
    const id = fresh();
    const uid = `vp-${newId()}`;
    const a = await joined(id, "a", { actor: "ip:198.51.100.77" });
    const u = await joined(id, "u", {
      actor: `u:${uid}`,
      ident: seat("u", { kind: "person", name: "Una" }),
    });
    await a.settle();
    await u.settle();
    for (const s of [a, u]) {
      const text = s.raw.join("\n");
      expect(text).not.toContain("u:");
      expect(text).not.toContain("ip:");
      expect(text).not.toContain("198.51.100");
      expect(text).not.toContain(uid);
      expect(text).not.toContain("@");
    }
  });
});

const touch = (over: Record<string, unknown> = {}) => ({
  key: key("g"),
  product: "Claude Code",
  owner: "Evie",
  ownerActor: "u:owner",
  label: null,
  write: false,
  activity: null,
  ...over,
});
const agentRow = (id: string) =>
  inDo(id, (_i, s) =>
    s.storage.sql
      .exec<{ seen: number }>(
        "select seen from viewer_presence_agent where key = ?",
        key("g"),
      )
      .toArray(),
  );

describe("viewer presence: alarm and agent touches (review fixes)", () => {
  it("a viewer closing while the alarm indexes keeps the grace alarm", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await clock(id, T0 + PRESENCE_COALESCE_MS);
    const b = await joined(id, "b");
    await a.next("presence");
    await stubOf(id).scheduleIndex("art-1", 1);
    const closeAt = T0 + PRESENCE_COALESCE_MS + 1000;
    await inDo(id, (i) => {
      i.indexer = async () => {
        i.now = () => closeAt;
        b.ws.close(1000);
        // The DO's close handler ran once the grace row is there.
        for (let n = 0; n < 500 && i.pendingViewerPresence().left === 0; n++)
          await new Promise((r) => setTimeout(r, 0));
      };
    });
    await clock(id, closeAt);
    await inDo(id, (i) => {
      const run = i.indexer;
      i.indexer = async (...x) => {
        await run(...x);
        i.now = () => closeAt;
      };
    });
    await alarm(id);
    const armed = await inDo(id, (_i, s) => s.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(closeAt + PRESENCE_GRACE_MS);
  });

  it("an unchanged touch inside 10 s writes no row; a changed field writes and notifies", async () => {
    const id = fresh();
    await clock(id, T0);
    const a = await joined(id, "a");
    await stubOf(id).touchViewerAgent(touch());
    await a.next("presence");
    await clock(id, T0 + 5000);
    await stubOf(id).touchViewerAgent(touch());
    expect(await agentRow(id)).toEqual([{ seen: T0 }]);
    await clock(id, T0 + 10_000);
    await stubOf(id).touchViewerAgent(touch());
    expect(await agentRow(id)).toEqual([{ seen: T0 + 10_000 }]);
    await clock(id, T0 + 11_000);
    await stubOf(id).touchViewerAgent(touch({ activity: "Reading" }));
    expect(await agentRow(id)).toEqual([{ seen: T0 + 11_000 }]);
    await clock(id, T0 + 12_000);
    await stubOf(id).touchViewerAgent(touch({ activity: "Reading", write: true }));
    expect(await agentRow(id)).toEqual([{ seen: T0 + 12_000 }]);
  });

  it("a throwing presence record neither fails the write nor loses the index job", async () => {
    const id = fresh();
    await inDo(id, (i) => {
      (i as unknown as { recordViewerAgent: () => never }).recordViewerAgent =
        () => {
          throw new Error("presence storage down");
        };
    });
    const doc = await stubOf(id).set("c", "d1", { a: 1 }, "u:x", touch());
    expect((doc as { id: string }).id).toBe("d1");
    await stubOf(id).scheduleIndex("art-2", 3, false, undefined, touch());
    expect(await stubOf(id).pendingIndex()).toMatchObject({
      artifactId: "art-2",
      version: 3,
    });
  });
});
