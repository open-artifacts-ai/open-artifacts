// Test helpers for the bus (#1291), ported from OpenBus 0.63.0's
// apps/server/test/helpers.ts. A machine is a D1 bus_machines row of a test
// member (OpenBus seeded it in its hub); a daemon connects through the real
// Worker entry at GET /bus/connect with the machine token, as the local
// client does.
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  newId,
  newMachineToken,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterAll, expect, vi } from "vitest";
import { type BusHub, busHubName } from "../../src/bus/hub.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { login } from "../helpers.js";

export const e = env as unknown as Env;

/** A member with a session cookie. */
export type Member = { userId: string; cookie: string };

let memberSeq = 0;
/** A new active member (role "member" unless given). */
export async function member(
  role: "member" | "admin" | "owner" | "guest" = "member",
): Promise<Member> {
  const m = await login(
    `bus-${++memberSeq}-${newId().slice(0, 8)}@x.com`,
    role,
  );
  touchedUsers.add(m.userId);
  return m;
}

let owner: Promise<Member> | null = null;
/** The one member whose hub most ported tests drive (OpenBus's single owner). */
export const theOwner = (): Promise<Member> => {
  owner ??= member();
  return owner;
};

/** Seeds an approved machine for `userId` (default: theOwner) in D1; returns its id and token. */
export async function machine(
  label = "MacBook",
  userId?: string,
): Promise<{ id: string; token: string; userId: string }> {
  const uid = userId ?? (await theOwner()).userId;
  touchedUsers.add(uid);
  const id = newId();
  const token = newMachineToken();
  await e.DB.prepare(
    "insert into bus_machines (id, user_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(id, uid, label, await sha256Hex(token), Date.now())
    .run();
  return { id, token, userId: uid };
}

/** The hub stub of `userId` (default: theOwner). */
export async function hubOf(
  userId?: string,
): Promise<DurableObjectStub<BusHub>> {
  const uid = userId ?? (await theOwner()).userId;
  const ns = e.BUS_HUB;
  if (!ns) throw new Error("BUS_HUB unbound in the test pool");
  return ns.get(
    ns.idFromName(busHubName(uid)),
  ) as unknown as DurableObjectStub<BusHub>;
}

/** Runs `fn` inside the owner's hub (SQL seeding, revokes). */
export const inOwnerHub = async <R>(fn: (s: DurableObjectState) => R) =>
  runInDurableObject(await hubOf(), (_: BusHub, s: DurableObjectState) =>
    fn(s),
  );

/** Calls the Worker entry (index.ts) with a real ExecutionContext. */
export async function workerFetch(
  req: Request,
  ev: unknown = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(req as never, ev as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return r;
}

/**
 * How long `next` waits for a frame before failing the test: a ceiling for
 * a missing frame, never a delay (OpenBus's 2 s timed out under full-suite
 * load on the flood tests).
 */
const FRAME_WAIT_MS = 15_000;

export type Daemon = {
  ws: WebSocket;
  /** Every raw text message received, in order (frames and PONGs). */
  raw: string[];
  next: () => Promise<ServerFrame>;
  send: (f: ClientFrame) => void;
  close: () => void;
  closed: Promise<{ code: number; reason: string }>;
};

/** Upgrades GET /bus/connect through the Worker entry point, as the local client does. */
export function upgrade(
  token: string | null,
  extra: Record<string, string> = {},
  ev: unknown = env,
): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket", ...extra };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return workerFetch(
    new Request("http://app.localhost/bus/connect", { headers }),
    ev,
  );
}

/** Room for the index to settle when the whole suite loads the worker pool. */
const INDEX_SETTLE_MS = 20_000;
const CLOSE_WAIT_MS = 10_000;
const HOOK_MS = CLOSE_WAIT_MS + 2 * INDEX_SETTLE_MS + 5_000;

const opened = new Set<Daemon>();
/** Users whose hub this file may have opened a socket on. */
const touchedUsers = new Set<string>();
const rawSockets = new Map<WebSocket, Promise<unknown>>();

/**
 * Registers a socket a test opened without `daemon()` (a raw upgrade, a hub
 * stub forward). The file's afterAll closes it and waits for the close, so the
 * hub's last-socket work does not run at worker teardown.
 */
export function trackSocket<T extends WebSocket>(ws: T): T {
  rawSockets.set(
    ws,
    new Promise((r) => ws.addEventListener("close", r, { once: true })),
  );
  return ws;
}

