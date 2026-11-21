/**
 * Deterministic test docs with long history: 20 editors type words (mostly
 * continuing at their own cursor, sometimes jumping), delete ranges, bold
 * ranges and add paragraphs until the encoded Yjs state reaches the target
 * size. Then `tail` keystroke-sized updates are captured on top: those are
 * the update rows a room holds between compactions.
 *
 * Cached in .fixtures/ as the room's seed body (u32 len + bytes, repeated:
 * snapshot first, then each tail update).
 *
 *   node --experimental-strip-types bench/fixture.ts 1000000 2000
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { blocks, blockText, makeBlock } from "../src/doc-model.ts";

export const EDITORS = 20;
const WORDS =
  "the a doc agent person edit room quote history version cursor plan risk goal ship team write read merge offline sync update draft review comment ask".split(
    " ",
  );

/** mulberry32: small seeded PRNG so every run builds the same doc. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Fixture {
  snapshot: Uint8Array;
  tail: Uint8Array[];
  /** Transactions it took to build the snapshot. */
  historyOps: number;
}

function sentence(r: () => number, words: number) {
  const out: string[] = [];
  for (let i = 0; i < words; i++)
    out.push(WORDS[Math.floor(r() * WORDS.length)] ?? "x");
  return `${out.join(" ")}.`;
}

/**
 * heavy: editors jump around (20% of words), 20% deletes, 7% bold ranges:
 * many small Yjs items per byte, the slow case.
 * typing: mostly continuous typing (5% jumps, 8% deletes, 1% bold), closer
 * to a person writing prose.
 */
export type Profile = "heavy" | "typing";
const PROFILES = {
  heavy: { jump: 0.2, insert: 0.7, del: 0.9, bold: 0.97 },
  typing: { jump: 0.05, insert: 0.9, del: 0.98, bold: 0.99 },
} as const;

export function build(
  target: number,
  tail: number,
  profile: Profile = "heavy",
  seed = 1,
): Fixture {
  const p = PROFILES[profile];
  const r = rng(seed);
  const doc = new Y.Doc({ gc: true });
  const frag = blocks(doc);
  const ids = Array.from({ length: EDITORS }, (_, i) => 1000 + i);
  doc.clientID = ids[0] ?? 1000;
  doc.transact(() => {
    for (let i = 0; i < 40; i++)
      frag.push([
        makeBlock(i % 8 === 0 ? "heading" : "paragraph", sentence(r, 12)),
      ]);
  });
  const cursor = ids.map(() => ({ block: 0, offset: 0 }));
  const pick = () => Math.floor(r() * frag.length);

  const step = (keystroke: boolean) => {
    const who = Math.floor(r() * EDITORS);
    doc.clientID = ids[who] ?? 1000;
    const c = cursor[who] ?? { block: 0, offset: 0 };
    const x = r();
    doc.transact(() => {
      if (keystroke || x < p.insert) {
        if (r() < p.jump || c.block >= frag.length) {
          c.block = pick();
          c.offset = Math.floor(
            r() * (blockText(frag.get(c.block) as Y.XmlElement).length + 1),
          );
        }
        const t = blockText(frag.get(c.block) as Y.XmlElement);
        c.offset = Math.min(c.offset, t.length);
        const s = keystroke
          ? (WORDS[Math.floor(r() * WORDS.length)] ?? "x").slice(0, 1)
          : ` ${WORDS[Math.floor(r() * WORDS.length)]}`;
        t.insert(c.offset, s);
        c.offset += s.length;
      } else if (x < p.del) {
        const t = blockText(frag.get(pick()) as Y.XmlElement);
        if (t.length > 20) {
          const at = Math.floor(r() * (t.length - 15));
          t.delete(at, 1 + Math.floor(r() * 15));
        }
      } else if (x < p.bold) {
        const t = blockText(frag.get(pick()) as Y.XmlElement);
        if (t.length > 20) {
          const at = Math.floor(r() * (t.length - 10));
          t.format(at, 1 + Math.floor(r() * 9), { bold: {} });
        }
      } else {
        frag.insert(pick() + 1, [makeBlock("paragraph", sentence(r, 6))]);
      }
    });
  };

  let historyOps = 0;
  for (;;) {
    for (let i = 0; i < 2000; i++) step(false);
    historyOps += 2000;
    if (Y.encodeStateAsUpdate(doc).byteLength >= target) break;
  }
  const snapshot = Y.encodeStateAsUpdate(doc);
  const captured: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => captured.push(u));
  for (let i = 0; i < tail; i++) step(true);
  return { snapshot, tail: captured, historyOps };
}

export function encodeSeed(f: Fixture): Uint8Array {
  const parts = [f.snapshot, ...f.tail];
  const size = parts.reduce((n, p) => n + 4 + p.byteLength, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const p of parts) {
    dv.setUint32(off, p.byteLength, true);
    out.set(p, off + 4);
    off += 4 + p.byteLength;
  }
  return out;
}

export function decodeSeed(buf: Uint8Array): Omit<Fixture, "historyOps"> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const parts: Uint8Array[] = [];
  let off = 0;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    parts.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  const [snapshot, ...tail] = parts;
  return { snapshot: snapshot ?? new Uint8Array(), tail };
}

const DIR = join(import.meta.dirname, "..", ".fixtures");

/** Cached fixture as the room's seed body. */
export function seedBody(
  target: number,
  tail: number,
  profile: Profile = "heavy",
): Uint8Array {
  const file = join(DIR, `doc-${profile}-${target}-${tail}.bin`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  mkdirSync(DIR, { recursive: true });
  const t0 = performance.now();
  const f = build(target, tail, profile);
  const body = encodeSeed(f);
  writeFileSync(file, body);
  writeFileSync(
    `${file}.json`,
    JSON.stringify({
      target,
      tail,
      historyOps: f.historyOps,
      snapshotBytes: f.snapshot.byteLength,
      tailBytes: f.tail.reduce((n, u) => n + u.byteLength, 0),
      buildMs: Math.round(performance.now() - t0),
    }),
  );
  return body;
}

export function fixtureMeta(
  target: number,
  tail: number,
  profile: Profile = "heavy",
) {
  seedBody(target, tail, profile);
  return JSON.parse(
    readFileSync(
      join(DIR, `doc-${profile}-${target}-${tail}.bin.json`),
      "utf8",
    ),
  ) as { historyOps: number; snapshotBytes: number; tailBytes: number };
}

if (import.meta.main) {
  const target = Number(process.argv[2] ?? 1_000_000);
  const tail = Number(process.argv[3] ?? 2000);
  const profile = (process.argv[4] ?? "heavy") as Profile;
  console.log(fixtureMeta(target, tail, profile));
}
