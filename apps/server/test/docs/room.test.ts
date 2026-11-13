// DocRoom (#1100): relay, batching, compaction, caps, hibernation wake.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  COMPACT_ROW_BYTES,
  COMPACT_ROWS,
  DOC_MAX_BYTES,
  DOC_ROLE_HEADER,
  DOC_TOO_LARGE_FRAME,
  DocRoom,
  MAX_EDIT_SOCKETS,
  MAX_SOCKETS_PER_ACTOR,
} from "../../src/docs/room.js";
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../../src/runtime/do.js";

let seq = 0;
const roomStub = () => {
  const ns = env.DOC_ROOM;
  if (!ns) throw new Error("DOC_ROOM unbound");
  return ns.get(ns.idFromName(`room-${++seq}-${Math.random()}`));
};
type Stub = ReturnType<typeof roomStub>;

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  texts: string[];
  /** The hello frames (JSON), kept apart from the room's other text frames. */
  hellos: string[];
  /** Server state vectors seen in sync step 1. */
  serverSvs: Uint8Array[];
  /** Resolves when `pred` holds (checked on every frame). */
  until: (pred: () => boolean) => Promise<void>;
  /** A step 1 round trip: all earlier frames of this socket are processed. */
  ping: () => Promise<void>;
  closed: Promise<void>;
}

const widened = new WeakSet<object>();

async function connect(
  stub: Stub,
  o: {
    role?: "edit" | "read";
    actor?: string;
    authzAt?: number;
    /** Keep the real per-actor full-state budget (default: widened). */
    strict?: boolean;
  } = {},
): Promise<Client> {
  if (!o.strict && !widened.has(stub)) {
    widened.add(stub);
    await runInDurableObject(stub, (r: DocRoom) => {
      r.budgetCap = 1_000_000;
    });
  }
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    [ACTOR_HEADER]: o.actor ?? `u:user-${++seq}`,
    [DOC_ROLE_HEADER]: o.role ?? "edit",
    [AUTHZ_AT_HEADER]: String(o.authzAt ?? Date.now()),
  };
  const res = await stub.fetch("https://room/ws", { headers });
  if (res.status !== 101) throw new Error(`status ${res.status}`);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const texts: string[] = [];
  const hellos: string[] = [];
  const serverSvs: Uint8Array[] = [];
  const checks = new Set<() => void>();
  let pongs = 0;
  const closed = new Promise<void>((r) =>
    ws.addEventListener("close", () => r()),
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      if (e.data.startsWith('{"type":"hello"')) hellos.push(e.data);
      else texts.push(e.data);
    } else {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const sub = decoding.peekVarUint(dec);
        if (sub === 0) {
          const copy = decoding.createDecoder(
            new Uint8Array(e.data as ArrayBuffer),
          );
          decoding.readVarUint(copy);
          decoding.readVarUint(copy);
          serverSvs.push(decoding.readVarUint8Array(copy));
        }
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, "remote");
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === 1) pongs++;
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(dec),
          "remote",
        );
      }
    }
    for (const c of [...checks]) c();
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    ws.send(encoding.toUint8Array(enc));
  });
  const until = (pred: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (pred()) {
          checks.delete(check);
          resolve();
        }
      };
      checks.add(check);
      check();
    });
  const ping = async () => {
    const want = pongs + 1;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    ws.send(encoding.toUint8Array(enc));
    await until(() => pongs >= want);
  };
  const c: Client = {
    ws,
    doc,
    awareness,
    texts,
    hellos,
    serverSvs,
    until,
    ping,
    closed,
  };
  // Initial sync: our step 1 to the room, then wait for its state.
  await c.until(() => serverSvs.length > 0);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
  await c.until(() => pongs >= 1);
  return c;
}

const type = (c: Client, s: string) => c.doc.getText("t").insert(0, s);
const textOf = (c: Client) => c.doc.getText("t").toString();

const inRoom = <T>(stub: Stub, f: (r: DocRoom) => T | Promise<T>) =>
  runInDurableObject(stub, (r: DocRoom) => f(r));
const rows = (stub: Stub) =>
  inRoom(
    stub,
    (r) =>
      (r as unknown as { sql: SqlStorage }).sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM updates")
        .one().n,
  );
