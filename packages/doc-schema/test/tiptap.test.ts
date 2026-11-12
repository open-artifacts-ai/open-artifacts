import { getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import {
  docFragment,
  docSchema,
  docToYXmlFragment,
  markdownToDoc,
  yXmlFragmentToDoc,
} from "../src/index.ts";
import { GOLDEN } from "./golden.ts";

// The Tiptap setup the editor must use to read and write the same docs. Kept
// here so a Tiptap upgrade that drifts from the schema fails this test.
const tiptapSchema = getSchema([
  StarterKit.configure({
    underline: false,
    heading: { levels: [1, 2, 3] },
  }).extend({
    addExtensions() {
      return (this.parent?.() ?? []).map((ext) =>
        ext.name === "code"
          ? ext.extend({ excludes: "" })
          : ext.name === "heading"
            ? ext.extend({ content: "text*" })
            : ext,
      );
    },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
]);

describe("Tiptap compatibility", () => {
  it("has the same node and mark names, with the editor's extras only", () => {
    const ours = Object.keys(docSchema.nodes).sort();
    const theirs = Object.keys(tiptapSchema.nodes).sort();
    expect(theirs).toEqual(ours);
    expect(Object.keys(tiptapSchema.marks).sort()).toEqual(
      Object.keys(docSchema.marks).sort(),
    );
  });

  it("matches content expressions and attribute names", () => {
    for (const [name, type] of Object.entries(docSchema.nodes)) {
      const theirs = tiptapSchema.nodes[name];
      expect(theirs.spec.content, name).toBe(type.spec.content);
      for (const attr of Object.keys(type.spec.attrs ?? {})) {
        expect(
          Object.keys(theirs.spec.attrs ?? {}),
          `${name}.${attr}`,
        ).toContain(attr);
      }
    }
    const { code, link } = tiptapSchema.marks;
    expect(code.excludes(link)).toBe(false);
    for (const attr of ["href", "title"]) {
      expect(Object.keys(tiptapSchema.marks.link.spec.attrs ?? {})).toContain(
        attr,
      );
    }
  });

  for (const [name, md] of Object.entries(GOLDEN)) {
    it(`${name}: Tiptap's schema accepts the doc, and reads it from Yjs unchanged`, () => {
      const { doc, json } = markdownToDoc(md);
      tiptapSchema.nodeFromJSON(json).check();

      const ydoc = new Y.Doc();
      docToYXmlFragment(doc, docFragment(ydoc));
      const inEditor = yXmlFragmentToProseMirrorRootNode(
        docFragment(ydoc),
        tiptapSchema,
      );
      inEditor.check();

      // Compare on our own schema: Tiptap adds default attrs (link target,
      // ordered list type) that ours ignores.
      const back = docSchema.nodeFromJSON(inEditor.toJSON());
      expect(back.eq(doc)).toBe(true);
    });
  }

  it("reads a fragment Tiptap wrote, with Tiptap's extra attributes", () => {
    const ydoc = new Y.Doc();
    const editorDoc = tiptapSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2, type: null },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "hi",
                      marks: [
                        {
                          type: "link",
                          attrs: {
                            href: "https://e.example",
                            target: "_blank",
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const fragment = docFragment(ydoc);
    // Tiptap's own write path, as its Collaboration extension does it.
    prosemirrorToYXmlFragment(editorDoc, fragment);
    const doc = yXmlFragmentToDoc(fragment);
    expect(doc.toJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "hi",
                      marks: [
                        {
                          type: "link",
                          attrs: { href: "https://e.example", title: null },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
