import { describe, expect, it } from "vitest";
import {
  bytesHead,
  checkEntry,
  detectBinary,
  HEIC_MESSAGE,
  IMAGE_CONTENT_TYPES,
  imageKind,
  imageSize,
  isHeic,
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

  it("checkEntry: a declared content type is a hint; the bytes decide", () => {
    // Text passes whatever it was declared as.
    for (const ct of [
      "image/jpeg",
      "audio/mpeg",
      "video/mp2t",
      "application/octet-stream",
      "image/svg+xml",
    ])
      expect(checkEntry("a.ts", "code", s("x"), false, ct), ct).toBeNull();
    // Bytes that fail the text check: named by a binary declared type...
    for (const ct of ["image/png", "audio/mpeg", "video/mp4"])
      expect(checkEntry("a", "code", b(0x61, 0), false, ct)?.reason, ct).toBe(
        "content_type",
      );
    // ...but octet-stream claims nothing.
    expect(
      checkEntry("a", "code", b(0x61, 0), false, "application/octet-stream")
        ?.reason,
    ).toBe("not_text");
  });

  it("checkEntry: text that starts like a signature passes for text formats", () => {
    for (const t of ["GIF89a header", "%PDF-1.7 notes", "fLaC magic"])
      for (const f of ["code", "markdown", "html"] as const)
        expect(checkEntry("a", f, s(t), false), `${f} ${t}`).toBeNull();
  });

  it("checkEntry: a UTF-8 BOM and an empty file are text", () => {
    expect(
      checkEntry("a", "code", b(0xef, 0xbb, 0xbf, 0x61), false),
    ).toBeNull();
    expect(checkEntry("a", "markdown", b(), false)).toBeNull();
  });

  it("messages have no em dash", () => {
    const all = [
      checkEntry("a", "code", SIGS[0]?.[1] as Uint8Array, false),
      checkEntry("a", "code", b(0), false),
      checkEntry("a", "pdf", s("x"), false),
      checkEntry("a", "code", b(0), false, "image/png"),
    ];
    for (const r of all) expect(r?.message).not.toMatch(/—/);
  });
});

// A real 1x1 PNG, a 2x3 GIF, WebP headers and a JPEG with an APP0 then SOF0.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const GIF_2x3 = cat(s("GIF89a"), b(2, 0, 3, 0, 0, 0, 0));
const WEBP_VP8X = cat(
  s("RIFF"),
  b(0, 0, 0, 0),
  s("WEBPVP8X"),
  b(10, 0, 0, 0, 0, 0, 0, 0),
  b(99, 0, 0, 49, 0, 0),
);
const WEBP_VP8L = cat(
  s("RIFF"),
  b(0, 0, 0, 0),
  s("WEBPVP8L"),
  b(0, 0, 0, 0, 0x2f),
  // width 100 (99 = 0x63), height 50 (49): 14 bits each, LSB first.
  b(0x63, 0x40, 0x0c, 0x00),
);
const JPEG_640x480 = b(
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x04,
  0x00,
  0x00,
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08,
  0x01,
  0xe0,
  0x02,
  0x80,
  0x03,
);

