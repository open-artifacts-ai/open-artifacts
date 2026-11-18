// Hand-built images for the comment picture tests: just enough structure for
// the parser, with metadata (EXIF, XMP, text chunks) a test can look for.
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const be16 = (n: number) => Uint8Array.of(n >> 8, n & 255);
const be32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
const le16 = (n: number) => Uint8Array.of(n & 255, n >> 8);
const le32 = (n: number) =>
  Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);

export const SECRET = "GPS-LAT-48.8584-LON-2.2945";

const seg = (marker: number, payload: Uint8Array) =>
  cat(Uint8Array.of(0xff, marker), be16(payload.length + 2), payload);

export function jpeg(w = 6, h = 4, withMeta = true): Uint8Array {
  return cat(
    Uint8Array.of(0xff, 0xd8),
    seg(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...(withMeta
      ? [
          seg(0xe1, enc(`Exif\0\0${SECRET}`)),
          seg(0xe1, enc(`http://ns.adobe.com/xap/1.0/\0${SECRET}`)),
          seg(0xed, enc(`Photoshop 3.0\0${SECRET}`)),
          seg(0xfe, enc(SECRET)),
        ]
      : []),
    seg(
      0xdb,
      Uint8Array.from({ length: 65 }, () => 1),
    ),
    seg(
      0xc0,
      cat(Uint8Array.of(8), be16(h), be16(w), Uint8Array.of(1, 1, 0x11, 0)),
    ),
    seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Uint8Array.of(0x12, 0x34, 0x56, 0x78),
    Uint8Array.of(0xff, 0xd9),
  );
}

const pngChunk = (name: string, data: Uint8Array) =>
  cat(be32(data.length), enc(name), data, be32(0));

export function png(w = 6, h = 4, withMeta = true): Uint8Array {
  return cat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", cat(be32(w), be32(h), Uint8Array.of(8, 2, 0, 0, 0))),
    ...(withMeta
      ? [
          pngChunk("tEXt", enc(`Comment\0${SECRET}`)),
          pngChunk("iTXt", enc(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`)),
          pngChunk("zTXt", enc(`Software\0\0${SECRET}`)),
          pngChunk("eXIf", enc(`MM\0*${SECRET}`)),
        ]
      : []),
    pngChunk("IDAT", Uint8Array.of(1, 2, 3, 4)),
    pngChunk("IEND", new Uint8Array()),
  );
}

export function gif(w = 6, h = 4, withMeta = true): Uint8Array {
  return cat(
    enc("GIF89a"),
    le16(w),
    le16(h),
    Uint8Array.of(0x00, 0, 0),
    ...(withMeta
      ? [
          // Comment extension.
          Uint8Array.of(0x21, 0xfe, SECRET.length),
          enc(SECRET),
          Uint8Array.of(0),
        ]
      : []),
    // Image descriptor, no local table, LZW min size 2, one data block.
    Uint8Array.of(0x2c, 0, 0, 0, 0, w & 255, 0, h & 255, 0, 0),
    Uint8Array.of(2, 2, 0x44, 0x01, 0),
    Uint8Array.of(0x3b),
  );
}

const riffChunk = (name: string, data: Uint8Array) =>
  cat(
    enc(name),
    le32(data.length),
    data,
    data.length & 1 ? Uint8Array.of(0) : new Uint8Array(),
  );

export function webp(w = 6, h = 4, withMeta = true): Uint8Array {
  const w24 = (n: number) =>
    Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255);
  const body = cat(
    riffChunk(
      "VP8X",
      cat(
        Uint8Array.of(withMeta ? 0x0c : 0),
        Uint8Array.of(0, 0, 0),
        w24(w - 1),
        w24(h - 1),
      ),
    ),
    // A lossless bitstream header: signature then w-1 and h-1 in 14 bits.
    riffChunk(
      "VP8L",
      cat(
        Uint8Array.of(0x2f),
        le32((w - 1) | ((h - 1) << 14)),
        Uint8Array.of(0, 0),
      ),
    ),
    ...(withMeta
      ? [
          riffChunk("EXIF", enc(`MM\0*${SECRET}`)),
          riffChunk("XMP ", enc(`<x:xmpmeta>${SECRET}</x:xmpmeta>`)),
        ]
      : []),
  );
  return cat(enc("RIFF"), le32(4 + body.length), enc("WEBP"), body);
}

export const heic = () =>
  cat(be32(24), enc("ftypheic"), Uint8Array.of(0, 0, 0, 0), enc("mif1heic"));
export const svg = () =>
  enc('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
export const contains = (bytes: Uint8Array, needle: string): boolean =>
  new TextDecoder("latin1").decode(bytes).includes(needle);
