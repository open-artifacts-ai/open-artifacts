import { markdownToDoc } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import { applyDocOps, posAt, readDoc, visibleText } from "../src/index.ts";
import { ydocOf } from "./helpers.ts";

// #2178: a hardBreak is "\n" inside its block in the visible text, on a real
// position, and every op keeps it.

const BR = "\\\n"; // how Markdown writes a hard break
const run = (md: string, ops: unknown[]) => {
  const ydoc = ydocOf(md);
  const result = applyDocOps(ydoc, ops);
  return { result, md: readDoc(ydoc) };
};

describe("visible text with a hardBreak", () => {
  it("shows the break as \\n on a real position, apart from a block break", () => {
    const { doc } = markdownToDoc(`one${BR}two\n\nthree\n`);
    const vt = visibleText(doc);
    expect(vt.text).toBe("one\ntwo\nthree");
    expect(posAt(vt, 3)).toBeGreaterThanOrEqual(0); // the hard break
    expect(posAt(vt, 7)).toBe(-1); // the block break
    for (let i = 0; i < vt.text.length; i++) {
      const p = posAt(vt, i);
      if (p < 0) continue;
      const node = doc.nodeAt(p);
      expect(node?.type.name === "hardBreak" ? "\n" : node?.text?.[0]).toBe(
        vt.text[i],
      );
    }
  });
});

describe("edit_doc keeps hard breaks", () => {
  it("a quote can span the break", () => {
    const { result, md } = run(`one${BR}two\n\nthree\n`, [
      { op: "replace", quote: "one\ntwo", with: "1 and 2" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe("1 and 2\n\nthree\n");
  });

  it("prefix and suffix work across it", () => {
    const { result, md } = run(`a b${BR}b c\n`, [
      { op: "replace", quote: "b", with: "X", prefix: "a ", suffix: "\nb" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe(`a X${BR}b c\n`);
  });

  it("replace with Markdown holding a break makes a hardBreak", () => {
    const { result, md } = run("one two three\n", [
      { op: "replace", quote: "two", with: `2${BR}II` },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe(`one 2${BR}II three\n`);
    const ydoc = ydocOf(md);
    expect(ydoc.getXmlFragment("default").toString()).toContain("hardBreak");
  });

  it("insert with a break in the middle of a block", () => {
    const { result, md } = run(`one${BR}two\n`, [
      { op: "insert", after: "one", markdown: `${BR}mid` },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe(`one${BR}mid${BR}two\n`);
  });

  it("delete over a break removes it", () => {
    const { result, md } = run(`one${BR}two\n`, [
      { op: "delete", quote: "e\ntw" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe("ono\n");
  });

  it("delete just before a break leaves the break", () => {
    const { result, md } = run(`one${BR}two\n`, [
      { op: "delete", quote: "two" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe("one\n");
  });

  it("format across a break marks both sides, not the break", () => {
    const ydoc = ydocOf(`one${BR}two\n`);
    const result = applyDocOps(ydoc, [
      { op: "format", quote: "one\ntwo", mark: "bold" },
    ]);
    expect(result.ok).toBe(true);
    expect(readDoc(ydoc)).toBe(`**one**${BR}**two**\n`);
    const para = ydoc.getXmlFragment("default").get(0) as {
      toString(): string;
    };
    expect(para.toString()).toMatch(/<hardBreak><\/hardBreak>/);
  });

  it("replacing bold text with a break keeps the break unmarked", () => {
    const { result, md } = run("**one two**\n", [
      { op: "replace", quote: "one", with: `a${BR}b` },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe(`**a**${BR}**b two**\n`);
  });

  it("splitting a block with blocks keeps its break and the offsets right", () => {
    const { result, md } = run(`one${BR}two three\n`, [
      { op: "insert", after: "two", markdown: "# Mid" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe(`one${BR}two\n\n# Mid\n\nthree\n`);
  });

  it("a heading cannot take a break, with the next step", () => {
    const into = run("# Title\n", [
      { op: "replace", quote: "Title", with: `a${BR}b` },
    ]);
    expect(into.result.ok).toBe(false);
    if (!into.result.ok) expect(into.result.error.message).toMatch(/heading/);
    const turn = run(`one${BR}two\n`, [
      { op: "format", quote: "one\ntwo", mark: "heading1" },
    ]);
    expect(turn.result.ok).toBe(false);
    if (!turn.result.ok)
      expect(turn.result.error.message).toMatch(/line break/);
    expect(turn.md).toBe(`one${BR}two\n`);
  });

  it("a code block quote with a newline is still text", () => {
    const { result, md } = run("```\na\nb\n```\n", [
      { op: "replace", quote: "a\nb", with: "c" },
    ]);
    expect(result.ok).toBe(true);
    expect(md).toBe("```\nc\n```\n");
  });
});
