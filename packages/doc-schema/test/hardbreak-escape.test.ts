import { describe, expect, it } from "vitest";
import { docSchema, docToMarkdown, markdownToDoc } from "../src/index.ts";

// #2178: text right after a hardBreak starts a line, so it must survive a
// Markdown round trip as text and not become a heading, list, quote or code.
const CASES = [
  "# b",
  "- b",
  "+ b",
  "* b",
  "> b",
  "1. b",
  "1) b",
  "---",
  "===",
  "=",
  " b",
  "    code",
  "\tb",
  "- item",
];

describe("text after a hard break round trips", () => {
  for (const after of CASES) {
    it(JSON.stringify(after), () => {
      const doc = docSchema.node("doc", null, [
        docSchema.node("paragraph", null, [
          docSchema.text("Notes:"),
          docSchema.node("hardBreak"),
          docSchema.text(after),
        ]),
      ]);
      const md = docToMarkdown(doc);
      const back = markdownToDoc(md).doc;
      expect(back.toJSON()).toEqual(doc.toJSON());
      expect(docToMarkdown(back)).toBe(md);
    });
  }

  it("keeps Notes: break - item as one paragraph", () => {
    const { doc } = markdownToDoc("Notes:\\\n\\- item\n");
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("paragraph");
  });

  const bold = docSchema.marks.bold;
  const italic = docSchema.marks.italic;
  const trailing: [string, () => ReturnType<typeof docSchema.text>[]][] = [
    ["bold space", () => [docSchema.text(" ", [bold.create()])]],
    ["italic space", () => [docSchema.text(" ", [italic.create()])]],
    ["plain space", () => [docSchema.text("  ")]],
  ];
  for (const [name, mk] of trailing) {
    for (const wrap of ["paragraph", "list", "quote"]) {
      it(`a break then ${name} leaves no literal backslash (${wrap})`, () => {
        const para = docSchema.node("paragraph", null, [
          docSchema.text("a"),
          docSchema.node("hardBreak"),
          ...mk(),
        ]);
        const item = docSchema.node("listItem", null, [para]);
        const inner =
          wrap === "list"
            ? docSchema.node("bulletList", null, [item])
            : wrap === "quote"
              ? docSchema.node("blockquote", null, [para])
              : para;
        const md = docToMarkdown(docSchema.node("doc", null, [inner]));
        expect(md).not.toContain("\\");
        expect(markdownToDoc(md).doc.textContent.trim()).toBe("a");
      });
    }
  }

  // Leading whitespace inside a bold or italic run after a break is moved
  // outside the mark by prosemirror-markdown before the escape runs.
  it.todo("keeps leading whitespace inside a marked run after a break");
});
