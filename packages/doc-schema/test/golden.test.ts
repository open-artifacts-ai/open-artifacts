import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docFragment,
  docSchema,
  docToMarkdown,
  docToYXmlFragment,
  markdownToDoc,
  yXmlFragmentToDoc,
} from "../src/index.ts";
import { GOLDEN } from "./golden.ts";

function viaYjs(doc: PMNode): PMNode {
  // Write, then encode the update and apply it to a fresh Y.Doc: the path a
  // room's stored state takes to a browser.
  const source = new Y.Doc();
  docToYXmlFragment(doc, docFragment(source));
  const target = new Y.Doc();
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
  return yXmlFragmentToDoc(docFragment(target));
}

describe("golden round trip", () => {
  for (const [name, md] of Object.entries(GOLDEN)) {
    it(`${name}: md -> doc -> md is stable`, () => {
      const { doc, json, changes } = markdownToDoc(md);
      expect(changes).toEqual([]);
      expect(docToMarkdown(doc)).toBe(md);
      expect(docToMarkdown(json)).toBe(md);
    });

    it(`${name}: md -> doc -> Yjs -> doc -> md is stable`, () => {
      const { doc } = markdownToDoc(md);
      const back = viaYjs(doc);
      expect(back.eq(doc)).toBe(true);
      expect(docToMarkdown(back)).toBe(md);
    });
  }

  it("covers every node and mark in the schema", () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    const attrs = new Set<string>();
    for (const md of Object.values(GOLDEN)) {
      markdownToDoc(md).doc.descendants((node) => {
        nodes.add(node.type.name);
        for (const mark of node.marks) marks.add(mark.type.name);
        if (node.type.name === "heading") attrs.add(`h${node.attrs.level}`);
        if (node.type.name === "taskItem")
          attrs.add(`checked:${node.attrs.checked}`);
        if (node.type.name === "orderedList" && node.attrs.start !== 1)
          attrs.add("start");
        if (node.type.name === "codeBlock")
          attrs.add(`lang:${node.attrs.language !== null}`);
        return true;
      });
    }
    const allNodes = Object.keys(docSchema.nodes).filter((n) => n !== "doc");
    expect([...nodes].sort()).toEqual(allNodes.sort());
    expect([...marks].sort()).toEqual(Object.keys(docSchema.marks).sort());
    expect([...attrs].sort()).toEqual(
      [
        "checked:false",
        "checked:true",
        "h1",
        "h2",
        "h3",
        "lang:false",
        "lang:true",
        "start",
      ].sort(),
    );
  });

  it("keeps the parsed structure, not only the text", () => {
    const { json } = markdownToDoc(GOLDEN.everything);
    expect(json.content?.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletList",
      "blockquote",
      "horizontalRule",
      "codeBlock",
    ]);
    const task = markdownToDoc("- [x] done\n").json.content?.[0];
    expect(task).toEqual({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "done" }] },
          ],
        },
      ],
    });
    const link = markdownToDoc('[x](https://e.example "T")\n').json.content?.[0]
      .content?.[0];
    expect(link?.marks).toEqual([
      { type: "link", attrs: { href: "https://e.example", title: "T" } },
    ]);
  });
});

describe("hard breaks (#2178)", () => {
  const breakCount = (doc: PMNode) => {
    let n = 0;
    doc.descendants((node) => {
      if (node.type.name === "hardBreak") n++;
      return true;
    });
    return n;
  };

  it("reads a backslash break and a two-space break as hardBreak, with no change", () => {
    for (const src of ["a\\\nb\n", "a  \nb\n"]) {
      const { doc, changes } = markdownToDoc(src);
      expect(changes).toEqual([]);
      expect(doc.firstChild?.childCount).toBe(3);
      expect(doc.firstChild?.child(1).type.name).toBe("hardBreak");
      expect(docToMarkdown(doc)).toBe("a\\\nb\n");
    }
  });

  it("drops a break at the end of a block", () => {
    const trailing = docSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a" }, { type: "hardBreak" }],
        },
      ],
    });
    expect(docToMarkdown(trailing)).toBe("a\n");
    expect(breakCount(markdownToDoc("a  \n").doc)).toBe(0);
    expect(breakCount(markdownToDoc("a  \nb  \n").doc)).toBe(1);
  });

  it("keeps several breaks in a row", () => {
    const doc = docSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "hardBreak" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    const md = docToMarkdown(doc);
    expect(md).toBe("a\\\n\\\nb\n");
    expect(markdownToDoc(md).doc.eq(doc)).toBe(true);
  });

  it("is refused in a heading", () => {
    expect(() =>
      docSchema
        .nodeFromJSON({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [
                { type: "text", text: "a" },
                { type: "hardBreak" },
                { type: "text", text: "b" },
              ],
            },
          ],
        })
        .check(),
    ).toThrow();
  });

  it("a break in a setext heading imports as a space, reported", () => {
    const { doc, changes } = markdownToDoc("Foo\\\nbar\n===\n");
    expect(breakCount(doc)).toBe(0);
    expect(docToMarkdown(doc)).toBe("# Foo bar\n");
    expect(changes.map((c) => c.kind)).toEqual(["heading_break"]);
  });

  it("a break carries no marks: bold across one is two bold runs", () => {
    const { doc } = markdownToDoc("**a\\\nb**\n");
    const kids = doc.firstChild?.content.content ?? [];
    expect(kids.map((k) => k.type.name)).toEqual(["text", "hardBreak", "text"]);
    expect(kids[1].marks).toEqual([]);
    expect(docToMarkdown(doc)).toBe("**a**\\\n**b**\n");
    expect(markdownToDoc(docToMarkdown(doc)).doc.eq(doc)).toBe(true);
    // JSON from an editor that marked the break is cleaned the same way.
    const marked = docToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "bold" }] },
            { type: "hardBreak", marks: [{ type: "bold" }] },
            { type: "text", text: "b", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    expect(marked).toBe("**a**\\\n**b**\n");
  });

  it("is refused in a code block", () => {
    expect(() =>
      docSchema
        .nodeFromJSON({
          type: "doc",
          content: [
            {
              type: "codeBlock",
              attrs: { language: null },
              content: [{ type: "hardBreak" }],
            },
          ],
        })
        .check(),
    ).toThrow();
  });

  it("survives Yjs inside a list item and a quote", () => {
    const { doc } = markdownToDoc(GOLDEN.hardBreakInBlocks);
    expect(breakCount(doc)).toBe(3);
    expect(viaYjs(doc).eq(doc)).toBe(true);
  });
});
