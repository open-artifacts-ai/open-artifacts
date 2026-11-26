// Real, decodable PNGs for the upload-resize tests (#3007): a fixture the
// Images binding can actually decode bytes of, at a size the test chooses.
// The fake images in picture-fixtures.ts only need to satisfy this repo's own
// parser; these need to satisfy a decoder, so the CRCs are right and the pixel
// data is a real zlib stream. Encoding is test-only (node:zlib).
import { deflateSync } from "node:zlib";

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const be32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const v of b) c = (CRC[(c ^ v) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (name: string, data: Uint8Array): Uint8Array => {
  const named = cat(enc(name), data);
  return cat(be32(data.length), named, be32(crc32(named)));
};

/** A deterministic byte stream: the same picture on every run. */
const noise = (seed: number) => {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s & 255;
  };
};

/**
 * A real 8-bit greyscale PNG of exactly w by h. Each pixel carries `bits` bits
 * of entropy (an alphabet of 2^bits values), so the encoded size lands near
 * `w * h * bits / 8` bytes instead of the few hundred a flat colour takes.
 * No ancillary chunks: the bytes this file's parser gives back are identical.
 */
export function greyPng(
  w: number,
  h: number,
  opts: { bits?: number; seed?: number } = {},
): Uint8Array {
  const mask = (1 << (opts.bits ?? 3)) - 1;
  const next = noise(opts.seed ?? 12345);
  const raw = new Uint8Array(h * (1 + w));
  for (let y = 0; y < h; y++) {
    const at = y * (1 + w);
    raw[at] = 0; // filter: none
    for (let x = 0; x < w; x++) raw[at + 1 + x] = next() & mask;
  }
  return cat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", cat(be32(w), be32(h), Uint8Array.of(8, 0, 0, 0, 0))),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  );
}
