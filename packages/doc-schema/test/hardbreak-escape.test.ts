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
});
