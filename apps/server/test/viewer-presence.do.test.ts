// Viewer presence on the ArtifactRuntime events sockets (Task 3): join after
// the access gates, a leave grace, ping/pong, the stale sweep and one
// coalesced presence frame. Straight to the DO, with the route's headers.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ArtifactEventSchema,
  newId,
  PRESENCE_COALESCE_MS,
  PRESENCE_GRACE_MS,
  PRESENCE_PING,
  PRESENCE_PONG,
  PRESENCE_STALE_MS,
  PRESENCE_SWEEP_MS,
  type PresenceFrame,
} from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ACTOR_HEADER,
  ArtifactRuntime,
  AUTHZ_AT_HEADER,
  EVENTS_NAMED_HEADER,
  EVENTS_PING_HEADER,
  EVENTS_VERSION_HEADER,
  VIEWER_PRESENCE_HEADER,
} from "../src/runtime/do.js";
import { SKEW_MS, type UserPresence } from "../src/runtime/presence.js";
import { revokeUserLive } from "../src/runtime/revoke.js";
import type { PresenceIdentity } from "../src/runtime/roster.js";

const SOCKET_TTL_MS = 600_000;
/** Far ahead of the wall clock: alarms armed on this clock never fire alone. */
const BASE = Date.now() + 30 * 86_400_000;

const key = (n: number) => `k${String(n).padStart(15, "0")}`;
const person = (
  n: number,
  name: string | null = `P${n}`,
): PresenceIdentity => ({
  key: key(n),
  kind: "person",
  name,
  guest: false,
});

