/**
 * Pure-CPU costs of the room's Yjs work, on Node's V8 (the engine workerd
 * runs). No SQLite, no sockets: bench/do-bench.ts measures those in workerd.
 *
 *   node --expose-gc --experimental-strip-types bench/node-bench.ts
 *
 * Prints one JSON object; RESULTS.md quotes it.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { editDoc, textIndex } from "../src/doc-model.ts";
import { decodeSeed, fixtureMeta, type Profile, seedBody } from "./fixture.ts";
import { agentOps, quotes } from "./quotes.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");

const SIZES = [250_000, 500_000, 1_000_000, 2_000_000, 4_000_000];
const TAIL = 2000;
const REPS = 7;

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ] ?? Number.NaN;
const r2 = (x: number) => Math.round(x * 100) / 100;

function time(f: () => void, reps = REPS) {
  f();
  const ms: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    f();
    ms.push(performance.now() - t);
  }
  return r2(median(ms));
}

function load(snapshot: Uint8Array, tail: Uint8Array[] = []) {
  const doc = new Y.Doc({ gc: true });
  doc.transact(() => {
    Y.applyUpdate(doc, snapshot);
    for (const u of tail) Y.applyUpdate(doc, u);
  });
  return doc;
}

function structCount(doc: Y.Doc) {
  let n = 0;
  for (const s of doc.store.clients.values()) n += s.length;
  return n;
}

function heapOf(f: () => unknown) {
  gc?.();
  gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const keep = f();
  gc?.();
  gc?.();
  const h1 = process.memoryUsage().heapUsed;
  void keep;
  return Math.round((h1 - h0) / 1024 / 1024) + 0;
}

const results: Record<string, unknown> = {};

const PROFILES: Profile[] = ["heavy", "typing"];
for (const profile of PROFILES)
  for (const size of SIZES) {
    const { snapshot, tail } = decodeSeed(seedBody(size, TAIL, profile));
    const meta = fixtureMeta(size, TAIL, profile);
    const doc = load(snapshot);
    const row: Record<string, unknown> = {
      historyOps: meta.historyOps,
      snapshotBytes: snapshot.byteLength,
      textChars: textIndex(doc).text.length,
      blocks: doc.getXmlFragment("default").length,
      structs: structCount(doc),
      heapMB: heapOf(() => load(snapshot)),
      heapMBWithTail: heapOf(() => load(snapshot, tail)),
    };

    // Cold wake: what the room's constructor does after hibernation.
    row.loadSnapshotMs = time(() => load(snapshot));
    row.loadSnapshotPlusTailMs = time(() => load(snapshot, tail));
    row.loadMergedMs = time(() => load(Y.mergeUpdates([snapshot, ...tail])));

    // Compaction: encode the live doc into one snapshot.
    const live = load(snapshot, tail);
    row.compactEncodeMs = time(() => Y.encodeStateAsUpdate(live));
    row.compactMergeOfflineMs = time(() => Y.mergeUpdates([snapshot, ...tail]));
    // Relay-only room: what a room that never loads the doc would still parse
    // (the state vector of a client-uploaded snapshot, to check it covers
    // every stored update before replacing them).
    row.stateVectorFromSnapshotMs = time(() =>
      Y.encodeStateVectorFromUpdate(snapshot),
    );

    // New joiner with an empty doc: sync step 2 is the full state.
    const empty = Y.encodeStateVector(new Y.Doc());
    row.joinFullStateMs = time(() => Y.encodeStateAsUpdate(live, empty));
    const upToDate = Y.encodeStateVector(live);
    row.joinUpToDateMs = time(() => Y.encodeStateAsUpdate(live, upToDate));

    // Per message: a keystroke update through readSyncMessage, plus encoding
    // the broadcast frame (sent once per peer by the runtime).
    {
      const d = load(snapshot);
      let frame: Uint8Array | null = null;
      d.on("update", (u: Uint8Array) => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeUpdate(e, u);
        frame = encoding.toUint8Array(e);
      });
      const ms: number[] = [];
      for (const u of tail) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeUpdate(e, u);
        const msg = encoding.toUint8Array(e);
        const t = performance.now();
        const dec = decoding.createDecoder(msg);
        decoding.readVarUint(dec);
        syncProtocol.readSyncMessage(dec, encoding.createEncoder(), d, null);
        ms.push(performance.now() - t);
      }
      void frame;
      row.msgP50Ms = r2(pct(ms, 0.5) * 1000) / 1000;
      row.msgP99Ms = r2(pct(ms, 0.99));
      row.msgMaxMs = r2(Math.max(...ms));
      row.tailUpdateBytesAvg = Math.round(
        tail.reduce((n, u) => n + u.byteLength, 0) / tail.length,
      );
    }

    // A 20 KB paste from one client.
    {
      const src = new Y.Doc();
      Y.applyUpdate(src, Y.encodeStateAsUpdate(live));
      let paste: Uint8Array = new Uint8Array();
      src.on("update", (u: Uint8Array) => {
        paste = u;
      });
      const frag = src.getXmlFragment("default");
      const el = frag.get(3) as Y.XmlElement;
      (el.get(0) as Y.XmlText).insert(0, "pasted text ".repeat(1700));
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) {
        const d = load(snapshot, tail);
        const t = performance.now();
        Y.applyUpdate(d, paste);
        ms.push(performance.now() - t);
      }
      row.paste20kApplyMs = r2(median(ms));
      row.paste20kBytes = (paste as Uint8Array).byteLength;
    }

    // read_doc: the text index edit_doc builds first (Markdown would cost more).
    row.textIndexMs = time(() => textIndex(live));

    // edit_doc: resolve quotes and apply in one transaction, then encode.
    for (const n of [1, 10, 50]) {
      const d = load(snapshot, tail);
      const ms: number[] = [];
      let out = 0;
      for (let rep = 0; rep < REPS; rep++) {
        const qs = quotes(d, n, 24, 100 + rep);
        const ops = agentOps(qs);
        // A listener makes Yjs encode the update, as the room's does.
        const onU = (u: Uint8Array) => {
          out += u.byteLength;
        };
        d.on("update", onU);
        const t = performance.now();
        editDoc(d, ops);
        ms.push(performance.now() - t);
        d.off("update", onU);
      }
      row[`editDoc${n}OpsMs`] = r2(median(ms));
      row[`editDoc${n}OpsUpdateBytes`] = Math.round(out / REPS);
    }

    results[`${profile} ${size / 1_000_000}MB`] = row;
    process.stderr.write(`done ${profile} ${size}\n`);
  }

console.log(
  JSON.stringify({ node: process.version, v8: process.versions.v8, results }),
);