const snapRows = (stub: Stub) =>
  inRoom(
    stub,
    (r) =>
      (r as unknown as { sql: SqlStorage }).sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM snapshot")
        .one().n,
  );

describe("DocRoom relay", () => {
  it("two clients sync a doc through the room", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    type(a, "hello");
    await b.until(() => textOf(b) === "hello");
    b.doc.getText("t").insert(5, " world");
    await a.until(() => textOf(a) === "hello world");
    expect(await inRoom(stub, (r) => r.docLoads)).toBe(0);
  });

  it("a fresh joiner gets the full state from the buffer, rows and snapshot", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "one ");
    await a.ping();
    // Still in the buffer.
    const j0 = await connect(stub);
    await j0.until(() => textOf(j0) === "one ");
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(1);
    a.doc.getText("t").insert(4, "two ");
    await a.ping();
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(2);
    const j1 = await connect(stub);
    await j1.until(() => textOf(j1) === "one two ");
    // Compacted into a snapshot.
    await inRoom(stub, (r) => r.compact());
    expect(await rows(stub)).toBe(0);
    expect(await snapRows(stub)).toBe(1);
    a.doc.getText("t").insert(8, "three");
    await a.ping();
    await runDurableObjectAlarm(stub);
    const j2 = await connect(stub);
    await j2.until(() => textOf(j2) === "one two three");
    // The state vector kept incrementally equals the doc's.
    const sv = j2.serverSvs[0] as Uint8Array;
    expect(Y.decodeStateVector(sv)).toEqual(
      Y.decodeStateVector(Y.encodeStateVector(a.doc)),
    );
  });

  it("drops a read socket's update but answers its sync step 1", async () => {
    const stub = roomStub();
    const reader = await connect(stub, { role: "read" });
    const editor = await connect(stub);
    type(reader, "sneaky");
    await reader.ping();
    expect(await inRoom(stub, (r) => r.size())).toBe(0);
    expect(textOf(editor)).toBe("");
    // It still receives edits and can ask for state.
    type(editor, "real");
    await reader.until(() => textOf(reader).includes("real"));
    const late = await connect(stub);
    await late.until(() => textOf(late) === "real");
  });

  it("refuses an update past the cap, with an error frame and no broadcast", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    type(a, "x".repeat(DOC_MAX_BYTES + 1));
    await a.until(() => a.texts.length > 0);
    expect(a.texts[0]).toBe(DOC_TOO_LARGE_FRAME);
    await b.ping();
    expect(textOf(b)).toBe("");
    expect(await inRoom(stub, (r) => r.size())).toBe(0);
    const c = await connect(stub);
    expect(textOf(c)).toBe("");
  });

  it("squeezes in the alarm, never on the socket, when rows overcount", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const flush = async () => {
      await a.ping();
      await runDurableObjectAlarm(stub);
    };
    type(a, "b".repeat(1_900_000));
    await flush();
    const chunk = "c".repeat(100_000);
    a.doc.getText("t").insert(0, chunk);
    await flush();
    a.doc.getText("t").delete(0, chunk.length);
    await flush();
    const loads = await inRoom(stub, (r) => r.docLoads);
    a.doc.getText("t").insert(0, chunk);
    await a.until(() => a.texts.length > 0);
    expect(a.texts[0]).toBe(DOC_TOO_LARGE_FRAME);
    // The refusal itself loaded nothing; the alarm it armed compacts.
    expect(await inRoom(stub, (r) => r.docLoads)).toBe(loads);
    await runDurableObjectAlarm(stub);
    expect(await inRoom(stub, (r) => r.docLoads)).toBeGreaterThan(loads);
    expect(await rows(stub)).toBe(0);
    // The client reverted the refused update; a retry now fits.
    a.texts.length = 0;
    a.doc.getText("t").insert(0, "ok");
    await a.ping();
    expect(a.texts).toEqual([]);
  });
});

