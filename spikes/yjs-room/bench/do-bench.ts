/**
 * The room in workerd (Miniflare, local only, nothing deployed): cold wake,
 * 20 editors over WebSockets, compaction and agent edit_doc, timed inside the
 * Durable Object (performance.now advances locally) and from outside.
 *
 *   node --experimental-strip-types bench/do-bench.ts
 *
 * Prints one JSON object; RESULTS.md quotes it.
 */
import { join } from "node:path";
import { build } from "esbuild";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Miniflare } from "miniflare";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { blocks, blockText } from "../src/doc-model.ts";
import { decodeSeed, EDITORS, type Profile, seedBody } from "./fixture.ts";
import { agentOps, quotes } from "./quotes.ts";

const ROOT = join(import.meta.dirname, "..");
const TAIL = 2000;
const REPS = 5;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ] ?? Number.NaN;
const r2 = (x: number) => Math.round(x * 100) / 100;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const bundle = await build({
  entryPoints: [join(ROOT, "src/room.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  external: ["cloudflare:workers"],
  write: false,
  minify: true,
});
const code = bundle.outputFiles[0]?.text ?? "";

function start(flushMs: number) {
  return new Miniflare({
    modules: [{ type: "ESModule", path: "room.js", contents: code }],
    compatibilityDate: "2026-01-01",
    durableObjects: { ROOM: { className: "YRoom", useSQLite: true } },
    bindings: { FLUSH_MS: String(flushMs), COMPACT_ROWS: "1000000" },
  });
}

type Mf = ReturnType<typeof start>;
const base = "http://room.local/room";

async function call(
  mf: Mf,
  room: string,
  op: string,
  body?: string | Uint8Array<ArrayBuffer>,
) {
  const t = performance.now();
  const res = await mf.dispatchFetch(`${base}/${room}/${op}`, {
    method: body ? "POST" : "GET",
    body,
  });
  const json = (await res.json()) as Record<string, number>;
  return { json, wall: performance.now() - t, status: res.status };
}

async function evict(mf: Mf, room: string) {
  try {
    const res = await mf.dispatchFetch(`${base}/${room}/evict`);
    await res.arrayBuffer();
  } catch {
    // abort() fails the request by design
  }
}

async function seed(mf: Mf, room: string, body: Uint8Array) {
  await call(mf, room, "seed", body.slice());
  await evict(mf, room);
}

/** Cold wake: constructor + load of snapshot and TAIL update rows. */
async function coldWake(mf: Mf, room: string) {
  const load: number[] = [];
  const sql: number[] = [];
  const wall: number[] = [];
  for (let i = 0; i < REPS; i++) {
    await evict(mf, room);
    const { json, wall: w } = await call(mf, room, "stats");
    load.push(json.loadMs ?? Number.NaN);
    sql.push(json.loadSqlMs ?? Number.NaN);
    wall.push(w);
  }
  const warm = await call(mf, room, "stats");
  return {
    loadMs: r2(median(load)),
    loadSqlMs: r2(median(sql)),
    wallMs: r2(median(wall)),
    warmStatsWallMs: r2(warm.wall),
    stateBytes: warm.json.stateBytes,
    sqlBytes: warm.json.sqlBytes,
  };
}

class Client {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  readonly synced: Promise<void>;
  received = 0;
  awClock = 0;
  onUpdate: (u: Uint8Array) => void = () => {};

  constructor(ws: WebSocket, id: number) {
    this.ws = ws;
    this.doc.clientID = 5000 + id;
    let done: () => void = () => {};
    this.synced = new Promise((ok) => {
      done = ok;
    });
    ws.addEventListener("message", (ev) => {
      const msg = new Uint8Array(ev.data as ArrayBuffer);
      const dec = decoding.createDecoder(msg);
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const sub = decoding.peekVarUint(dec);
      const upd =
        sub === syncProtocol.messageYjsUpdate
          ? (() => {
              const d2 = decoding.createDecoder(msg);
              decoding.readVarUint(d2);
              decoding.readVarUint(d2);
              return decoding.readVarUint8Array(d2);
            })()
          : null;
      syncProtocol.readSyncMessage(dec, enc, this.doc, "server");
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (sub === syncProtocol.messageYjsSyncStep2) done();
      if (upd) {
        this.received++;
        this.onUpdate(upd);
      }
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "server") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      ws.send(encoding.toUint8Array(enc));
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, this.doc);
    ws.send(encoding.toUint8Array(enc));
  }

  awareness(cursor: number) {
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, 1);
    encoding.writeVarUint(inner, this.doc.clientID);
    encoding.writeVarUint(inner, ++this.awClock);
    encoding.writeVarString(
      inner,
      JSON.stringify({
        user: { name: `Editor ${this.doc.clientID}`, color: "#1f5fbf" },
        cursor: { anchor: cursor, head: cursor },
      }),
    );
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
    this.ws.send(encoding.toUint8Array(enc));
  }

  /** One keystroke in block `b` (one Yjs update, one message). */
  type(b: number) {
    const frag = blocks(this.doc);
    const el = frag.get(b % frag.length) as Y.XmlElement;
    const t = blockText(el);
    t.insert(Math.min(t.length, 5), "k");
  }
}

async function connect(mf: Mf, room: string, n: number) {
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) {
    const res = await mf.dispatchFetch(`${base}/${room}/ws`, {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`no websocket: ${res.status}`);
    ws.accept();
    clients.push(new Client(ws as unknown as WebSocket, i));
  }
  return clients;
}

const hex = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** 20 editors on one room: join, paced typing with latency, then a burst. */
async function editors(flushMs: number, profile: Profile, size: number) {
  const mf = start(flushMs);
  const room = `editors-${profile}-${size}`;
  await seed(mf, room, seedBody(size, TAIL, profile));
  const t0 = performance.now();
  const clients = await connect(mf, room, EDITORS);
  await Promise.all(clients.map((c) => c.synced));
  const joinAllMs = performance.now() - t0;
  clients.forEach((c, i) => {
    c.awareness(i);
  });
  // Let the harness drain the 20 full-state joins before timing typing.
  await sleep(3000);
  const afterJoin = (await call(mf, room, "stats")).json;

  // Paced: every editor types 5 keys/s for 6 s, cursor update every 5 keys.
  const sentAt = new Map<string, number>();
  const lat: number[] = [];
  const probe = clients[1];
  if (probe)
    probe.onUpdate = (u) => {
      const t = sentAt.get(hex(u));
      if (t !== undefined) lat.push(performance.now() - t);
    };
  const sender = clients[0];
  if (sender)
    sender.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "server") sentAt.set(hex(u), performance.now());
    });
  for (let tick = 0; tick < 30; tick++) {
    clients.forEach((c, i) => {
      c.type(i * 7 + tick);
      if (tick % 5 === 0) c.awareness(tick);
    });
    await sleep(200);
  }
  await sleep(500);
  const paced = (await call(mf, room, "stats")).json;

  // Burst: 100 keystrokes per editor as fast as the clients can send.
  const before = clients.map((c) => c.received);
  const burst = 100;
  const want = (EDITORS - 1) * burst;
  const tb = performance.now();
  for (let k = 0; k < burst; k++)
    clients.forEach((c, i) => {
      c.type(i * 13 + k);
    });
  for (;;) {
    if (clients.every((c, i) => c.received - (before[i] ?? 0) >= want)) break;
    if (performance.now() - tb > 60_000) break;
    await sleep(5);
  }
  const burstMs = performance.now() - tb;
  const end = (await call(mf, room, "stats")).json;
  const compact = await call(mf, room, "compact");
  for (const c of clients) c.ws.close();
  await mf.dispose();

  const per = (a: Record<string, number>, b: Record<string, number>) =>
    r2(
      ((b.msgMsTotal ?? 0) - (a.msgMsTotal ?? 0)) /
        Math.max(1, (b.msgs ?? 0) - (a.msgs ?? 0)),
    );
  return {
    flushMs,
    joinAllMs: r2(joinAllMs),
    joinMsgMaxMs: r2(afterJoin.msgMsMax ?? 0),
    joinMsgMeanMs: r2((afterJoin.msgMsTotal ?? 0) / (afterJoin.msgs ?? 1)),
    pacedMsgs: (paced.msgs ?? 0) - (afterJoin.msgs ?? 0),
    pacedMsgMeanMs: per(afterJoin, paced),
    pacedLatencyP50Ms: r2(pct(lat, 0.5)),
    pacedLatencyP99Ms: r2(pct(lat, 0.99)),
    pacedLatencySamples: lat.length,
    burstMsgs: (end.msgs ?? 0) - (paced.msgs ?? 0),
    burstMsgMeanMs: per(paced, end),
    burstWallMs: r2(burstMs),
    burstMsgsPerSec: Math.round((EDITORS * burst) / (burstMs / 1000)),
    msgMsMaxOverall: r2(end.msgMsMax ?? 0),
    rowsWritten: end.rowsWritten,
    updateRowsAtEnd: end.updateRows,
    compactMs: r2(compact.json.ms ?? 0),
    compactBytes: compact.json.bytes,
  };
}

