import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docFragment,
  docToYXmlFragment,
  markdownToDoc,
  yXmlFragmentToDoc,
} from "../src/index.ts";

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