describe("DocRoom storage", () => {
  it("batches many updates in one second into one row, one alarm", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    for (let i = 0; i < 50; i++) a.doc.getText("t").insert(i, "k");
    await a.ping();
    expect(await rows(stub)).toBe(0);
    expect(
      await runInDurableObject(stub, (_r, st) => st.storage.getAlarm()),
    ).not.toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(1);
    // Buffer empty again: the next update arms a new alarm.
    a.doc.getText("t").insert(0, "z");
    await a.ping();
    expect(
      await runInDurableObject(stub, (_r, st) => st.storage.getAlarm()),
    ).not.toBeNull();
  });

  it("compacts past the row threshold", async () => {
    const stub = roomStub();
    // One synchronous pass inside the room: no socket timing, no clock.
    const out = await inRoom(stub, (r) => {
      const x = r as unknown as {
        sql: SqlStorage;
        buffer: Uint8Array[];
        bufferBytes: number;
      };
      const snaps = () =>
        x.sql.exec<{ n: number }>("SELECT count(*) AS n FROM snapshot").one().n;
      const d = new Y.Doc();
      let pending: Uint8Array | null = null;
      d.on("update", (u: Uint8Array) => {
        pending = u;
      });
      const before: number[] = [];
      for (let i = 0; i <= COMPACT_ROWS; i++) {
        d.getText("t").insert(0, "k");
        x.buffer.push(pending as unknown as Uint8Array);
        x.bufferBytes += (pending as unknown as Uint8Array).byteLength;
        r.flush();
        if (i < COMPACT_ROWS) before.push(snaps());
      }
      return { before, after: snaps() };
    });
    expect(out.before.every((n) => n === 0)).toBe(true);
    expect(out.after).toBe(1);
    expect(await rows(stub)).toBe(0);
    const j = await connect(stub);
    await j.until(() => textOf(j).length === COMPACT_ROWS + 1);
  });

  it("compacts past the byte threshold", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "y".repeat(COMPACT_ROW_BYTES + 1000));
    await a.ping();
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(0);
    expect(await snapRows(stub)).toBe(1);
  });

  it("a woken room answers sync step 1 without loading the doc", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "persisted");
    await a.ping();
    await runDurableObjectAlarm(stub);
    // A second instance over the same storage is what a wake runs.
    const loads = await runInDurableObject(stub, async (_r, state) => {
      const fresh = new DocRoom(state, env);
      const [ws] = state.getWebSockets();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, new Y.Doc());
      fresh.webSocketMessage(
        ws as WebSocket,
        encoding.toUint8Array(enc).buffer as ArrayBuffer,
      );
      return fresh.docLoads;
    });
    expect(loads).toBe(0);
    const j = await connect(stub);
    await j.until(() => textOf(j) === "persisted");
  });
});

describe("DocRoom awareness", () => {
  it("relays awareness and broadcasts its removal when a socket closes", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    a.awareness.setLocalState({ name: "A" });
    const upd = awarenessProtocol.encodeAwarenessUpdate(a.awareness, [
      a.doc.clientID,
    ]);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, upd);
    a.ws.send(encoding.toUint8Array(enc));
    await b.until(() => b.awareness.getStates().has(a.doc.clientID));
    a.ws.close(1000, "bye");
    await b.until(() => !b.awareness.getStates().has(a.doc.clientID));
  });
});

describe("DocRoom sockets", () => {
  it("caps edit sockets per room and sockets per actor", async () => {
    const stub = roomStub();
    const open: Client[] = [];
    for (let i = 0; i < MAX_EDIT_SOCKETS; i++)
      open.push(await connect(stub, { actor: `u:e${i}` }));
    const res = await stub.fetch("https://room/ws", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: "u:extra",
        [DOC_ROLE_HEADER]: "edit",
        [AUTHZ_AT_HEADER]: String(Date.now()),
      },
    });
    // A full room joins read-only (room_full), not refused.
    expect(res.status).toBe(101);
    const extra = res.webSocket as WebSocket;
    const first = new Promise<string>((r) =>
      extra.addEventListener("message", (e) => r(String(e.data))),
    );
    extra.accept();
    expect(JSON.parse(await first)).toMatchObject({
      type: "hello",
      role: "read",
      reason: "room_full",
    });
    extra.close();
    // Readers have their own pool.
    await connect(stub, { role: "read", actor: "u:reader" });
    const stub2 = roomStub();
    for (let i = 0; i < MAX_SOCKETS_PER_ACTOR; i++)
      await connect(stub2, { role: "read", actor: "u:same" });
    const over = await stub2.fetch("https://room/ws", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: "u:same",
        [DOC_ROLE_HEADER]: "read",
        [AUTHZ_AT_HEADER]: String(Date.now()),
      },
    });
    expect(over.status).toBe(429);
  });

  it("refuses a socket authorized before the last access change", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    await inRoom(stub, (r) => r.closeSockets("revoked"));
    await a.closed;
    const res = await stub.fetch("https://room/ws", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: "u:late",
        [DOC_ROLE_HEADER]: "edit",
        [AUTHZ_AT_HEADER]: "1000",
      },
    });
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const code = await new Promise<number>((r) =>
      ws.addEventListener("close", (e) => r(e.code)),
    );
    expect(code).toBe(4403);
    // Authorized after the change (plus skew): served.
    await connect(stub, { authzAt: Date.now() + 60_000 });
  });
});

