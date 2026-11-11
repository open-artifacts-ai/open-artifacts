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

describe("yXmlFragmentToDoc reads legal Yjs shapes", () => {
  function sync(a: Y.Doc, b: Y.Doc) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  }

  it("adjacent Y.XmlText from two clients", () => {
    const a = new Y.Doc();
    const p = new Y.XmlElement("paragraph");
    docFragment(a).insert(0, [p]);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ta = new Y.XmlText();
    (docFragment(a).get(0) as Y.XmlElement).insert(0, [ta]);
    ta.insert(0, "A");
    const tb = new Y.XmlText();
    (docFragment(b).get(0) as Y.XmlElement).insert(0, [tb]);
    tb.insert(0, "B");
    sync(a, b);
    expect((docFragment(a).get(0) as Y.XmlElement).length).toBe(2);
    for (const d of [a, b]) {
      const before = bytes(d);
      expect(["AB", "BA"]).toContain(
        yXmlFragmentToDoc(docFragment(d)).textContent,
      );
      expect(bytes(d)).toEqual(before);
    }
    expect(yXmlFragmentToDoc(docFragment(a)).textContent).toBe(
      yXmlFragmentToDoc(docFragment(b)).textContent,
    );
  });

  it("an empty Y.XmlText after concurrent deletes", () => {
    const a = new Y.Doc();
    const p = new Y.XmlElement("paragraph");
    docFragment(a).insert(0, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, "ab");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    t.delete(0, 1);
    ((docFragment(b).get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(1, 1);
    sync(a, b);
    const before = bytes(a);
    const doc = yXmlFragmentToDoc(docFragment(a));
    expect(doc.textContent).toBe("");
    expect(doc.childCount).toBe(1);
    expect(bytes(a)).toEqual(before);
  });

  it("an emptied Y.XmlText", () => {
    const { ydoc, frag } = (() => {
      const ydoc = new Y.Doc();
      const frag = docFragment(ydoc);
      const p = new Y.XmlElement("paragraph");
      frag.insert(0, [p]);
      const x = new Y.XmlText();
      p.insert(0, [x]);
      x.insert(0, "hi");
      x.delete(0, 2);
      return { ydoc, frag };
    })();
    const before = bytes(ydoc);
    expect(yXmlFragmentToDoc(frag).textContent).toBe("");
    expect(bytes(ydoc)).toEqual(before);
  });
});