async function editDocBench(profile: Profile, size: number) {
  const mf = start(0);
  const room = `edit-${profile}-${size}`;
  const body = seedBody(size, TAIL, profile);
  await seed(mf, room, body);
  const { snapshot, tail } = decodeSeed(body);
  const local = new Y.Doc();
  Y.applyUpdate(local, snapshot);
  for (const u of tail) Y.applyUpdate(local, u);
  const out: Record<string, number> = {};
  let seedN = 0;
  for (const n of [1, 10, 50]) {
    const warm: number[] = [];
    const warmWall: number[] = [];
    const coldWall: number[] = [];
    for (let i = 0; i < REPS; i++) {
      // Quotes from the seeded text; earlier edits touched other spots.
      const ops = agentOps(quotes(local, n, 24, 1000 + seedN++));
      const w = await call(mf, room, "edit", JSON.stringify(ops));
      if (w.status !== 200) continue;
      warm.push(w.json.ms ?? Number.NaN);
      warmWall.push(w.wall);
      await evict(mf, room);
      const ops2 = agentOps(quotes(local, n, 24, 5000 + seedN++));
      const c = await call(mf, room, "edit", JSON.stringify(ops2));
      if (c.status === 200) coldWall.push(c.wall);
    }
    out[`warm${n}OpsInDoMs`] = r2(median(warm));
    out[`warm${n}OpsWallMs`] = r2(median(warmWall));
    out[`cold${n}OpsWallMs`] = r2(median(coldWall));
  }
  const compact = await call(mf, room, "compact");
  out.compactMs = r2(compact.json.ms ?? 0);
  await mf.dispose();
  return out;
}

