import { describe, expect, it } from "vitest";
import * as Y from "yjs";

// The package runs inside the doc room (a Durable Object), where there is no
// DOM. Vitest's node environment has none either, so importing and using
// every entry point here proves nothing reaches for document or window.
describe("runtime without a DOM", () => {
  it("has no DOM globals in this environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe(
      "undefined",
    );
    expect(typeof (globalThis as { window?: unknown }).window).toBe(
      "undefined",
    );
  });

  it("imports and runs every entry point", async () => {
    const mod = await import("../src/index.ts");
    const { doc, changes } = mod.markdownToDoc("# Hi\n\n- [x] <b>done</b>\n");
    expect(changes.map((c) => c.kind)).toEqual(["html", "html"]);
    const ydoc = new Y.Doc();
    mod.docToYXmlFragment(doc, mod.docFragment(ydoc));
    const back = mod.yXmlFragmentToDoc(mod.docFragment(ydoc));
    expect(mod.docToMarkdown(back)).toBe("# Hi\n\n- [x] \\<b>done\\</b>\n");
    expect(mod.docFromJSON(back.toJSON()).eq(back)).toBe(true);
  });
});

describe("Yjs helpers", () => {
  it("uses Tiptap Collaboration's default field", async () => {
    const { DOC_FRAGMENT, docFragment } = await import("../src/index.ts");
    const ydoc = new Y.Doc();
    expect(DOC_FRAGMENT).toBe("default");
    expect(docFragment(ydoc)).toBe(ydoc.getXmlFragment("default"));
  });

  it("refuses to overwrite a fragment that has content", async () => {
    const mod = await import("../src/index.ts");
    const ydoc = new Y.Doc();
    const fragment = mod.docFragment(ydoc);
    mod.docToYXmlFragment(mod.markdownToDoc("a\n").doc, fragment);
    expect(() =>
      mod.docToYXmlFragment(mod.markdownToDoc("b\n").doc, fragment),
    ).toThrow(/empty fragment/);
  });

  it("reads an empty fragment as one empty paragraph", async () => {
    const mod = await import("../src/index.ts");
    const doc = mod.yXmlFragmentToDoc(mod.docFragment(new Y.Doc()));
    expect(doc.toJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(mod.docToMarkdown(doc)).toBe("");
  });

  it("merges concurrent edits from two replicas into a valid doc", async () => {
    const mod = await import("../src/index.ts");
    const a = new Y.Doc();
    mod.docToYXmlFragment(mod.markdownToDoc("first\n").doc, mod.docFragment(a));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Each replica appends a paragraph without seeing the other's.
    for (const [ydoc, text] of [
      [a, "from a"],
      [b, "from b"],
    ] as const) {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(text)]);
      mod.docFragment(ydoc).push([p]);
    }
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const mdA = mod.docToMarkdown(mod.yXmlFragmentToDoc(mod.docFragment(a)));
    const mdB = mod.docToMarkdown(mod.yXmlFragmentToDoc(mod.docFragment(b)));
    expect(mdA).toBe(mdB);
    expect(mdA.trim().split("\n\n").sort()).toEqual([
      "first",
      "from a",
      "from b",
    ]);
  });

  it("rejects JSON outside the content set", async () => {
    const { docFromJSON } = await import("../src/index.ts");
    expect(() =>
      docFromJSON({
        type: "doc",
        content: [{ type: "image", attrs: { src: "x" } }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      docFromJSON({
        type: "doc",
        content: [{ type: "heading", attrs: { level: "2" } }],
      }),
    ).toThrow();
    expect(() =>
      docFromJSON({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 4 } }],
      }),
    ).toThrow(/heading level/);
  });
});
