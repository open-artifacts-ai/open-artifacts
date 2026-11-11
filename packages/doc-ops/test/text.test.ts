import { markdownToDoc } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import { closestText, findQuote, visibleText } from "../src/index.ts";

describe("visibleText", () => {
  it("is the text people see, one line break between blocks", () => {
    const { doc } = markdownToDoc(
      "# **Big** title\n\n- [x] item\n\n> quote\n\n---\n\n```\na\nb\n```\n",
    );
    expect(visibleText(doc).text).toBe("Big title\nitem\nquote\na\nb");
  });

  it("maps every character to its ProseMirror position", () => {
    const { doc } = markdownToDoc("ab\n\ncd\n");
    const { text, pos } = visibleText(doc);
    expect(pos.length).toBe(text.length);
    expect(pos[2]).toBe(-1);
    for (let i = 0; i < text.length; i++) {
      if (pos[i] >= 0)
        expect(doc.textBetween(pos[i], pos[i] + 1)).toBe(text[i]);
    }
  });

  it("skips empty blocks", () => {
    const { doc } = markdownToDoc("a\n");
    const withEmpty = doc.type.create(null, [
      doc.child(0),
      doc.type.schema.nodes.paragraph.create(),
      doc.child(0),
    ]);
    expect(visibleText(withEmpty).text).toBe("a\na");
  });
});

describe("findQuote", () => {
  it("returns the ProseMirror range", () => {
    const { doc } = markdownToDoc("Hello *big* world\n");
    const found = findQuote(doc, "big world");
    expect(found.kind).toBe("found");
    if (found.kind === "found") {
      expect(doc.textBetween(found.match.from, found.match.to)).toBe(
        "big world",
      );
    }
  });

  it("counts overlapping matches", () => {
    const { doc } = markdownToDoc("aaa\n");
    expect(findQuote(doc, "aa")).toEqual({ kind: "ambiguous", matches: 2 });
  });

  it("accepts CRLF line breaks in a quote", () => {
    const { doc } = markdownToDoc("a\n\nb\n");
    expect(findQuote(doc, "a\r\n\r\nb").kind).toBe("found");
  });
});

describe("closestText", () => {
  it("finds the most similar stretch, widened to whole words", () => {
    const text =
      "Intro words here. The quick red fox jumps over the dog. Outro.";
    expect(closestText(text, "quick brown fox jumps")).toBe(
      "quick red fox jumps",
    );
  });

  it("ignores case when scoring", () => {
    expect(closestText("alpha BETA gamma", "beta")).toBe("BETA");
  });

  it("handles a quote longer than the doc", () => {
    expect(closestText("short", "a much longer quote than the doc")).toBe(
      "short",
    );
  });

  it("stays fast on a large doc", () => {
    const big = "lorem ipsum dolor sit amet ".repeat(40_000);
    const start = performance.now();
    closestText(big, "a quote that is not there at all, fairly long");
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