const results: Record<string, unknown> = {
  bundleBytes: code.length,
};

{
  const mf = start(0);
  const cold: Record<string, unknown> = {};
  for (const profile of ["heavy", "typing"] as Profile[])
    for (const size of [250_000, 500_000, 1_000_000, 2_000_000]) {
      const room = `cold-${profile}-${size}`;
      await seed(mf, room, seedBody(size, TAIL, profile));
      cold[`${profile} ${size / 1e6}MB`] = await coldWake(mf, room);
      // The same doc right after compaction (no update rows to replay).
      await call(mf, room, "compact");
      cold[`${profile} ${size / 1e6}MB compacted`] = await coldWake(mf, room);
      process.stderr.write(`cold ${profile} ${size}\n`);
    }
  // An empty room: the floor of a wake (constructor + SQL, no Yjs work).
  cold.empty = await coldWake(mf, "cold-empty");
  results.coldWake = cold;
  await mf.dispose();
}

results.editors = {
  "heavy 1MB, row per update": await editors(0, "heavy", 1_000_000),
  "heavy 1MB, flush 1000ms": await editors(1000, "heavy", 1_000_000),
  "typing 1MB, row per update": await editors(0, "typing", 1_000_000),
};
process.stderr.write("editors done\n");

results.editDoc = {
  "heavy 2MB": await editDocBench("heavy", 2_000_000),
  "typing 2MB": await editDocBench("typing", 2_000_000),
  "heavy 1MB": await editDocBench("heavy", 1_000_000),
};

console.log(JSON.stringify(results));
