import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { FetchedRelease } from "../src/update/fetch.ts";

const dir = new URL("./fixtures/bus-release/", import.meta.url);
export const GOLDEN_VERSION = "0.186.0";
export const GOLDEN_NOW = new Date("2026-11-15T12:00:00Z");

export function golden(): FetchedRelease {
  const tarball = readFileSync(new URL("bus-0.186.0.tgz", dir));
  return {
    version: GOLDEN_VERSION,
    tarball,
    sha512: createHash("sha512").update(tarball).digest("hex"),
    attestations: JSON.parse(
      readFileSync(new URL("attestations.json", dir), "utf8"),
    ),
  };
}

export type RawEntry = {
  name: string;
  type?: string;
  data?: Buffer | string;
  prefix?: string;
  size?: number;
};

function oct(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, "0")}\0`;
}

export function tarBlock(e: RawEntry): Buffer {
  const data = Buffer.from(e.data ?? "");
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, "utf8");
  h.write(oct(0o644, 8), 100);
  h.write(oct(0, 8), 108);
  h.write(oct(0, 8), 116);
  h.write(oct(e.size ?? data.length, 12), 124);
  h.write(oct(0, 12), 136);
  h.write("        ", 148);
  h.write(e.type ?? "0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (e.prefix) h.write(e.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

export function makeTgz(
  entries: RawEntry[],
  opts: { noEnd?: boolean; trailer?: Buffer } = {},
): Buffer {
  const parts = entries.map(tarBlock);
  if (!opts.noEnd) parts.push(Buffer.alloc(1024));
  if (opts.trailer) parts.push(opts.trailer);
  return gzipSync(Buffer.concat(parts));
}
