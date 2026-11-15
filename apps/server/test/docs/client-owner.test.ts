// The room binds each Yjs clientID to the actor that first used it (#2177).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { docFragment, docToYXmlFragment, markdownToDoc } from "@oa/doc-schema";
import { type Member, newId, R } from "@oa/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import {
  AUTOSAVE_IDLE_MS,
  DOC_MAX_BYTES,
  DOC_ROLE_HEADER,
  type DocRoom,
} from "../../src/docs/room.js";
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../../src/runtime/do.js";
import {
  restoreDocVersion,
  saveDocVersion,
} from "../../src/services/doc-edit.js";
import { DOC_SWITCH } from "../../src/services/doc-switch.js";
import { putShare } from "../../src/services/shares.js";
import { getUser } from "../../src/services/users.js";
import { api, errOf, login } from "../helpers.js";
import { E, connect as mcpConnect, textOf, tool } from "../mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string; member: Member };
let viewer: { cookie: string; userId: string; member: Member; email: string };
let ownerPat: string;
let viewerPat: string;
let ownerPatId: string;
DOC_SWITCH.creation = true;
const savedPlan = (env as { PLAN?: string }).PLAN;
beforeAll(async () => {
  (env as { PLAN?: string }).PLAN = "paid";
  const o = await login(`ed-o-${tag}@x.com`);
  const v = await login(`ed-v-${tag}@x.com`);
  const om = await getUser(env, o.userId);
  const vm = await getUser(env, v.userId);
  if (!om || !vm) throw new Error("no user");
  owner = { ...o, member: om };
  viewer = { ...v, member: vm, email: `ed-v-${tag}@x.com` };
  const p = await createPat(env, owner.userId, "Edit Bot");
  ownerPat = p.token;
  ownerPatId = p.id;
  viewerPat = (await createPat(env, viewer.userId, "View Bot")).token;
});
afterAll(() => {
  (env as { PLAN?: string }).PLAN = savedPlan;
  DOC_SWITCH.creation = false;
});

const T0 = 1_800_000_000_000;

