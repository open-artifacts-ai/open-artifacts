import { docFragment } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocOps, MAX_DOC_BYTES, readDoc } from "../src/index.ts";
import { connect, ydocOf } from "./helpers.ts";

// The Y.XmlText inside the index-th top-level block.
function blockText(ydoc: Y.Doc, index: number): Y.XmlText {
  const el = docFragment(ydoc).get(index) as Y.XmlElement;
  return el.get(0) as Y.XmlText;
}

describe("read_doc", () => {
  it("returns the live doc as Markdown", () => {
    const ydoc = ydocOf("# Plan\n\n- [x] **ship** it\n");
    expect(readDoc(ydoc)).toBe("# Plan\n\n- [x] **ship** it\n");
  });

  it("an empty doc reads as empty Markdown", () => {
    expect(readDoc(new Y.Doc())).toBe("");
  });

  it("follows edits", () => {
    const ydoc = ydocOf("Hello\n");
    blockText(ydoc, 0).insert(5, " world");
    expect(readDoc(ydoc)).toBe("Hello world\n");
  });
});

describe("edit_doc on a Y.Doc", () => {
  it("applies every op in one transaction with the given origin", () => {
    const ydoc = ydocOf("one two three\n");
    const origins: unknown[] = [];
    ydoc.on("afterTransaction", (t: Y.Transaction) => origins.push(t.origin));
    const result = applyDocOps(
      ydoc,
      [
        { op: "replace", quote: "one", with: "1" },
        { op: "format", quote: "two", mark: "bold" },
        { op: "insert", at: "end", markdown: "## Next" },
      ],
      { origin: "agent" },
    );
    expect(result).toEqual({ ok: true, applied: 3, changes: [] });
    expect(origins).toEqual(["agent"]);
    expect(readDoc(ydoc)).toBe("1 **two** three\n\n## Next\n");
  });

  it("a failing op applies nothing", () => {
    const ydoc = ydocOf("one two\n");
    const before = Y.encodeStateVector(ydoc);
    let updates = 0;
    ydoc.on("update", () => updates++);
    const result = applyDocOps(ydoc, [
      { op: "replace", quote: "one", with: "1" },
      { op: "delete", quote: "missing" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("quote_not_found");
      expect(result.error.opIndex).toBe(1);
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateVector(ydoc)).toEqual(before);
    expect(readDoc(ydoc)).toBe("one two\n");
  });

  it("touches only what changed: other blocks keep their Yjs identity", () => {
    const ydoc = ydocOf("First\n\nSecond\n\nThird\n");
    const second = docFragment(ydoc).get(1);
    const third = docFragment(ydoc).get(2);
    applyDocOps(ydoc, [{ op: "replace", quote: "First", with: "1st" }]);
    expect(docFragment(ydoc).get(1)).toBe(second);
    expect(docFragment(ydoc).get(2)).toBe(third);
  });

  it("an edit to an empty doc fills it", () => {
    const ydoc = new Y.Doc();
    const result = applyDocOps(ydoc, [
      { op: "insert", at: "start", markdown: "# Title\n\nBody" },
    ]);
    expect(result.ok).toBe(true);
    expect(readDoc(ydoc)).toBe("# Title\n\nBody\n");
  });
});

describe("an agent and a person", () => {
  it("a person's edit before the agent's op wins: the agent gets quote_not_found", () => {
    const room = ydocOf("The quick brown fox jumps.\n\nSecond line.\n");
    const person = new Y.Doc();
    connect(room, person);
    // The agent reads the doc.
    expect(readDoc(room)).toContain("quick brown fox");
    // The person changes the sentence before the agent's op arrives.
    const text = blockText(person, 0);
    text.delete(10, 5);
    text.insert(10, "red");
    expect(readDoc(room)).toBe("The quick red fox jumps.\n\nSecond line.\n");
    const result = applyDocOps(room, [
      { op: "replace", quote: "quick brown fox", with: "slow dog" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("quote_not_found");
      expect(result.error.closest).toContain("quick red fox");
    }
    // Nothing changed: the person's text stands on both sides.
    expect(readDoc(room)).toBe("The quick red fox jumps.\n\nSecond line.\n");
    expect(readDoc(person)).toBe(readDoc(room));
  });

  it("the agent retries with the closest text and both edits stand", () => {
    const room = ydocOf("The quick brown fox.\n");
    const person = new Y.Doc();
    connect(room, person);
    const text = blockText(person, 0);
    text.delete(10, 5);
    text.insert(10, "red");
    const first = applyDocOps(room, [
      { op: "format", quote: "quick brown fox", mark: "bold" },
    ]);
    expect(first.ok).toBe(false);
    const closest = first.ok ? "" : (first.error.closest ?? "");
    const retry = applyDocOps(room, [
      { op: "format", quote: closest, mark: "bold" },
    ]);
    expect(retry.ok).toBe(true);
    expect(readDoc(person)).toBe("The **quick red fox.**\n");
  });

  it("an edit elsewhere in the same block does not block the agent", () => {
    const room = ydocOf("Alpha beta gamma.\n");
    const person = new Y.Doc();
    connect(room, person);
    blockText(person, 0).insert(0, "Hey. ");
    const result = applyDocOps(room, [
      { op: "replace", quote: "gamma", with: "delta" },
    ]);
    expect(result.ok).toBe(true);
    expect(readDoc(person)).toBe("Hey. Alpha beta delta.\n");
  });

  it("concurrent edits to different blocks both survive the merge", () => {
    const room = ydocOf("Agent block.\n\nPerson block.\n");
    const person = new Y.Doc();
    Y.applyUpdate(person, Y.encodeStateAsUpdate(room));
    // Both edit before either sees the other's change.
    blockText(person, 1).insert(13, " Typed offline.");
    const result = applyDocOps(room, [
      { op: "replace", quote: "Agent block.", with: "Agent **edit**." },
    ]);
    expect(result.ok).toBe(true);
    Y.applyUpdate(person, Y.encodeStateAsUpdate(room));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(person));
    const merged = "Agent **edit**.\n\nPerson block. Typed offline.\n";
    expect(readDoc(room)).toBe(merged);
    expect(readDoc(person)).toBe(merged);
  });

  it("concurrent typing in the same block keeps the person's characters", () => {
    const room = ydocOf("one two three\n");
    const person = new Y.Doc();
    Y.applyUpdate(person, Y.encodeStateAsUpdate(room));
    blockText(person, 0).insert(13, " four");
    applyDocOps(room, [{ op: "replace", quote: "one", with: "zero" }]);
    Y.applyUpdate(person, Y.encodeStateAsUpdate(room));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(person));
    expect(readDoc(room)).toBe("zero two three four\n");
    expect(readDoc(person)).toBe(readDoc(room));
  });
});

describe("doc_too_large", () => {
  it("refuses an edit to a doc over the limit, naming it", () => {
    const ydoc = ydocOf(`${"word ".repeat(200)}\n`);
    const size = Y.encodeStateAsUpdate(ydoc).byteLength;
    const result = applyDocOps(
      ydoc,
      [{ op: "insert", at: "end", markdown: "x" }],
      { maxBytes: size - 1 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "doc_too_large", limitBytes: size - 1, sizeBytes: size },
    });
    expect(result.ok || result.error.message).toMatch(/limit/);
  });

  it("refuses an edit that would grow the doc past the limit", () => {
    const ydoc = ydocOf("small\n");
    const size = Y.encodeStateAsUpdate(ydoc).byteLength;
    const before = readDoc(ydoc);
    const result = applyDocOps(
      ydoc,
      [{ op: "insert", at: "end", markdown: "y".repeat(500) }],
      { maxBytes: size + 100 },
    );
    expect(result.ok || result.error.code).toBe("doc_too_large");
    expect(readDoc(ydoc)).toBe(before);
  });

  it("defaults to about 2 MB", () => {
    expect(MAX_DOC_BYTES).toBe(2 * 1024 * 1024);
  });
});
