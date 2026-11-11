import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docFragment,
  docToYXmlFragment,
  markdownToDoc,
  yXmlFragmentToDoc,
} from "../src/index.ts";
import { GOLDEN } from "./golden.ts";

const bytes = (d: Y.Doc) => Y.encodeStateAsUpdate(d);

function validDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  docToYXmlFragment(
    markdownToDoc("# Hi\n\nSome **text**\n").doc,
    docFragment(ydoc),
  );
  return ydoc;
}

describe("yXmlFragmentToDoc leaves the live doc alone", () => {
  it("reads a valid fragment without changing it", () => {
    const ydoc = validDoc();
    const before = bytes(ydoc);
    const doc = yXmlFragmentToDoc(docFragment(ydoc));
    expect(doc.eq(markdownToDoc("# Hi\n\nSome **text**\n").doc)).toBe(true);
    expect(bytes(ydoc)).toEqual(before);
  });

  it.each(["table", "image"])(
    "throws on an unknown <%s> and changes nothing",
    (name) => {
      const ydoc = validDoc();
      const frag = docFragment(ydoc);
      frag.insert(1, [new Y.XmlElement(name)]);
      const before = bytes(ydoc);
      expect(() => yXmlFragmentToDoc(frag)).toThrow(
        /can't read.*Nothing was changed/,
      );
      expect(bytes(ydoc)).toEqual(before);
      expect(frag.length).toBe(3);
    },
  );

  it("reads a fragment kept under another field name", () => {
    const ydoc = new Y.Doc();
    docToYXmlFragment(
      markdownToDoc("Hello\n").doc,
      ydoc.getXmlFragment("other"),
    );
    expect(yXmlFragmentToDoc(ydoc.getXmlFragment("other")).textContent).toBe(
      "Hello",
    );
  });

  it("throws clearly for a fragment with no doc", () => {
    const frag = new Y.XmlFragment();
    frag.push([new Y.XmlElement("paragraph")]);
    expect(() => yXmlFragmentToDoc(frag)).toThrow(/belongs to a Y.Doc/);
  });
});

describe("yXmlFragmentToDoc refuses silent loss", () => {
  const para = (build: (p: Y.XmlElement) => void) => {
    const ydoc = new Y.Doc();
    const frag = docFragment(ydoc);
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    build(p);
    return { ydoc, frag };
  };
  const refuses = ({ ydoc, frag }: { ydoc: Y.Doc; frag: Y.XmlFragment }) => {
    const before = bytes(ydoc);
    expect(() => yXmlFragmentToDoc(frag)).toThrow(
      /can't read.*Nothing was changed/,
    );
    expect(bytes(ydoc)).toEqual(before);
  };

  it("an embed in text", () =>
    refuses(
      para((p) => {
        const x = new Y.XmlText();
        p.insert(0, [x]);
        x.insert(0, "hi");
        x.insertEmbed(2, { foo: 1 });
      }),
    ));

  it("an unknown element attribute", () =>
    refuses(
      para((p) => {
        const x = new Y.XmlText();
        p.insert(0, [x]);
        x.insert(0, "hi");
        p.setAttribute("secret", "s");
      }),
    ));

  it("an unknown mark attribute", () =>
    refuses(
      para((p) => {
        const x = new Y.XmlText();
        p.insert(0, [x]);
        x.insert(0, "hi", {
          link: { href: "https://e.example", title: null, extra: 1 },
        });
      }),
    ));

  it("a Y.XmlText directly under the root", () => {
    const ydoc = new Y.Doc();
    const frag = docFragment(ydoc);
    const x = new Y.XmlText();
    frag.insert(0, [x]);
    x.insert(0, "loose");
    refuses({ ydoc, frag });
  });

  it("reads every golden doc", () => {
    for (const [name, md] of Object.entries(GOLDEN)) {
      const ydoc = new Y.Doc();
      const { doc } = markdownToDoc(md);
      docToYXmlFragment(doc, docFragment(ydoc));
      const before = bytes(ydoc);
      expect(yXmlFragmentToDoc(docFragment(ydoc)).eq(doc), name).toBe(true);
      expect(bytes(ydoc)).toEqual(before);
    }
  });
});
