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
import { expect } from "vitest";
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
  return login(`bus-${++memberSeq}-${newId().slice(0, 8)}@x.com`, role);
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
export async function hubOf(userId?: string): Promise<DurableObjectStub<BusHub>> {
  const uid = userId ?? (await theOwner()).userId;
  const ns = e.BUS_HUB;
  if (!ns) throw new Error("BUS_HUB unbound in the test pool");
  return ns.get(ns.idFromName(busHubName(uid))) as unknown as DurableObjectStub<BusHub>;
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

/** A daemon socket. Every frame it receives must parse with decodeServerFrame. */
export async function daemon(
  token: string,
  extra: Record<string, string> = {},
): Promise<Daemon> {
  const res = await upgrade(token, extra);
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
        2000,
      );
      waiting.push((frame) => {
        clearTimeout(t);
        resolve(frame);
      });
    });
  };
  return {
    ws,
    raw,
    next,
    send: (f) => ws.send(encodeFrame(f)),
    close: () => ws.close(1000, "bye"),
    closed,
  };
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