type Opts = {
  actor?: string;
  at?: number;
  who?: PresenceIdentity | null;
  ping?: boolean;
};
const presenceHeaders = (o: Opts): Record<string, string> => ({
  Upgrade: "websocket",
  [ACTOR_HEADER]:
    o.actor ?? `ip:198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  [AUTHZ_AT_HEADER]: String(o.at ?? BASE),
  [EVENTS_VERSION_HEADER]: "1",
  [EVENTS_NAMED_HEADER]: "1",
  ...(o.who ? { [VIEWER_PRESENCE_HEADER]: JSON.stringify(o.who) } : {}),
  ...(o.ping ? { [EVENTS_PING_HEADER]: "1" } : {}),
});

type Sock = {
  ws: WebSocket;
  raw: string[];
  presence: () => PresenceFrame[];
  closed: Promise<number>;
  /** Resolves once `n` frames (of any kind) have arrived. */
  count: (n: number) => Promise<void>;
  /** Barrier: everything the DO sent before this ping has arrived. */
  sync: () => Promise<void>;
};

function wrap(ws: WebSocket): Sock {
  const raw: string[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    raw.push(String((e as MessageEvent).data));
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
  );
  ws.accept();
  const until = (ok: () => boolean) =>
    new Promise<void>((res) => {
      const check = () => (ok() ? res() : waiters.push(check));
      check();
    });
  const frames = () => raw.filter((r) => r !== PRESENCE_PONG);
  return {
    ws,
    raw,
    closed,
    presence: () =>
      frames()
        .map((r) => ArtifactEventSchema.parse(JSON.parse(r)))
        .filter((f): f is PresenceFrame => f.type === "presence"),
    count: (n) => until(() => frames().length >= n),
    sync: () => {
      const pongs = raw.filter((r) => r === PRESENCE_PONG).length;
      ws.send(PRESENCE_PING);
      return until(() => raw.filter((r) => r === PRESENCE_PONG).length > pongs);
    },
  };
}

type Stub = DurableObjectStub<ArtifactRuntime>;
const stubOf = (id: string) =>
  env.ARTIFACT_RUNTIME.get(
    env.ARTIFACT_RUNTIME.idFromName(id),
  ) as unknown as Stub;

/** An artifact DO whose clock reads `clock.t`. */
async function room(t = BASE) {
  const id = newId();
  const stub = stubOf(id);
  const clock = { t };
  await runInDurableObject(stub, (i: ArtifactRuntime) => {
    i.now = () => clock.t;
  });
  const open = async (o: Opts): Promise<Sock> => {
    const r = await stub.fetch("https://runtime.invalid/events", {
      headers: presenceHeaders(o),
    });
    if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
    return wrap(r.webSocket);
  };
  const inDo = <T>(
    cb: (i: ArtifactRuntime, s: DurableObjectState) => T | Promise<T>,
  ) => runInDurableObject(stub, cb);
  const pending = () => inDo((i) => i.pendingViewerPresence());
  /** Waits (bounded) for the DO's close handler to have recorded `left` rows. */
  const leftIs = async (n: number) => {
    const end = Date.now() + 5_000;
    while ((await pending()).left !== n) {
      if (Date.now() > end) throw new Error(`left never reached ${n}`);
      await inDo(() => {});
    }
  };
  const alarmAt = () => inDo((_i, s) => s.storage.getAlarm());
  const alarm = () => runDurableObjectAlarm(stub);
  return { id, stub, clock, open, inDo, pending, leftIs, alarmAt, alarm };
}

const names = (f: PresenceFrame | undefined) => f?.viewers.map((v) => v.name);
const last = (s: Sock) => s.presence().at(-1);

describe("viewer presence on R.events", () => {
  it("hello carries you; the joiner gets the current roster right after hello", async () => {
    const r = await room();
    const a = await r.open({ who: person(1, "Ann") });
    await a.count(2);
    const [hello, roster] = a.raw.map((x) => JSON.parse(x));
    expect(hello).toEqual({ type: "hello", version: 1, you: key(1) });
    expect(roster).toMatchObject({
      type: "presence",
      total: 1,
      viewers: [{ key: key(1), kind: "person", name: "Ann", named: true }],
    });
    a.ws.close();
  });

  it("a second socket's join reaches the first as one presence frame", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await b.count(2);
    expect(names(last(b))).toEqual(["P2", "P1"]);
    await a.sync();
    expect(a.presence()).toHaveLength(2);
    expect(names(last(a))).toEqual(["P2", "P1"]);
    a.ws.close();
    b.ws.close();
  });

  it("three joins inside PRESENCE_COALESCE_MS send one frame, flushed by the alarm", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    const joined: Sock[] = [];
    for (let n = 2; n <= 4; n++) {
      r.clock.t += 100;
      joined.push(await r.open({ who: person(n) }));
    }
    await a.sync();
    expect(a.presence()).toHaveLength(1);
    expect(await r.alarmAt()).toBe(BASE + PRESENCE_COALESCE_MS);
    r.clock.t = BASE + PRESENCE_COALESCE_MS;
    await r.alarm();
    await a.sync();
    expect(a.presence()).toHaveLength(2);
    expect(names(last(a))).toEqual(["P4", "P3", "P2", "P1"]);
    for (const s of [a, ...joined]) s.ws.close();
  });

  it("two sockets of one key show once; closing one keeps the face", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    const a2 = await r.open({ who: person(1) });
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await b.count(2);
    expect(names(last(b))).toEqual(["P2", "P1"]);
    expect(last(b)?.total).toBe(2);
    a2.ws.close();
    await a2.closed;
    await r.inDo(() => {});
    expect((await r.pending()).left).toBe(0);
    r.clock.t += PRESENCE_GRACE_MS * 2;
    await r.alarm();
    await b.sync();
    expect(b.presence()).toHaveLength(1);
    for (const s of [a, b]) s.ws.close();
  });

  it("a clean close leaves after PRESENCE_GRACE_MS, not before", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await a.count(3);
    r.clock.t += 2_000;
    const closedAt = r.clock.t;
    b.ws.close();
    await r.leftIs(1);
    expect(await r.alarmAt()).toBe(closedAt + PRESENCE_GRACE_MS);
    r.clock.t = closedAt + PRESENCE_GRACE_MS - 1_000;
    await r.alarm();
    await a.sync();
    expect(a.presence()).toHaveLength(2);
    r.clock.t = closedAt + PRESENCE_GRACE_MS;
    await r.alarm();
    await a.sync();
    expect(a.presence()).toHaveLength(3);
    expect(names(last(a))).toEqual(["P1"]);
    expect((await r.pending()).left).toBe(0);
    a.ws.close();
  });

  it("a reconnect inside the grace keeps the original since and position", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    r.clock.t += 2_000;
    const c = await r.open({ who: person(3) });
    await c.count(2);
    expect(names(last(c))).toEqual(["P3", "P2", "P1"]);
    b.ws.close();
    await r.leftIs(1);
    r.clock.t += 3_000;
    const b2 = await r.open({ who: person(2) });
    await b2.count(2);
    expect(names(last(b2))).toEqual(["P3", "P2", "P1"]);
    expect((await r.pending()).left).toBe(0);
    for (const s of [a, b2, c]) s.ws.close();
  });

  it("a rejoin after the grace gets a fresh since", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    r.clock.t += 2_000;
    const c = await r.open({ who: person(3) });
    await c.count(2);
    b.ws.close();
    await r.leftIs(1);
    // Expired but not yet swept by the alarm: still not reused.
    r.clock.t += PRESENCE_GRACE_MS + 1;
    const b2 = await r.open({ who: person(2) });
    await b2.count(2);
    expect(names(last(b2))).toEqual(["P2", "P3", "P1"]);
    for (const s of [a, b2, c]) s.ws.close();
  });

  it('"ping" gets "pong" and does not close the socket; any other message still closes 1008', async () => {
    const r = await room();
    const a = await r.open({ who: person(1), ping: true });
    await a.sync();
    await a.sync();
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.send("hi");
    expect(await a.closed).toBe(1008);
  });

  it("a pinging socket with no auto-response for PRESENCE_STALE_MS is closed by the alarm and leaves", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2), ping: true });
    await a.count(3);
    r.clock.t = BASE + 2_000 + PRESENCE_STALE_MS + 1;
    await r.alarm();
    expect(await b.closed).toBe(1001);
    expect((await r.pending()).left).toBe(1);
    await a.sync();
    expect(a.presence()).toHaveLength(2);
    r.clock.t += PRESENCE_GRACE_MS;
    await r.alarm();
    await a.sync();
    expect(names(last(a))).toEqual(["P1"]);
    a.ws.close();
  });

  it("a socket opened without X-OA-Ping is never swept as stale", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    r.clock.t = BASE + PRESENCE_STALE_MS * 4;
    await r.alarm();
    await a.sync();
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect((await r.pending()).left).toBe(0);
    a.ws.close();
  });

  it("while a ping=1 socket is open the alarm is armed at most PRESENCE_SWEEP_MS ahead; with only non-pinging sockets (or none) no sweep alarm is armed", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    expect(await r.alarmAt()).toBe(BASE + SOCKET_TTL_MS);
    r.clock.t = BASE + PRESENCE_SWEEP_MS;
    await r.alarm();
    expect(await r.alarmAt()).toBe(BASE + SOCKET_TTL_MS);

    r.clock.t += 1_000;
    const t1 = r.clock.t;
    const b = await r.open({ who: person(2), ping: true });
    await b.count(2);
    expect(await r.alarmAt()).toBe(t1 + PRESENCE_SWEEP_MS);
    r.clock.t = t1 + PRESENCE_SWEEP_MS;
    await r.alarm();
    expect(await r.alarmAt()).toBe(t1 + PRESENCE_SWEEP_MS * 2);

    b.ws.close();
    a.ws.close();
    await r.leftIs(2);
    r.clock.t = t1 + PRESENCE_SWEEP_MS + PRESENCE_GRACE_MS;
    await r.alarm();
    expect((await r.pending()).left).toBe(0);
    expect(await r.alarmAt()).toBeNull();
  });

  it("after a fresh instance on the same storage, the roster is rebuilt from attachments and viewer_presence_left", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    r.clock.t += 2_000;
    const c = await r.open({ who: person(3) });
    await a.count(4);
    r.clock.t = BASE + 10_000;
    c.ws.close();
    await r.leftIs(1);
    r.clock.t = BASE + 12_000;
    b.ws.close();
    await r.leftIs(2);
    await a.sync();
    const before = a.presence().length;
    await r.inDo(async (_i, state) => {
      const fresh = new ArtifactRuntime(state as never, env as never);
      fresh.now = () => BASE + 10_000 + PRESENCE_GRACE_MS;
      await fresh.alarm();
      expect(fresh.pendingViewerPresence().left).toBe(1);
    });
    await a.sync();
    expect(a.presence()).toHaveLength(before + 1);
    expect(names(last(a))).toEqual(["P2", "P1"]);
    a.ws.close();
  });

  it("a socket without X-OA-Viewer-Presence gets no presence frames and is not counted", async () => {
    const r = await room();
    const e = await r.open({ who: null });
    await e.count(1);
    expect(JSON.parse(e.raw[0] as string)).toEqual({
      type: "hello",
      version: 1,
    });
    r.clock.t += 2_000;
    const a = await r.open({ who: person(1) });
    await a.count(2);
    expect(last(a)?.total).toBe(1);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await a.count(3);
    expect(last(a)?.total).toBe(2);
    await e.sync();
    expect(e.presence()).toHaveLength(0);
    e.ws.close();
    expect((await r.pending()).left).toBe(0);
    a.ws.close();
    b.ws.close();
  });

  it("a stale socket never joins: it gets gone with retryAfterMs, then 4403; others get no presence frame; no grace row", async () => {
    const r = await room();
    await r.stub.closeSockets("changed");
    const changed = BASE;
    r.clock.t += SKEW_MS + 10;
    const a = await r.open({ who: person(1), at: changed + SKEW_MS + 1 });
    await a.count(2);
    const s = await r.open({ who: person(2), at: changed + SKEW_MS });
    expect(await s.closed).toBe(4403);
    const gone = JSON.parse(s.raw[0] as string);
    expect(gone).toMatchObject({ type: "gone", reason: "changed" });
    expect(gone.retryAfterMs).toBeGreaterThan(0);
    expect(s.raw).toHaveLength(1);
    await a.sync();
    expect(a.presence()).toHaveLength(1);
    await r.inDo(() => {});
    expect((await r.pending()).left).toBe(0);
    a.ws.close();
  });

  it("a socket whose UserPresence.touch refuses never joins and writes no grace row", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    const uid = `vp-rev-${newId()}`;
    await revokeUserLive(env, uid, "removed");
    const ns = env.USER_PRESENCE;
    if (!ns) throw new Error("USER_PRESENCE unbound");
    const revokedAt = await runInDurableObject(
      ns.get(ns.idFromName(uid)) as unknown as DurableObjectStub<UserPresence>,
      (p) => p.revokedAt(),
    );
    r.clock.t += 2_000;
    const s = await r.open({
      who: person(2),
      actor: `u:${uid}`,
      at: revokedAt as number,
    });
    expect(await s.closed).toBe(4403);
    expect(s.raw.some((x) => x.includes('"hello"'))).toBe(false);
    await a.sync();
    expect(a.presence()).toHaveLength(1);
    await r.inDo(() => {});
    expect((await r.pending()).left).toBe(0);
    a.ws.close();
  });

  it('closeActor("u:{id}") removes that person\'s face at once, with no grace row', async () => {
    const r = await room();
    const uid = `vp-ca-${newId()}`;
    const p = await r.open({
      who: person(1),
      actor: `u:${uid}`,
      at: Date.now(),
    });
    await p.count(2);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await b.count(2);
    expect(names(last(b))).toEqual(["P2", "P1"]);
    r.clock.t += 2_000;
    expect(await r.stub.closeActor(`u:${uid}`, "revoked")).toBe(1);
    expect(await p.closed).toBe(4403);
    await b.count(3);
    expect(names(last(b))).toEqual(["P2"]);
    await r.inDo(() => {});
    expect((await r.pending()).left).toBe(0);
    b.ws.close();
  });

  it("closeSockets and destroy clear viewer_presence_left and viewer_presence_state", async () => {
    for (const how of ["closeSockets", "destroy"] as const) {
      const r = await room();
      const a = await r.open({ who: person(1) });
      r.clock.t += 2_000;
      const b = await r.open({ who: person(2) });
      await b.count(2);
      a.ws.close();
      await r.leftIs(1);
      expect((await r.pending()).sentAt).toBe(BASE + 2_000);
      if (how === "closeSockets") await r.stub.closeSockets("changed");
      else await r.stub.destroy();
      await b.closed;
      await r.inDo(() => {});
      expect(await r.pending()).toEqual({ left: 0, sentAt: null });
    }
  });

  it('presence frames carry no "u:", "ip:" or email substrings', async () => {
    const r = await room();
    const uid = `vp-leak-${newId()}`;
    const p = await r.open({
      who: person(1, "ann@example.com"),
      actor: `u:${uid}`,
      at: Date.now(),
    });
    r.clock.t += 2_000;
    const q = await r.open({
      who: { key: key(2), kind: "anon", name: null, guest: false },
      actor: "ip:203.0.113.9",
    });
    await p.count(3);
    await q.count(2);
    const all = [...p.raw, ...q.raw].join("\n");
    expect(all).not.toContain("u:");
    expect(all).not.toContain("ip:");
    expect(all).not.toContain(uid);
    expect(all).not.toContain("203.0.113.9");
    expect(all).not.toContain("actor");
    // The actor stays server-side, in the attachment.
    const metas = await r.inDo((_i, s) =>
      s.getWebSockets("~vp").map((w) => w.deserializeAttachment()),
    );
    expect(metas).toContainEqual(
      expect.objectContaining({
        p: expect.objectContaining({ actor: `u:${uid}` }),
      }),
    );
    p.ws.close();
    q.ws.close();
  });

  it("an invalid X-OA-Viewer-Presence is 400", async () => {
    const r = await room();
    const res = await r.stub.fetch("https://runtime.invalid/events", {
      headers: {
        ...presenceHeaders({}),
        [VIEWER_PRESENCE_HEADER]: '{"key":"short","kind":"person"}',
      },
    });
    expect(res.status).toBe(400);
  });

  it("a grace row written while the alarm awaits the indexer keeps an alarm at or before its until", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    r.clock.t += 2_000;
    const b = await r.open({ who: person(2) });
    await a.count(3);
    // Plain flags, not promises: a promise can't be settled across the test's
    // and the alarm's I/O contexts. The indexer waits (bounded) for release.
    const gate = { started: false, released: false };
    await r.inDo(async (i) => {
      await i.scheduleIndex(r.id, 1);
      i.indexer = async () => {
        gate.started = true;
        const end = Date.now() + 10_000;
        while (!gate.released && Date.now() < end)
          await new Promise((res) => setTimeout(res, 5));
      };
    });
    const run = r.alarm();
    await vi.waitFor(() => expect(gate.started).toBe(true));
    r.clock.t += 1_000;
    const closedAt = r.clock.t;
    b.ws.close();
    await r.leftIs(1);
    gate.released = true;
    await run;
    const at = await r.alarmAt();
    expect(at).not.toBeNull();
    expect(at as number).toBeLessThanOrEqual(closedAt + PRESENCE_GRACE_MS);
    expect(await r.inDo((i) => i.pendingIndex())).toBeNull();
    const before = a.presence().length;
    r.clock.t = closedAt + PRESENCE_GRACE_MS;
    await r.alarm();
    await a.sync();
    expect(a.presence()).toHaveLength(before + 1);
    expect(names(last(a))).toEqual(["P1"]);
    a.ws.close();
  });

  it("a failing flush logs viewer_presence_flush_failed and never fails a join, closeActor or alarm", async () => {
    const r = await room();
    const a = await r.open({ who: person(1) });
    await a.count(2);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = () =>
      spy.mock.calls.filter((c) =>
        String(c[0]).includes("viewer_presence_flush_failed"),
      ).length;
    try {
      // The schema is not recreated while the instance is ready: every
      // read of the state row now throws.
      await r.inDo((_i, st) => {
        st.storage.sql.exec("drop table viewer_presence_state");
      });
      r.clock.t += 2_000;
      const b = await r.open({ who: person(2) });
      await b.count(2);
      expect(JSON.parse(b.raw[0] as string)).toEqual({
        type: "hello",
        version: 1,
        you: key(2),
      });
      expect(names(last(b))).toEqual(["P2", "P1"]);
      expect(logged()).toBe(1);
      expect(await r.stub.closeActor("ip:192.0.2.250", "x")).toBe(0);
      await vi.waitFor(() => expect(logged()).toBe(2));
      r.clock.t += 2_000;
      await r.alarm();
      expect(logged()).toBeGreaterThanOrEqual(3);
      expect(b.ws.readyState).toBe(WebSocket.OPEN);
      a.ws.close();
      b.ws.close();
    } finally {
      spy.mockRestore();
    }
  });
});