const awFrame = (entries: [number, number, string][]) => {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(inner, id);
    encoding.writeVarUint(inner, clock);
    encoding.writeVarString(inner, state);
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
  return encoding.toUint8Array(enc);
};

const syncFrame = (sub: number, data: Uint8Array) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  encoding.writeVarUint(enc, sub);
  encoding.writeVarUint8Array(enc, data);
  return encoding.toUint8Array(enc);
};

/** A real text-insert update (its last byte is the empty delete set). */
const textUpdate = (s: string) => {
  const d = new Y.Doc();
  let u: Uint8Array = new Uint8Array();
  d.on("update", (x: Uint8Array) => {
    u = x;
  });
  d.getText("t").insert(0, s);
  return u;
};

describe("DocRoom hostile input", () => {
  const good = textUpdate("abc");
  const bad: [string, Uint8Array][] = [
    ["truncated update", syncFrame(2, good.slice(0, -1))],
    [
      "garbage delete set",
      syncFrame(2, new Uint8Array([...good.slice(0, -1), 1, 0xff, 0xff, 0xff])),
    ],
    [
      "bad varint length",
      new Uint8Array([0, 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2]),
    ],
    ["unknown message type", new Uint8Array([9, 1, 2, 3])],
    ["unknown sync message", new Uint8Array([0, 7, 0])],
  ];

  it.each(bad)(
    "%s: refused, socket closed, room keeps saving and compacting",
    async (_n, frame) => {
      const stub = roomStub();
      const culprit = await connect(stub);
      const peer = await connect(stub);
      culprit.ws.send(frame);
      await culprit.closed;
      await peer.ping();
      expect(textOf(peer)).toBe("");
      expect(await inRoom(stub, (r) => r.size())).toBe(0);
      type(peer, "ok");
      await peer.ping();
      await runDurableObjectAlarm(stub);
      expect(await rows(stub)).toBe(1);
      await inRoom(stub, (r) => r.compact());
      expect(await snapRows(stub)).toBe(1);
      const j = await connect(stub);
      await j.until(() => textOf(j) === "ok");
    },
  );

  it("flush and compact skip a bad update instead of wedging", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "ok");
    await a.ping();
    await runDurableObjectAlarm(stub);
    await inRoom(stub, (r) => {
      const x = r as unknown as {
        sql: SqlStorage;
        buffer: Uint8Array[];
        bufferBytes: number;
      };
      x.sql.exec(
        "INSERT INTO updates (data, at) VALUES (?, 1)",
        good.slice(0, -1),
      );
      // Two entries, so the flush merges (and the merge throws).
      x.buffer.push(textUpdate("zz"), good.slice(0, -1));
      x.bufferBytes += good.length + 8;
    });
    await inRoom(stub, (r) => r.flush());
    await inRoom(stub, (r) => r.compact());
    expect(await rows(stub)).toBe(0);
    expect(await inRoom(stub, (r) => r.size())).toBeGreaterThan(0);
    const j = await connect(stub);
    await j.until(() => textOf(j).includes("ok") && textOf(j).includes("zz"));
  });

  it("a gap does not advance the state vector for a client", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const victim = new Y.Doc();
    victim.clientID = 777;
    const ups: Uint8Array[] = [];
    victim.on("update", (u: Uint8Array) => ups.push(u));
    for (let i = 0; i < 5; i++) victim.getText("t").insert(i, "v");
    // Only the last update: structs at clock 4, nothing before.
    a.ws.send(syncFrame(2, ups[4] as Uint8Array));
    await a.ping();
    const j1 = await connect(stub);
    expect(Y.decodeStateVector(j1.serverSvs[0] as Uint8Array).get(777)).toBe(
      undefined,
    );
    // The contiguous prefix then the rest advance it.
    for (let i = 0; i < 4; i++) a.ws.send(syncFrame(2, ups[i] as Uint8Array));
    await a.ping();
    const j2 = await connect(stub);
    expect(Y.decodeStateVector(j2.serverSvs[0] as Uint8Array).get(777)).toBe(4);
    // Compaction recomputes it from the doc: all five.
    await inRoom(stub, (r) => r.compact());
    const j3 = await connect(stub);
    expect(Y.decodeStateVector(j3.serverSvs[0] as Uint8Array).get(777)).toBe(5);
  });
});

