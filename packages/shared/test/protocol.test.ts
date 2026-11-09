import { describe, expect, it } from "vitest";
import {
  LIMITS,
  METHOD_CAPABILITY,
  parseArtifactMessage,
  parseShellMessage,
  RUNTIME_METHODS,
} from "../src/index.js";

describe("parseArtifactMessage", () => {
  it("accepts valid call", () => {
    const m = {
      oa: 1,
      type: "call",
      id: "1",
      method: "db.get",
      params: { a: 1 },
    };
    expect(parseArtifactMessage(m)).toEqual(m);
  });
  it("accepts other valid types", () => {
    expect(
      parseArtifactMessage({ oa: 1, type: "hello", protocol: 1, kind: "html" }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({ oa: 1, type: "resize", height: 10 }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({ oa: 1, type: "pdf.text", version: 1, text: "x" }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: "data:image/webp;base64,AAAA",
      }),
    ).not.toBeNull();
  });
  it("rejects bad", () => {
    expect(
      parseArtifactMessage({ oa: 2, type: "resize", height: 1 }),
    ).toBeNull();
    expect(parseArtifactMessage({ oa: 1, type: "nope" })).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "call",
        id: "1",
        method: "db.drop",
        params: 1,
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({ oa: 1, type: "resize", height: 1, extra: 1 }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: "data:image/png;base64,AAAA",
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: `data:image/webp;base64,${"A".repeat(400_000)}`,
      }),
    ).toBeNull();
    expect(parseArtifactMessage(null)).toBeNull();
    expect(parseArtifactMessage("x")).toBeNull();
  });
});

describe("parseShellMessage", () => {
  it("parses welcome/result/event", () => {
    expect(
      parseShellMessage({
        oa: 1,
        type: "welcome",
        capabilities: { db: true, viewer: false, storage: false },
        viewer: null,
        theme: "dark",
      }),
    ).not.toBeNull();
    expect(
      parseShellMessage({ oa: 1, type: "result", id: "1", ok: true, value: 1 }),
    ).not.toBeNull();
    expect(
      parseShellMessage({
        oa: 1,
        type: "result",
        id: "1",
        ok: false,
        error: { code: "not_found", message: "x" },
      }),
    ).not.toBeNull();
    // #1834: the quote being written about travels with the thread set, as the
    // anchor a thread carries minus the version (a paint hint, not a record).
    const quote = {
      kind: "text",
      exact: "quick",
      prefix: "The ",
      suffix: " fox",
    };
    expect(
      parseShellMessage({
        oa: 1,
        type: "comments.set",
        threads: [],
        draft: quote,
      }),
    ).not.toBeNull();
    expect(
      parseShellMessage({
        oa: 1,
        type: "comments.set",
        threads: [],
        draft: { ...quote, kind: "note" },
      }),
    ).toBeNull();
    expect(parseShellMessage({ oa: 1, type: "thumb.request" })).not.toBeNull();
    expect(
      parseShellMessage({
        oa: 1,
        type: "result",
        id: "1",
        ok: false,
        error: { code: "zzz", message: "x" },
      }),
    ).toBeNull();
    expect(
      parseShellMessage({ oa: 1, type: "thumb.request", x: 1 }),
    ).toBeNull();
  });
});

describe("C4: db.resync event", () => {
  const ev = { oa: 1, type: "event", event: "db.resync", collection: "votes" };
  it("parses a strict db.resync", () => {
    expect(parseShellMessage(ev)).toEqual(ev);
  });
  it("rejects extra keys, a bad collection, or db.change fields", () => {
    expect(parseShellMessage({ ...ev, x: 1 })).toBeNull();
    expect(parseShellMessage({ ...ev, docs: [], deleted: [] })).toBeNull();
    expect(parseShellMessage({ ...ev, collection: "a b" })).toBeNull();
    expect(parseShellMessage({ ...ev, collection: "" })).toBeNull();
    const { collection: _c, ...noCol } = ev;
    expect(parseShellMessage(noCol)).toBeNull();
  });
});

describe("METHOD_CAPABILITY", () => {
  it("covers every method", () => {
    expect(Object.keys(METHOD_CAPABILITY).sort()).toEqual(
      [...RUNTIME_METHODS].sort(),
    );
    expect(METHOD_CAPABILITY["db.subscribe"]).toBe("db");
    expect(METHOD_CAPABILITY["viewer.get"]).toBe("viewer");
    expect(METHOD_CAPABILITY["storage.list"]).toBe("storage");
  });
});

describe("fix round 1: protocol bounds", () => {
  const prefix = "data:image/webp;base64,";
  it("thumb max size and alphabet", () => {
    const max = 4 * Math.ceil(LIMITS.thumbnailBytes / 3);
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: prefix + "A".repeat(max),
      }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: prefix + "A".repeat(max + 1),
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: `${prefix}<script>`,
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "thumb.ready",
        dataUrl: `${prefix}AA==`,
      }),
    ).not.toBeNull();
  });
  it("pdf.text is bounded in bytes", () => {
    const n = Math.floor(LIMITS.extractedTextBytes / 3);
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "pdf.text",
        version: 1,
        text: "漢".repeat(n),
      }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "pdf.text",
        version: 1,
        text: "漢".repeat(n + 1),
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "pdf.text",
        version: 1,
        text: "a".repeat(LIMITS.extractedTextBytes + 1),
      }),
    ).toBeNull();
  });
  it("hello and resize bounds", () => {
    expect(
      parseArtifactMessage({ oa: 1, type: "hello", protocol: 0, kind: "html" }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "hello",
        protocol: 1001,
        kind: "html",
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "hello",
        protocol: 1000,
        kind: "html",
      }),
    ).not.toBeNull();
    expect(
      parseArtifactMessage({ oa: 1, type: "resize", height: 100001 }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        oa: 1,
        type: "resize",
        height: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      parseArtifactMessage({ oa: 1, type: "resize", height: 100000 }),
    ).not.toBeNull();
  });
});