describe("sniff: images", () => {
  it("imageKind and the served content types", () => {
    expect(imageKind("a/B.JPG")).toBe("jpeg");
    expect(imageKind("x.svg")).toBe("svg");
    expect(imageKind("x.heic")).toBeNull();
    expect(imageKind("x.toString")).toBeNull();
    expect(IMAGE_CONTENT_TYPES.svg).toBe("image/svg+xml");
  });

  it("checkEntry image: each extension needs its own signature", () => {
    expect(checkEntry("a.png", "image", PNG_1x1, false)).toBeNull();
    expect(checkEntry("a.gif", "image", GIF_2x3, false)).toBeNull();
    expect(checkEntry("a.webp", "image", WEBP_VP8X, false)).toBeNull();
    expect(checkEntry("a.jpg", "image", JPEG_640x480, false)).toBeNull();
    expect(checkEntry("a.jpeg", "image", JPEG_640x480, false)).toBeNull();
    const r = checkEntry("a.png", "image", JPEG_640x480, false);
    expect(r?.reason).toBe("not_image");
    expect(r?.message).toBe(
      `"a.png" is a JPEG image, so it can't be shown as a PNG image.`,
    );
    expect(checkEntry("a.gif", "image", s("GIF88a"), false)?.reason).toBe(
      "not_image",
    );
    const wave = cat(s("RIFF"), b(0, 0, 0, 0), s("WAVE"));
    expect(checkEntry("a.webp", "image", wave, false)?.reason).toBe(
      "not_image",
    );
    expect(checkEntry("a.bin", "image", PNG_1x1, false)?.reason).toBe(
      "not_image",
    );
  });

  it("checkEntry image: an svg is UTF-8 text with an <svg> root", () => {
    const ok = [
      `<svg xmlns="http://www.w3.org/2000/svg"/>`,
      `﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>`,
      `<!DOCTYPE svg [ <!ENTITY a "b>"> ]><svg\nviewBox="0 0 1 1">`,
      "  \n<svg>",
    ];
    for (const t of ok)
      expect(checkEntry("a.svg", "image", s(t), false), t).toBeNull();
    const bad = [
      "<html><svg></svg></html>",
      "<svgx>",
      "hello",
      "<!-- never closed <svg>",
      "",
    ];
    for (const t of bad)
      expect(checkEntry("a.svg", "image", s(t), false)?.reason, t).toBe(
        "not_svg",
      );
    const nul = b(0x3c, 0x73, 0x76, 0x67, 0x3e, 0);
    expect(checkEntry("a.svg", "image", nul, false)?.reason).toBe("not_svg");
    expect(checkEntry("a.svg", "image", PNG_1x1, false)?.reason).toBe(
      "not_svg",
    );
  });

  it("checkEntry image: a declared upload type must be the extension's", () => {
    expect(
      checkEntry("a.png", "image", PNG_1x1, false, "image/png"),
    ).toBeNull();
    expect(
      checkEntry(
        "a.svg",
        "image",
        s("<svg>"),
        false,
        "image/svg+xml; charset=utf-8",
      ),
    ).toBeNull();
    expect(
      checkEntry("a.png", "image", PNG_1x1, false, "application/octet-stream"),
    ).toBeNull();
    const r = checkEntry("a.png", "image", PNG_1x1, false, "image/jpeg");
    expect(r?.reason).toBe("content_type");
    expect(r?.message).toBe(
      `"a.png" was uploaded as image/jpeg, but a .png image is image/png.`,
    );
    expect(
      checkEntry("a.svg", "image", s("<svg>"), false, "text/html")?.reason,
    ).toBe("content_type");
  });

  it("isHeic: by name or by a HEIF ftyp brand", () => {
    expect(isHeic("IMG_1.HEIC")).toBe(true);
    expect(isHeic("x.heif")).toBe(true);
    for (const brand of [
      "heic",
      "heix",
      "hevc",
      "heim",
      "heis",
      "mif1",
      "msf1",
    ])
      expect(
        isHeic("x.jpg", cat(b(0, 0, 0, 0x18), s(`ftyp${brand}`))),
        brand,
      ).toBe(true);
    expect(isHeic("x.mp4", cat(b(0, 0, 0, 0x18), s("ftypmp42")))).toBe(false);
    expect(isHeic("x.avif", cat(b(0, 0, 0, 0x18), s("ftypavif")))).toBe(false);
    expect(isHeic("x.png", PNG_1x1)).toBe(false);
    expect(HEIC_MESSAGE).toBe(
      "HEIC photos can't be shown yet. Save as JPEG and upload again.",
    );
  });

  it("imageSize reads PNG, GIF, WebP and JPEG headers", () => {
    expect(imageSize(PNG_1x1)).toEqual({ width: 1, height: 1 });
    expect(imageSize(GIF_2x3)).toEqual({ width: 2, height: 3 });
    expect(imageSize(WEBP_VP8X)).toEqual({ width: 100, height: 50 });
    expect(imageSize(WEBP_VP8L)).toEqual({ width: 100, height: 50 });
    expect(imageSize(JPEG_640x480)).toEqual({ width: 640, height: 480 });
    expect(imageSize(b(0xff, 0xd8, 0xff))).toBeNull();
    expect(imageSize(s("<svg>"))).toBeNull();
  });

  it("image messages have no em dash", () => {
    for (const r of [
      checkEntry("a.png", "image", JPEG_640x480, false),
      checkEntry("a.svg", "image", s("x"), false),
      checkEntry("a.x", "image", s("x"), false),
      checkEntry("a.png", "image", PNG_1x1, false, "image/gif"),
    ])
      expect(r?.message).not.toMatch(/—/);
    expect(HEIC_MESSAGE).not.toMatch(/—/);
  });
});