describe("DocRoom awareness hardening", () => {
  it("a socket cannot set or remove another socket's client id", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    const c = await connect(stub);
    const seen: number[] = [];
    c.awareness.on("update", (u: { added: number[]; updated: number[] }) =>
      seen.push(...u.added, ...u.updated),
    );
    a.ws.send(awFrame([[111, 1, '{"n":"a"}']]));
    await c.until(() => seen.includes(111));
    seen.length = 0;
    b.ws.send(awFrame([[111, 99, '{"n":"evil"}']]));
    b.ws.send(awFrame([[111, 100, "null"]]));
    b.ws.send(awFrame([[222, 1, '{"n":"b"}']]));
    await c.until(() => seen.includes(222));
    expect(seen).toEqual([222]);
    expect(c.awareness.getStates().get(111)).toEqual({ n: "a" });
  });

  it("drops a non-JSON or non-object state without closing the socket", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    a.ws.send(awFrame([[5, 1, "not json"]]));
    a.ws.send(awFrame([[6, 1, "[1,2]"]]));
    a.ws.send(awFrame([[7, 1, '{"ok":1}']]));
    await b.until(() => b.awareness.getStates().has(7));
    expect(b.awareness.getStates().has(5)).toBe(false);
    expect(b.awareness.getStates().has(6)).toBe(false);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("relays only the owned entries of a 12-entry frame with foreign ids", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    const c = await connect(stub);
    const seen: number[] = [];
    c.awareness.on("update", (u: { added: number[]; updated: number[] }) =>
      seen.push(...u.added, ...u.updated),
    );
    b.ws.send(awFrame([[500, 1, '{"b":1}']]));
    await c.until(() => seen.includes(500));
    seen.length = 0;
    // a re-sends b's state (a foreign id) among its own and bogus entries.
    const entries: [number, number, string][] = [
      [500, 9, '{"stolen":1}'],
      [501, 1, '{"a":1}'],
      [502, 1, '{"a":2}'],
    ];
    for (let i = 0; i < 8; i++) entries.push([600 + i, 1, "nope"]);
    entries.push([503, 1, '{"a":3}']);
    expect(entries.length).toBe(12);
    a.ws.send(awFrame(entries));
    await c.until(() => seen.length >= 3);
    expect(seen.sort()).toEqual([501, 502, 503]);
    expect(c.awareness.getStates().get(500)).toEqual({ b: 1 });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("charges the limiter before any parsing or ownership scan", async () => {
    const stub = roomStub();
    await inRoom(stub, (r) => {
      const x = r as unknown as {
        now: () => number;
        ownedElsewhere: (ws: WebSocket, id: number) => boolean;
      };
      x.now = () => 7_000;
      const real = x.ownedElsewhere.bind(r);
      (globalThis as { __scans?: number }).__scans = 0;
      x.ownedElsewhere = (ws, id) => {
        (globalThis as { __scans?: number }).__scans =
          ((globalThis as { __scans?: number }).__scans ?? 0) + 1;
        return real(ws, id);
      };
    });
    const a = await connect(stub);
    const b = await connect(stub);
    b.ws.send(awFrame([[800, 1, '{"b":1}']]));
    await b.ping();
    await inRoom(stub, () => {
      (globalThis as { __scans?: number }).__scans = 0;
    });
    for (let i = 0; i < 30; i++) a.ws.send(awFrame([[800, 2 + i, '{"x":1}']]));
    await a.ping();
    const scans = await inRoom(
      stub,
      () => (globalThis as { __scans?: number }).__scans,
    );
    expect(scans).toBeLessThanOrEqual(10);
  });

  it("drops awareness past the per-second rate", async () => {
    const stub = roomStub();
    await inRoom(stub, (r) => {
      (r as unknown as { now: () => number }).now = () => 5_000;
    });
    const a = await connect(stub);
    const b = await connect(stub);
    let got = 0;
    b.awareness.on("update", () => got++);
    for (let i = 1; i <= 15; i++) a.ws.send(awFrame([[9, i, '{"i":1}']]));
    await a.ping();
    await b.ping();
    expect(got).toBe(10);
  });

  it("drops an oversized awareness frame", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    a.ws.send(awFrame([[3, 1, JSON.stringify({ x: "y".repeat(9000) })]]));
    await a.ping();
    await b.ping();
    expect(b.awareness.getStates().has(3)).toBe(false);
  });
});