// #1299: a hub removes its install-index row (`gone`) when its last socket
// closes. A file that ends with sockets still closing would tear the worker
// down with that RPC in flight (vitest: "Closing rpc while resolve was
// pending"), so close every socket the file opened and wait for the index to
// hold no bus rows.
afterAll(async () => {
  const closes: Promise<unknown>[] = [...opened].map((d) => d.closed);
  for (const d of opened)
    try {
      d.close();
    } catch {
      // Already closed.
    }
  for (const [ws, closed] of rawSockets) {
    closes.push(closed);
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed or never accepted.
    }
  }
  // A socket the hub already tore down reported its close earlier. A close
  // that never arrives fails the file with a clear message, inside the hook's
  // own timeout; giving up silently is what let the worker tear down with the
  // hub's `gone` RPC still in flight.
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(closes),
    new Promise<never>((_, reject) => {
      giveUp = setTimeout(
        () =>
          reject(
            new Error(
              `bus sockets still open ${CLOSE_WAIT_MS} ms after the file's afterAll closed them`,
            ),
          ),
        CLOSE_WAIT_MS,
      );
    }),
  ]).finally(() => clearTimeout(giveUp));
  opened.clear();
  rawSockets.clear();
  const ns = e.USER_PRESENCE;
  if (!ns) return;
  const idx = ns.get(ns.idFromName("~install"));
  const rows = (): Promise<number> =>
    runInDurableObject(idx, (_i, s: DurableObjectState) => {
      // The index creates its tables on first use; a file that never opened a
      // socket has none, and no rows to wait for.
      const has = s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from sqlite_master where name = 'seen'",
        )
        .one().n;
      if (!has) return 0;
      return s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from seen where substr(artifact_id, 1, 4) = 'bus:'",
        )
        .one().n;
    });
  // A client close is only the echo of the hub's: the hub's work after it (the
  // `gone` it sends) runs later. Wait until every hub this file touched holds
  // no open daemon socket and has no index call in flight, so the worker is
  // not torn down with one pending.
  for (const uid of touchedUsers) {
    const ns = e.BUS_HUB;
    if (!ns) break;
    const hub = ns.get(ns.idFromName(busHubName(uid)));
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(
            hub,
            (_i, s: DurableObjectState) =>
              s.getWebSockets("daemon").filter((w) => w.readyState === 1)
                .length,
          ),
        ).toBe(0),
      { timeout: INDEX_SETTLE_MS },
    );
    // A hub-started close does not wait for the echo: its index report may
    // still be on the wire after no socket is open.
    await vi.waitFor(
      async () =>
        expect(await (hub as unknown as BusHub).indexInFlight()).toBe(0),
      { timeout: INDEX_SETTLE_MS },
    );
  }
  touchedUsers.clear();
  // The close events above are the client's; the hub's `gone` report lands
  // after them. Wait for the index to show it, and fail the file (not warn) if
  // a row stays: that is a hub that never reported its last socket gone.
  await vi.waitFor(async () => expect(await rows()).toBe(0), {
    timeout: INDEX_SETTLE_MS,
  });
}, HOOK_MS);

/** A daemon socket. Every frame it receives must parse with decodeServerFrame. */
export async function daemon(
  token: string,
  extra: Record<string, string> = {},
  /** Opens the upgrade another way (e.g. a hosted env with ctx.props). */
  open: (token: string, extra: Record<string, string>) => Promise<Response> = (
    t,
    x,
  ) => upgrade(t, x),
): Promise<Daemon> {
  const res = await open(token, extra);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const raw: string[] = [];
  const queue: ServerFrame[] = [];
  const waiting: ((f: ServerFrame) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const text = String(ev.data);
    raw.push(text);
    if (text === PONG) return;
    const r = decodeServerFrame(text);
    // Recorded, then failed loudly in the test that reads it.
    expect(r.ok, `not a server frame: ${text}`).toBe(true);
    if (!r.ok) return;
    const w = waiting.shift();
    if (w) w(r.frame);
    else queue.push(r.frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) =>
      resolve({ code: ev.code, reason: ev.reason }),
    ),
  );
  const next = () => {
    const f = queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        FRAME_WAIT_MS,
      );
      waiting.push((frame) => {
        clearTimeout(t);
        resolve(frame);
      });
    });
  };
  const d: Daemon = {
    ws,
    raw,
    next,
    send: (f) => ws.send(encodeFrame(f)),
    close: () => ws.close(1000, "bye"),
    closed,
  };
  opened.add(d);
  return d;
}

/** Consumes frames until one matches `type` (roster broadcasts may interleave). */
export async function waitFor<T extends ServerFrame["type"]>(
  conn: { next: () => Promise<ServerFrame> },
  type: T,
): Promise<Extract<ServerFrame, { type: T }>> {
  for (let i = 0; i < 5000; i++) {
    const f = await conn.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type} frame`);
}

/** Every server frame received so far, parsed (PONGs skipped). */
export const framesSeen = (d: Daemon): ServerFrame[] =>
  d.raw
    .filter((t) => t !== PONG)
    .map((t) => {
      const r = decodeServerFrame(t);
      if (!r.ok) throw new Error(`not a server frame: ${t}`);
      return r.frame;
    });

let seq = 0;
/** A namespace no other test uses, so names never collide across tests. */
export const ns = (tag = "ns") => `test.local/${tag}-${++seq}-${Date.now()}`;

export const hello = (id = "h1"): ClientFrame => ({
  v: 1,
  id,
  type: "hello",
  machine_label: "MacBook",
  client_version: "0.1.0",
});

export const up = (
  id: string,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): ClientFrame => ({
  v: 1,
  id,
  type: "agent_up",
  agent_ref: ref,
  kind: "opencode",
  proposed_name: name,
  namespace,
  global,
});

/** Opens a daemon, says hello and waits for hello_ok; returns the socket. */
export async function ready(token: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send(hello());
  await waitFor(d, "hello_ok");
  return d;
}
