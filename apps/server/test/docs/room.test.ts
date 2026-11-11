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
  /** Server state vectors seen in sync step 1. */
  serverSvs: Uint8Array[];
  /** Resolves when `pred` holds (checked on every frame). */
  until: (pred: () => boolean) => Promise<void>;
  /** A step 1 round trip: all earlier frames of this socket are processed. */
  ping: () => Promise<void>;
  closed: Promise<void>;
}

async function connect(
  stub: Stub,
  o: {
    role?: "edit" | "read";
    actor?: string;
    authzAt?: number;
  } = {},
): Promise<Client> {
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
  const serverSvs: Uint8Array[] = [];
  const checks = new Set<() => void>();
  let pongs = 0;
  const closed = new Promise<void>((r) =>
    ws.addEventListener("close", () => r()),
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      texts.push(e.data);
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
    const a = await connect(stub);
    for (let i = 0; i <= COMPACT_ROWS; i++) {
      a.doc.getText("t").insert(0, "k");
      await a.ping();
      await inRoom(stub, (r) => r.flush());
      if (i < COMPACT_ROWS) expect(await snapRows(stub)).toBe(0);
    }
    expect(await rows(stub)).toBe(0);
    expect(await snapRows(stub)).toBe(1);
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
    expect(res.status).toBe(429);
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