describe("DocRoom review fixes (#2154)", () => {
  const authorUpdates = (client: number, n: number) => {
    const d = new Y.Doc();
    d.clientID = client;
    const ups: Uint8Array[] = [];
    d.on("update", (u: Uint8Array) => ups.push(u));
    for (let i = 0; i < n; i++) d.getText("t").insert(i, "v");
    return ups;
  };
  it("closes a malformed step 1 and a padded frame", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    a.ws.send(new Uint8Array([0, 0]));
    await a.closed;
    const b = await connect(stub);
    const ups = authorUpdates(31, 1);
    const padded = new Uint8Array([
      ...syncFrame(2, ups[0] as Uint8Array),
      ...new Uint8Array(64),
    ]);
    b.ws.send(padded);
    await b.closed;
    expect(await inRoom(stub, (r) => r.size())).toBe(0);
  });

  it("closes a frame past the size bound", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    a.ws.send(new Uint8Array(DOC_MAX_BYTES + 1024));
    await a.closed;
  });

  it("a Skip in a merged update never advances the state vector past the hole", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const ups = authorUpdates(41, 3);
    const merged = Y.mergeUpdates([ups[0] as Uint8Array, ups[2] as Uint8Array]);
    a.ws.send(syncFrame(2, merged));
    await a.ping();
    const j = await connect(stub);
    expect(Y.decodeStateVector(j.serverSvs[0] as Uint8Array).get(41)).toBe(1);
  });

  it("keeps the batch when the SQL write fails and stores it on a later flush", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "keep");
    await a.ping();
    await inRoom(stub, (r) => {
      const x = r as unknown as { sql: SqlStorage };
      const real = x.sql;
      (globalThis as { __fail?: boolean }).__fail = true;
      x.sql = {
        exec: (q: string, ...args: unknown[]) => {
          if (
            (globalThis as { __fail?: boolean }).__fail &&
            /INSERT INTO updates/.test(q)
          )
            throw new Error("boom");
          return real.exec(q, ...args);
        },
      } as unknown as SqlStorage;
      (x as unknown as { realSql: SqlStorage }).realSql = real;
    });
    await runDurableObjectAlarm(stub).catch(() => {});
    expect(await rows(stub)).toBe(0);
    expect(await inRoom(stub, (r) => r.size())).toBeGreaterThan(0);
    const sv = await inRoom(stub, (r) => {
      const x = r as unknown as { realSql: SqlStorage };
      return x.realSql
        .exec<{ n: number }>("SELECT count(*) AS n FROM meta WHERE k = 'sv'")
        .one().n;
    });
    expect(sv).toBe(0);
    expect(
      await runInDurableObject(stub, (_r, st) => st.storage.getAlarm()),
    ).not.toBeNull();
    await inRoom(stub, () => {
      (globalThis as { __fail?: boolean }).__fail = false;
    });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(1);
    const j = await connect(stub);
    await j.until(() => textOf(j) === "keep");
  });

  it("an over-cap write does not pull the alarm earlier", async () => {
    const stub = roomStub();
    const t0 = Date.now() + 600_000;
    await inRoom(stub, (r) => {
      (r as unknown as { now: () => number }).now = () => t0;
    });
    const a = await connect(stub);
    type(a, "x");
    await a.ping();
    const before = await runInDurableObject(stub, (_r, st) =>
      st.storage.getAlarm(),
    );
    await inRoom(stub, (r) => {
      (r as unknown as { bufferBytes: number }).bufferBytes = DOC_MAX_BYTES;
    });
    a.doc.getText("t").insert(0, "y");
    await a.until(() => a.texts.some((t) => t.includes("doc_too_large")));
    const after = await runInDurableObject(stub, (_r, st) =>
      st.storage.getAlarm(),
    );
    expect(before).toBe(t0 + 1000);
    expect(after).toBe(before);
  });

  it("tracks and relays at most 8 new ids from one frame", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    const seen: number[] = [];
    b.awareness.on("update", (u: { added: number[] }) => seen.push(...u.added));
    const entries: [number, number, string][] = [];
    for (let i = 0; i < 9; i++) entries.push([900 + i, 1, '{"a":1}']);
    a.ws.send(awFrame(entries));
    await b.until(() => seen.length >= 8);
    await a.ping();
    await b.ping();
    expect(seen.sort()).toEqual([900, 901, 902, 903, 904, 905, 906, 907]);
  });

  it("a frame removing one id twice removes only that id", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    const b = await connect(stub);
    a.ws.send(
      awFrame([
        [950, 1, '{"a":1}'],
        [951, 1, '{"a":2}'],
      ]),
    );
    await b.until(() => b.awareness.getStates().has(951));
    a.ws.send(
      awFrame([
        [950, 2, "null"],
        [950, 3, "null"],
      ]),
    );
    await b.until(() => !b.awareness.getStates().has(950));
    a.ws.close();
    await b.until(() => !b.awareness.getStates().has(951));
  });
});

