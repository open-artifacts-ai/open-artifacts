// A strict reader for the one kind of tarball `npm pack` makes. It accepts
// regular files and directories under package/, and refuses everything else.
// It never touches the disk; `unpackTo` writes what it returned.
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { ReleaseError } from "./errors.ts";
import { LIMITS } from "./pins.ts";

export type TarEntry = { path: string; type: "file" | "dir"; data: Buffer };

const BLOCK = 512;
// What pack-npm's tar-listing check allows (release-please.yml).
const FILE_RE = /^package\/(package\.json|LICENSE|dist\/.+|assets\/.+)$/;
const DIR_RE = /^package(\/(dist|assets)(\/.+)?)?$/;

function bad(detail: string): never {
  throw new ReleaseError("bad_tar", detail);
}

function cstr(block: Buffer, off: number, len: number): string {
  const slice = block.subarray(off, off + len);
  const nul = slice.indexOf(0);
  const used = nul === -1 ? slice : slice.subarray(0, nul);
  // Anything after the first NUL must be NUL.
  if (nul !== -1 && slice.subarray(nul).some((b) => b !== 0))
    bad("junk after NUL in header");
  return used.toString("utf8");
}

function octal(block: Buffer, off: number, len: number): number {
  const raw = block
    .subarray(off, off + len)
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (!/^[0-7]+$/.test(raw)) bad("bad number in header");
  const n = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(n)) bad("number too large");
  return n;
}

function checkName(name: string): void {
  if (name.length === 0 || name.length > 512) bad("bad name length");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f\\]/.test(name)) bad("control or backslash in name");
  if (name.startsWith("/") || name.endsWith("/"))
    bad("absolute or trailing slash");
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") bad("bad path segment");
    if (seg === ".live") bad("reserved name");
  }
}

export function readTarball(gz: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, {
      maxOutputLength: LIMITS.maxUnpackedBytes + 64 * BLOCK,
    });
  } catch {
    return bad("not a gzip stream within the size cap");
  }
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  let total = 0;
  let off = 0;
  let ended = false;
  while (off < tar.length) {
    if (off + BLOCK > tar.length) bad("truncated header");
    const block = tar.subarray(off, off + BLOCK);
    if (block.every((b) => b === 0)) {
      ended = true;
      break;
    }
    // Checksum: sum of the header with the checksum field read as spaces.
    const want = octal(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++)
      sum += i >= 148 && i < 156 ? 32 : (block[i] as number);
    if (sum !== want) bad("header checksum");
    const magic = block.subarray(257, 263).toString("latin1");
    if (magic !== "ustar\0" && magic !== "ustar ") bad("not ustar");
    const typeflag = String.fromCharCode(block[156] as number);
    const size = octal(block, 124, 12);
    const prefix = cstr(block, 345, 155);
    const base = cstr(block, 0, 100);
    const name = prefix ? `${prefix}/${base}` : base;
    let type: "file" | "dir";
    if (typeflag === "0" || typeflag === "\0") type = "file";
    else if (typeflag === "5") type = "dir";
    else return bad(`entry type ${JSON.stringify(typeflag)} not allowed`);
    if (type === "dir" && size !== 0) bad("directory with data");
    if (entries.length >= LIMITS.maxEntries) bad("too many entries");
    // Directory names may carry one trailing slash in a tar; strip it for checks.
    const clean =
      type === "dir" && name.endsWith("/") ? name.slice(0, -1) : name;
    checkName(clean);
    if (type === "file" ? !FILE_RE.test(clean) : !DIR_RE.test(clean))
      bad("path not allowed");
    if (seen.has(clean)) bad("duplicate entry");
    const folded = clean.toLowerCase();
    if (seenFolded.has(folded)) bad("case-colliding entry");
    seen.add(clean);
    seenFolded.add(folded);
    if (size > LIMITS.maxFileBytes) bad("file too large");
    total += size;
    if (total > LIMITS.maxUnpackedBytes) bad("unpacked size over the cap");
    const start = off + BLOCK;
    const end = start + size;
    if (end > tar.length) bad("truncated data");
    entries.push({
      path: clean,
      type,
      data: Buffer.from(tar.subarray(start, end)),
    });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended) bad("no end-of-archive marker");
  for (let i = off; i < tar.length; i++)
    if (tar[i] !== 0) bad("data after end-of-archive");
  // A path may not be both a file and a directory prefix.
  for (const e of entries) {
    if (e.type === "file") {
      const prefix = `${e.path}/`;
      for (const o of entries)
        if (o.path.startsWith(prefix)) bad("file used as a directory");
    }
  }
  return entries;
}

/**
 * Writes entries (leading `package/` removed) into `dest`, which must be an
 * existing empty directory made by the caller. Files are created O_EXCL with
 * mode 0600, directories 0700; nothing resolves outside `dest`. Never creates
 * `.live` (readTarball refuses the name) and never runs anything.
 */
export function unpackTo(entries: TarEntry[], dest: string): void {
  const root = realpathSync(dest);
  const within = (p: string): string => {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
      bad("path escapes the destination");
    }
    return abs;
  };
  for (const e of entries) {
    const rel = e.path === "package" ? "" : e.path.slice("package/".length);
    if (rel === "") continue;
    const target = within(rel);
    if (e.type === "dir") {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // The parent must still be inside root once links are resolved.
    const parent = realpathSync(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep))
      bad("parent escapes the destination");
    const fd = openSync(
      join(parent, basename(target)),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let n = 0;
      while (n < e.data.length) n += writeSync(fd, e.data, n);
    } finally {
      closeSync(fd);
    }
  }
}
