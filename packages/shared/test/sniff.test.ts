import { describe, expect, it } from "vitest";
import {
  bytesHead,
  checkEntry,
  detectBinary,
  isUtf8Text,
  SNIFF_BYTES,
  textHead,
} from "../src/sniff.js";

const b = (...xs: number[]) => new Uint8Array(xs);
const s = (x: string) => new TextEncoder().encode(x);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

const SIGS: Array<[string, Uint8Array]> = [
  ["jpeg", b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)],
  ["png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  ["gif87a", s("GIF87a")],
  ["gif89a", s("GIF89a")],
  ["webp", cat(s("RIFF"), b(1, 2, 3, 4), s("WEBP"))],
  ["zip", b(0x50, 0x4b, 0x03, 0x04)],
  ["pdf", s("%PDF-1.7")],
  ["gzip", b(0x1f, 0x8b, 0x08)],
  ["mp4", cat(b(0, 0, 0, 0x18), s("ftypmp42"))],
  ["wasm", b(0x00, 0x61, 0x73, 0x6d)],
];

describe("sniff", () => {
  for (const [name, sig] of SIGS)
    it(`detects ${name}`, () => expect(detectBinary(sig)).not.toBeNull());

  it("text that merely starts like a signature is text", () => {
    for (const t of ["RIFF notes", "ID3 tags explained", "OggS?", "GIF8"])
      expect(detectBinary(s(t)), t).toBeNull();
  });

  it("isUtf8Text: NUL and invalid UTF-8 are not text", () => {
    expect(isUtf8Text(s("héllo"), false)).toBe(true);
    expect(isUtf8Text(b(0x61, 0x00, 0x62), false)).toBe(false);
    expect(isUtf8Text(b(0x61, 0xc3, 0x28), false)).toBe(false);
  });

  it("isUtf8Text: a multi-byte sequence cut at the boundary is allowed only when truncated", () => {
    const cut = s("ab€").subarray(0, 4); // € is 3 bytes: keep 2 of them
    expect(isUtf8Text(cut, true)).toBe(true);
    expect(isUtf8Text(cut, false)).toBe(false);
  });

  it("textHead / bytesHead: first 8 KB and whether there is more", () => {
    const big = "é".repeat(SNIFF_BYTES); // 2 bytes each
    const h = textHead(big);
    expect(h.head.length).toBe(SNIFF_BYTES);
    expect(h.truncated).toBe(true);
    expect(isUtf8Text(h.head, h.truncated)).toBe(true);
    expect(textHead("short").truncated).toBe(false);
    expect(bytesHead(new Uint8Array(SNIFF_BYTES + 1)).truncated).toBe(true);
    expect(bytesHead(new Uint8Array(SNIFF_BYTES)).truncated).toBe(false);
  });

  it("checkEntry: binary as code, markdown or html is refused", () => {
    for (const f of ["code", "markdown", "html"] as const) {
      expect(checkEntry("a", f, SIGS[0]?.[1] as Uint8Array, false)).toEqual({
        reason: "binary",
        message: expect.stringContaining("JPEG"),
      });
      expect(checkEntry("a", f, b(0x61, 0x00), false)?.reason).toBe("not_text");
      expect(checkEntry("a", f, s("# hi"), false)).toBeNull();
    }
  });

  it("checkEntry: a pdf must start with %PDF", () => {
    expect(checkEntry("d.pdf", "pdf", s("%PDF-1.4"), true)).toBeNull();
    expect(checkEntry("d.pdf", "pdf", s("hello"), false)?.reason).toBe(
      "not_pdf",
    );
  });

  it("checkEntry: a binary declared content type is refused for text formats", () => {
    for (const ct of [
      "image/jpeg",
      "audio/mpeg",
      "video/mp4",
      "application/octet-stream",
    ])
      expect(checkEntry("a.bin", "code", s("x"), false, ct)?.reason, ct).toBe(
        "content_type",
      );
    expect(
      checkEntry("a.svg", "code", s("<svg/>"), false, "image/svg+xml"),
    ).toBeNull();
    // contentTypeFor labels .py octet-stream: the bytes decide.
    expect(
      checkEntry(
        "a.py",
        "code",
        s("print(1)"),
        false,
        "application/octet-stream",
      ),
    ).toBeNull();
    expect(checkEntry("a.py", "code", s("x"), false, "image/png")?.reason).toBe(
      "content_type",
    );
  });

  it("messages have no em dash", () => {
    const all = [
      checkEntry("a", "code", SIGS[0]?.[1] as Uint8Array, false),
      checkEntry("a", "code", b(0), false),
      checkEntry("a", "pdf", s("x"), false),
      checkEntry("a", "code", s("x"), false, "image/png"),
    ];
    for (const r of all) expect(r?.message).not.toMatch(/—/);
  });
});
