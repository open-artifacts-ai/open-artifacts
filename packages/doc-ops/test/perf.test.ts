import { docFragment, docToYXmlFragment, markdownToDoc } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDocOps,
  applyOpsToDoc,
  closestText,
  findQuote,
  MAX_DOC_BYTES,
} from "../src/index.ts";

// A doc near the 2 MB cap: many short paragraphs, repeated text, a few unique lines.
function bigDoc(bytes = 1_250_000) {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line =
      i % 200 === 0
        ? `Unique marker number ${i} stands alone in this paragraph of text.`
        : "The agent edits shared documents while people type, and every sentence repeats here.";
    lines.push(line);
    size += line.length + 2;
  }
  return markdownToDoc(`${lines.join("\n\n")}\n`).doc;
}

const doc = bigDoc();
const ydoc = new Y.Doc();
docToYXmlFragment(doc, docFragment(ydoc));
const time = (f: () => void) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const log = (name: string, ms: number) =>
  process.stderr.write(`perf ${name}: ${ms.toFixed(1)} ms\n`);

describe("a doc at the size cap", () => {
  it("is near the cap", () => {
    expect(Y.encodeStateAsUpdate(ydoc).byteLength).toBeGreaterThan(
      MAX_DOC_BYTES / 3,
    );
  });

  it("a quote that is not there answers fast", () => {
    const quote =
      "this sentence is not anywhere in the document, and is long enough to matter ".repeat(
        10,
      );
    const ms = time(() => {
      const r = findQuote(doc, quote.slice(0, 900));
      expect(r.kind).toBe("not_found");
    });
    log("not found", ms);
    expect(ms).toBeLessThan(150);
  });

  it("a repeated prefix does not scan 1000 characters everywhere", () => {
    const ms = time(() => {
      const r = findQuote(doc, "agent edits", "x".repeat(1000));
      expect(r.kind).toBe("not_found");
    });
    log("long prefix", ms);
    expect(ms).toBeLessThan(150);
  });

  it("50 ops on it take well under a second", () => {
    const ops = Array.from({ length: 50 }, (_, i) => ({
      op: "replace",
      quote: `Unique marker number ${(i % 8) * 200} stands`,
      with: `Edited marker ${i} stands`,
    }));
    let result: ReturnType<typeof applyOpsToDoc> | undefined;
    const ms = time(() => {
      result = applyOpsToDoc(doc, ops);
    });
    log("50 ops (applyOpsToDoc)", ms);
    // Later ops hit text an earlier one replaced, so some fail; count the first failure.
    expect(result).toBeDefined();
    expect(ms).toBeLessThan(250);
  });

  it("50 distinct edits", () => {
    const ops = Array.from({ length: 50 }, (_, i) => ({
      op: "replace",
      quote: `Unique marker number ${i * 200} stands`,
      with: `Edited marker ${i} stands`,
    }));
    let result: ReturnType<typeof applyOpsToDoc> | undefined;
    const ms = time(() => {
      result = applyOpsToDoc(doc, ops);
    });
    log("50 distinct ops (applyOpsToDoc)", ms);
    expect(result?.ok || JSON.stringify(result)).toBe(true);
    expect(ms).toBeLessThan(250);
    const y = new Y.Doc();
    docToYXmlFragment(doc, docFragment(y));
    const total = time(() => {
      const r = applyDocOps(y, ops);
      expect(r.ok || JSON.stringify(r)).toBe(true);
    });
    log("50 distinct ops (applyDocOps)", total);
  });

  it("closestText", () => {
    const { text } = { text: doc.textContent };
    const ms = time(() => {
      closestText(
        text,
        "agent edits shared documnets while peple type, and every sentense repeats",
      );
    });
    log("closestText typo", ms);
    expect(ms).toBeLessThan(150);
  });
});
