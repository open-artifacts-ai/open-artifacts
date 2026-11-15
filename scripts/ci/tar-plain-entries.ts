// Refuses a gzipped tarball with any entry the bus updater's strict tar reader
// would refuse (#2552): only regular files and directories, so no pax or GNU
// extended headers, links, devices or fifos. Usage: tar-plain-entries.ts <tgz>
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const ok = new Set(["0", "\0", "5"]);

export function badTarEntries(tgz: Buffer): string[] {
  const tar = gunzipSync(tgz);
  const bad: string[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString("latin1", 0, 100).replace(/\0.*$/s, "");
    const type = String.fromCharCode(h[156] as number);
    if (!ok.has(type))
      bad.push(`${JSON.stringify(name)} (type ${JSON.stringify(type)})`);
    const size = Number.parseInt(
      h
        .toString("latin1", 124, 136)
        .replace(/[\0 ]+$/, "")
        .trim() || "0",
      8,
    );
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return bad;
}

if (process.argv[2]) {
  const bad = badTarEntries(readFileSync(process.argv[2]));
  if (bad.length) {
    console.error(
      `::error::tar entries the bus updater cannot read: ${bad.join(", ")}`,
    );
    process.exit(1);
  }
}
