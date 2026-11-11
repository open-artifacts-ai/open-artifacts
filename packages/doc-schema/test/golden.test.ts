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
