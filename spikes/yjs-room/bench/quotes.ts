import type * as Y from "yjs";
import { type Op, textIndex } from "../src/doc-model.ts";
import { rng } from "./fixture.ts";

/** Unique single-block quotes of `len` chars spread across the text. */
export function quotes(doc: Y.Doc, n: number, len: number, seed: number) {
  const { text } = textIndex(doc);
  const r = rng(seed);
  const out: string[] = [];
  const used: number[] = [];
  for (let tries = 0; out.length < n && tries < n * 50; tries++) {
    const at = Math.floor(r() * (text.length - len));
    const q = text.slice(at, at + len);
    if (q.includes("\n") || used.some((u) => Math.abs(u - at) < len * 2))
      continue;
    const first = text.indexOf(q);
    if (text.indexOf(q, first + 1) >= 0) continue;
    out.push(q);
    used.push(at);
  }
  return out;
}

/** A mix of replace, format and insert_after ops, as an agent would send. */
export function agentOps(qs: string[]): Op[] {
  return qs.map((quote, i) =>
    i % 3 === 0
      ? { op: "replace", quote, with: "agent replaced this text" }
      : i % 3 === 1
        ? { op: "format", quote, mark: "bold" }
        : { op: "insert_after", quote, markdown: "New paragraph by agent." },
  );
}