/** A fresh doc artifact, shared with the viewer, and its room (fake clock). */
async function fresh(content = "# Plan\n\nShip it on Friday.\n") {
  const r = await api(app, R.artifacts, owner.cookie, {
    method: "POST",
    body: { title: "Notes", format: "doc", content },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  await putShare(env, owner.member, id, {
    email: viewer.email,
    role: "viewer",
  });
  const ns = env.DOC_ROOM;
  if (!ns) throw new Error("DOC_ROOM unbound");
  const stub = ns.get(ns.idFromName(id));
  const clock = { t: T0 };
  await runInDurableObject(stub, (r: DocRoom) => {
    const x = r as unknown as { now: () => number };
    x.now = () => clock.t;
    r.budgetCap = 1_000_000;
  });
  return { id, stub, clock };
}
type Room = Awaited<ReturnType<typeof fresh>>;

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  frames: { type: string; [k: string]: unknown }[];
  until: (pred: () => boolean) => Promise<void>;
  ping: () => Promise<void>;
  closed: Promise<void>;
}

async function connect(
  room: Room,
  o: { actor?: string; role?: "edit" | "read"; name?: string } = {},
): Promise<Client> {
  const res = await room.stub.fetch("https://room/ws", {
    headers: {
      Upgrade: "websocket",
      [ACTOR_HEADER]: o.actor ?? `u:${owner.userId}`,
      [DOC_ROLE_HEADER]: o.role ?? "edit",
      [AUTHZ_AT_HEADER]: String(Date.now()),
      ...(o.name ? { "X-OA-Doc-Name": o.name } : {}),
    },
  });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const doc = new Y.Doc();
  const frames: Client["frames"] = [];
  const checks = new Set<() => void>();
  let pongs = 0;
  let step1 = 0;
  const closed = new Promise<void>((r) =>
    ws.addEventListener("close", () => r()),
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") frames.push(JSON.parse(e.data));
    else {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      if (decoding.readVarUint(dec) === 0) {
        const sub = decoding.peekVarUint(dec);
        if (sub === 0) step1++;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, "remote");
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === 1) pongs++;
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
  const c = { ws, doc, frames, until, ping, closed };
  await c.until(() => step1 > 0);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
  await c.until(() => pongs >= 1);
  return c;
}

const mdOf = (c: Client) =>
  docFragment(c.doc)
    .toArray()
    .map((n) => n.toString())
    .join("");
const write = (c: Client, md: string) =>
  c.doc.transact(() => {
    const f = docFragment(c.doc);
    f.delete(0, f.length);
    docToYXmlFragment(markdownToDoc(md).doc, f);
  });
const inRoom = <T>(room: Room, f: (r: DocRoom) => T | Promise<T>) =>
  runInDurableObject(room.stub, (r: DocRoom) => f(r));
const versions = async (id: string) =>
  (
    await env.DB.prepare(
      "select version, message from versions where artifact_id = ? order by version",
    )
      .bind(id)
      .all<{ version: number; message: string | null }>()
  ).results;

/** A raw update frame: one struct run for `client` at `clock`: a GC of `len` clocks. */
function gcUpdate(client: number, clock: number, len: number) {
  const u = encoding.createEncoder();
  encoding.writeVarUint(u, 1); // one client
  encoding.writeVarUint(u, 1); // one struct
  encoding.writeVarUint(u, client);
  encoding.writeVarUint(u, clock);
  encoding.writeUint8(u, 0); // GC
  encoding.writeVarUint(u, len);
  encoding.writeVarUint(u, 0); // empty delete set
  const f = encoding.createEncoder();
  encoding.writeVarUint(f, 0);
  encoding.writeVarUint(f, 2);
  encoding.writeVarUint8Array(f, encoding.toUint8Array(u));
  return encoding.toUint8Array(f);
}
const clockOf = (c: Client) => Y.getState(c.doc.store, c.doc.clientID);
const BOB = "u:bob-actor";

describe("clientID ownership (#2177)", () => {
  it("refuses a forged update for another actor's clientID; the victim's later edits survive", async () => {
    const room = await fresh();
    const a = await connect(room);
    const b = await connect(room, { actor: BOB });
    write(a, "# Plan\n\nAlice typed this.\n");
    await a.ping();
    await b.until(() => mdOf(b).includes("Alice typed"));
    b.ws.send(gcUpdate(a.doc.clientID, clockOf(a), 50));
    await b.closed;
    expect(b.frames.some((f) => f.code === "bad_update")).toBe(true);
    // The victim keeps editing: nothing was discarded.
    write(a, "# Plan\n\nAlice typed this, and more.\n");
    await a.ping();
    expect(await inRoom(room, (x) => x.markdown())).toContain("and more");
    expect(await inRoom(room, (x) => x.markdown())).toContain("Alice typed");
    a.ws.close();
  });

  it("refuses a huge GC length, even for a new clientID", async () => {
    const room = await fresh();
    const b = await connect(room, { actor: BOB });
    b.ws.send(gcUpdate(123456789, 0, 1_000_000_000));
    await b.closed;
    const b2 = await connect(room, { actor: BOB });
    b2.ws.send(gcUpdate(123456790, 0, 900_000)); // under 1e6, far over 64x its bytes
    await b2.closed;
    const n = await inRoom(room, (x) => x.size());
    expect(n).toBeGreaterThan(0);
    expect(await inRoom(room, (x) => x.markdown())).toContain("Friday");
  });

  it("ownership survives a room reload", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nAlice typed this.\n");
    await a.ping();
    const id = a.doc.clientID;
    const row = await inRoom(room, (x) =>
      (x as unknown as { sql: SqlStorage }).sql
        .exec<{ actor: string }>(
          "SELECT actor FROM clients WHERE client = ?",
          id,
        )
        .toArray(),
    );
    expect(row).toEqual([{ actor: `u:${owner.userId}` }]);
    // A cold room: the in-memory map is gone, the table is not.
    await inRoom(room, (x) => {
      (x as unknown as { clientOwners: unknown }).clientOwners = null;
    });
    const b = await connect(room, { actor: BOB });
    b.ws.send(gcUpdate(id, clockOf(a), 5));
    await b.closed;
    a.ws.close();
  });

  it("two people editing normally are unaffected", async () => {
    const room = await fresh();
    const a = await connect(room);
    const b = await connect(room, { actor: BOB });
    write(a, "# Plan\n\nFrom Alice.\n");
    await a.ping();
    await b.until(() => mdOf(b).includes("From Alice"));
    write(b, "# Plan\n\nFrom Alice.\n\nFrom Bob.\n");
    await b.ping();
    await a.until(() => mdOf(a).includes("From Bob"));
    expect(b.ws.readyState).toBe(1);
    expect(a.ws.readyState).toBe(1);
    // A second socket of the same actor (a reconnect) keeps its clientID.
    const a2 = await connect(room);
    a2.ws.send(gcUpdate(a.doc.clientID, clockOf(a), 1));
    await a2.ping();
    a.ws.close();
    b.ws.close();
    a2.ws.close();
  });

  it("edit_doc and restore write under the server's clientID", async () => {
    const room = await fresh();
    const a = await connect(room);
    const r = await api(app, R.docOps(room.id), ownerPat, {
      method: "POST",
      body: { ops: [{ op: "replace", quote: "Friday", with: "Monday" }] },
    });
    expect(r.status).toBe(200);
    await a.until(() => mdOf(a).includes("Monday"));
    const owners = await inRoom(room, (x) =>
      (x as unknown as { sql: SqlStorage }).sql
        .exec<{ client: number; actor: string }>(
          "SELECT client, actor FROM clients",
        )
        .toArray(),
    );
    const server = owners.filter((o) => o.actor === "server");
    expect(server).toHaveLength(1);
    // The person cannot forge the server's clientID.
    const c = (server[0] as { client: number }).client;
    const b = await connect(room, { actor: BOB });
    b.ws.send(gcUpdate(c, 1_000, 5));
    await b.closed;
    // Restore also goes through it: still exactly one server clientID.
    const rr = await api(app, R.docRestore(room.id, 1), owner.cookie, {
      method: "POST",
      body: {},
    });
    expect(rr.status).toBe(201);
    const after = await inRoom(room, (x) =>
      (x as unknown as { sql: SqlStorage }).sql
        .exec<{ n: number }>(
          "SELECT count(*) n FROM clients WHERE actor = 'server'",
        )
        .one(),
    );
    expect(after.n).toBe(1);
    a.ws.close();
  });
});