describe("DocRoom per-actor budget and authorization time (#2154)", () => {
  const rawOpen = async (stub: Stub, actor: string) => {
    const res = await stub.fetch("https://room/ws", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: actor,
        [DOC_ROLE_HEADER]: "read",
        [AUTHZ_AT_HEADER]: String(Date.now()),
      },
    });
    if (res.status !== 101) return { status: res.status, opened: false };
    const ws = res.webSocket as WebSocket;
    ws.accept();
    return { status: 101, opened: true };
  };

  it("budgets full-state work per actor across reconnects, refills, spares others", async () => {
    const stub = roomStub();
    let t = 5_000_000;
    await inRoom(stub, (r) => {
      (r as unknown as { now: () => number }).now = () => t;
    });
    const actor = "u:budget";
    for (let i = 0; i < 3; i++) {
      const c = await connect(stub, { actor, strict: true, role: "read" });
      c.ws.close();
    }
    expect((await rawOpen(stub, actor)).status).toBe(429);
    expect((await rawOpen(stub, "u:someone-else")).opened).toBe(true);
    t += 61_000;
    expect((await rawOpen(stub, actor)).opened).toBe(true);
  });

  const rawOpenAs = async (
    stub: Stub,
    actor: string,
    role: "read" | "edit" = "read",
  ) =>
    stub.fetch("https://room/ws", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: actor,
        [DOC_ROLE_HEADER]: role,
        [AUTHZ_AT_HEADER]: String(Date.now()),
      },
    });

  it("one token left refuses the upgrade with 429 (no half-admission)", async () => {
    const stub = roomStub();
    await inRoom(stub, (r) => {
      r.budgetCap = 1; // fewer than the two an admission reserves
      (r as unknown as { now: () => number }).now = () => 9_000_000;
    });
    const res = await rawOpenAs(stub, "u:starved");
    expect(res.status).toBe(429);
    expect(res.webSocket).toBeNull();
    expect(
      await inRoom(
        stub,
        (r) =>
          (r as unknown as { ctx: DurableObjectState }).ctx.getWebSockets()
            .length,
      ),
    ).toBe(0);
  });

  it("an admitted socket's first sync reply survives other sockets draining the bucket", async () => {
    const stub = roomStub();
    const w = await connect(stub);
    type(w, "stored");
    await w.ping();
    await runDurableObjectAlarm(stub);
    await inRoom(stub, (r) => {
      r.budgetCap = 2; // exactly one admission
      (r as unknown as { now: () => number }).now = () => 9_000_000;
    });
    const res = await rawOpenAs(stub, "u:reserved");
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    // Another socket of the same actor is refused: the bucket is empty.
    expect((await rawOpenAs(stub, "u:reserved")).status).toBe(429);
    const doc = new Y.Doc();
    const subs: number[] = [];
    let code = 0;
    ws.addEventListener("close", (e) => {
      code = e.code;
    });
    const got = new Promise<void>((resolve) =>
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") return;
        const dec = decoding.createDecoder(
          new Uint8Array(e.data as ArrayBuffer),
        );
        if (decoding.readVarUint(dec) !== 0) return;
        subs.push(decoding.peekVarUint(dec));
        syncProtocol.readSyncMessage(dec, encoding.createEncoder(), doc, "r");
        if (subs.includes(1)) resolve();
      }),
    );
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    ws.send(encoding.toUint8Array(enc));
    await got;
    expect(code).toBe(0);
    expect(doc.getText("t").toString()).not.toBe("");
  });

  it("one anonymous IP exhausting its budget does not block another IP", async () => {
    const stub = roomStub();
    await inRoom(stub, (r) => {
      (r as unknown as { now: () => number }).now = () => 9_200_000;
    });
    // Per-IP cap 6 = three admissions; the shared anonymous cap (10) is not hit.
    for (let i = 0; i < 3; i++)
      expect((await rawOpenAs(stub, "ip:203.0.113.7")).status).toBe(101);
    expect((await rawOpenAs(stub, "ip:203.0.113.7")).status).toBe(429);
    // A verified anonId suffix is the same IP.
    expect((await rawOpenAs(stub, "ip:203.0.113.7|abcdefgh")).status).toBe(429);
    expect((await rawOpenAs(stub, "ip:198.51.100.9")).status).toBe(101);
  });

  it("surplus step 1s on a synced socket are ignored", async () => {
    const stub = roomStub();
    await inRoom(stub, (r) => {
      (r as unknown as { now: () => number }).now = () => 9_100_000;
    });
    const a = await connect(stub, { strict: true, role: "read" });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    const frame = encoding.toUint8Array(enc);
    for (let i = 0; i < 8; i++) a.ws.send(frame);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(a.texts).toEqual([]);
  });

  it("retries a failed compaction on the next alarm", async () => {
    const stub = roomStub();
    const a = await connect(stub);
    type(a, "compact me");
    await a.ping();
    await runDurableObjectAlarm(stub);
    expect(await rows(stub)).toBe(1);
    await inRoom(stub, async (r) => {
      const x = r as unknown as { sql: SqlStorage; squeeze: boolean };
      const real = x.sql;
      (globalThis as { __cfail?: boolean }).__cfail = true;
      x.sql = {
        exec: (q: string, ...args: unknown[]) => {
          if (
            (globalThis as { __cfail?: boolean }).__cfail &&
            /INSERT OR REPLACE INTO snapshot/.test(q)
          )
            throw new Error("boom");
          return real.exec(q, ...args);
        },
      } as unknown as SqlStorage;
      x.squeeze = true;
    });
    await runInDurableObject(stub, (_r, st) =>
      st.storage.setAlarm(Date.now() + 60_000),
    );
    await runDurableObjectAlarm(stub);
    expect(await snapRows(stub)).toBe(0);
    expect(
      await runInDurableObject(stub, (_r, st) => st.storage.getAlarm()),
    ).not.toBeNull();
    await inRoom(stub, () => {
      (globalThis as { __cfail?: boolean }).__cfail = false;
    });
    await runDurableObjectAlarm(stub);
    expect(await snapRows(stub)).toBe(1);
  });

  it("refuses ip: and agent: actors without a trusted authorization time", async () => {
    const stub = roomStub();
    for (const actor of ["ip:1.2.3.4", "agent:bot-1"]) {
      const res = await stub.fetch("https://room/ws", {
        headers: {
          Upgrade: "websocket",
          [ACTOR_HEADER]: actor,
          [DOC_ROLE_HEADER]: "read",
        },
      });
      expect(res.status).toBe(400);
    }
  });
});
