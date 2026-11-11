import { describe, expect, it } from "vitest";
import { applyDocOps, MAX_QUOTE_CHARS, readDoc } from "../src/index.ts";
import { ydocOf } from "./helpers.ts";

const DOC = "Person typed one.\n\nAgent target.\n\nPerson typed three.\n";

// The op must be refused with the doc untouched.
function refused(markdown: string, op: unknown, code = "invalid_op") {
  const ydoc = ydocOf(markdown);
  const before = readDoc(ydoc);
  const result = applyDocOps(ydoc, [op]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
  expect(readDoc(ydoc)).toBe(before);
  return result.ok ? null : result.error;
}

function applied(markdown: string, op: unknown): string {
  const ydoc = ydocOf(markdown);
  const result = applyDocOps(ydoc, [op]);
  expect(result.ok).toBe(true);
  return readDoc(ydoc);
}

describe("quotes with edge line breaks", () => {
  it("trims whitespace around a trailing or leading break", () => {
    for (const quote of [
      "target.\n ",
      "target.\n\t",
      "target. \n  ",
      "\n target.",
    ]) {
      expect(applied(DOC, { op: "replace", quote, with: "new" })).toBe(
        "Person typed one.\n\nAgent new\n\nPerson typed three.\n".replace(
          "Agent new",
          quote.includes("Agent") ? "new" : "Agent new",
        ),
      );
    }
  });

  it("replace, delete, insert, suffix and format never touch the neighbours", () => {
    const ops = [
      { op: "replace", quote: "target.\n ", with: "new" },
      { op: "delete", quote: "target.\n ", prefix: "Agent " },
      { op: "insert", before: "target.\n ", markdown: "x" },
      { op: "insert", after: "target.\n ", markdown: "x" },
      { op: "replace", quote: "Agent", suffix: " target.\n ", with: "Bot" },
      { op: "format", quote: "target.\n ", mark: "bold" },
    ];
    for (const op of ops) {
      const out = applied(DOC, op);
      expect(out.match(/Person typed one\./g)).toHaveLength(1);
      expect(out.match(/Person typed three\./g)).toHaveLength(1);
    }
  });

  it("format bulletList with an edge break stays inside the block", () => {
    const out = applied(DOC, {
      op: "format",
      quote: "target.\n ",
      mark: "bulletList",
    });
    expect(out.match(/Person typed one\./g)).toHaveLength(1);
    expect(out).toContain("- Agent target.");
  });

  it("refuses break-only quotes, doc unchanged", () => {
    for (const quote of ["\t\n\t", " \n ", "\n", "  \r\n  "]) {
      const e = refused(DOC, { op: "delete", quote });
      expect(e?.message).toMatch(/not empty or only line breaks/);
    }
    refused(DOC, { op: "insert", after: "\t\n\t", markdown: "x" });
    refused(DOC, { op: "format", quote: " \n", mark: "bold" });
  });

  it("a quote that is a break plus text from the next block does not map to a break", () => {
    // Prefix ending at a break must not make the match start on the break.
    const out = applied(DOC, {
      op: "replace",
      quote: "Agent target.",
      prefix: "one.\n",
      with: "new",
    });
    expect(out).toBe("Person typed one.\n\nnew\n\nPerson typed three.\n");
  });
});

describe("quotes over hidden nodes", () => {
  it("refuses a quote spanning a rule", () => {
    const md = "A\n\n---\n\nB\n";
    const e = refused(md, { op: "delete", quote: "A\nB" });
    expect(e?.message).toMatch(/rule or empty block/);
    expect(applied(md, { op: "delete", quote: "A" })).toContain("---");
  });
  it("a quote across two plain blocks still works", () => {
    expect(applied("A\n\nB\n", { op: "delete", quote: "A\nB" })).toBe("");
  });
});

describe("quote limits", () => {
  it("refuses long quotes, prefixes and suffixes", () => {
    const long = "a".repeat(MAX_QUOTE_CHARS + 1);
    for (const op of [
      { op: "delete", quote: long },
      { op: "replace", quote: "a", prefix: long, with: "b" },
      { op: "replace", quote: "a", suffix: long, with: "b" },
      { op: "insert", after: long, markdown: "x" },
    ]) {
      const e = refused("a\n", op, "quote_too_long");
      expect(e?.message).toMatch(/shorter span/);
    }
  });
  it("matching on a pathological doc stays fast", () => {
    const md = `${"a".repeat(20000)}\n`;
    const ydoc = ydocOf(md);
    const t = Date.now();
    const result = applyDocOps(ydoc, [{ op: "delete", quote: "aa" }]);
    expect(Date.now() - t).toBeLessThan(250);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("quote_ambiguous");
      expect(result.error.matches).toBe(50);
    }
  });
});

describe("candidate bound", () => {
  it("refuses a quote in too many places, even if none passes the context", () => {
    // A long run of "a" with a prefix no place has: every place fails, and
    // the lookup stops after MAX_CANDIDATES instead of scanning them all.
    const md = `${"a".repeat(5000)}\n`;
    for (const op of [
      { op: "delete", quote: "a", prefix: `${"a".repeat(30)}c` },
      { op: "delete", quote: "a", suffix: `${"a".repeat(30)}c` },
    ]) {
      const e = refused(md, op, "quote_ambiguous");
      expect(e?.message).toMatch(/too many to check.*longer span/);
    }
  });
  it("with a break in the prefix, too", () => {
    const md = `${Array.from({ length: 3000 }, () => "a").join("\n\n")}\n`;
    const e = refused(
      md,
      { op: "delete", quote: "a", prefix: "c\n" },
      "quote_ambiguous",
    );
    expect(e?.message).toMatch(/too many to check/);
  });
  it("a quote under the bound still resolves with context", () => {
    const md = `${"a".repeat(500)}c${"a".repeat(500)}\n`;
    expect(
      applied(md, { op: "replace", quote: "a", prefix: "c", with: "b" }),
    ).toBe(`${"a".repeat(500)}cb${"a".repeat(499)}\n`);
  });
});
