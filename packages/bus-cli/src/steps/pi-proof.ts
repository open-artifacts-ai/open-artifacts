import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * #1856: Pi lets an `mcp.json` entry beat a server an extension registers
 * under the same name, and the extension must register the instance's /mcp
 * with the session's proof. So install moves the entry out of Pi's mcp.json
 * into this file (0600, in the bus home), which the extension reads and
 * registers; uninstall puts it back where it was. Nothing is copied: the
 * entry exists in one place at a time. Keep the name in step with the asset.
 */
export const PI_ENTRY_FILE = "pi-mcp-entry.json";

/**
 * #1856: omp has no per-server header hook; its extension wraps fetch for the
 * instance's /mcp only. Install writes the instance origin here (0600, in the
 * bus home) as `{ "origin": "https://..." }`; the extension is the only reader.
 * Keep the name in step with the asset.
 */
export const OMP_ORIGIN_FILE = "omp-mcp-origin.json";

/** The first Pi with `pi.registerMcpServer()`, as far as it was read (1.5.0's docs and loader). */
export const PI_MIN_VERSION = "1.5.0";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type PiEntryIo = {
  /** Pi's user-level mcp.json. */
  file: string;
  /** Where the moved entry is kept. */
  moved: string;
  write: (path: string, data: string, mode?: number) => void;
};

const BOM = "﻿";

/** A parsed mcp.json with what is needed to write it back as it was. */
type Config = { parsed: Rec; servers: Rec; indent: string; bom: boolean };

/** Null when the file is missing; throws when it is not an mcp.json Pi would read. */
function readConfig(file: string): Config | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
  )
    throw new Error(`${file}: expected an object with an "mcpServers" object`);
  return {
    parsed,
    servers: isRecord(parsed.mcpServers) ? parsed.mcpServers : {},
    indent: /^([ \t]+)\S/m.exec(text)?.[1] || "  ",
    bom,
  };
}

const writeConfig = (io: PiEntryIo, c: Config, servers: Rec) =>
  io.write(
    io.file,
    `${c.bom ? BOM : ""}${JSON.stringify({ ...c.parsed, mcpServers: servers }, null, c.indent)}\n`,
  );

/** The HTTP entry that points at this instance's /mcp; its name is the user's, so it is found by address. */
function findEntry(servers: Rec, origin: string): string | undefined {
  for (const [name, e] of Object.entries(servers)) {
    if (!isRecord(e) || typeof e.url !== "string") continue;
    if (
      e.type !== undefined &&
      e.type !== "http" &&
      e.type !== "streamable-http"
    )
      continue;
    try {
      const u = new URL(e.url);
      if (u.origin === origin && u.pathname.replace(/\/+$/, "") === "/mcp")
        return name;
    } catch {}
  }
  return undefined;
}

type Moved = { name: string; index: number; origin?: string; config: Rec };
function readMoved(path: string): Moved | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(v) &&
      typeof v.name === "string" &&
      typeof v.index === "number" &&
      isRecord(v.config)
    )
      return {
        name: v.name,
        index: v.index,
        ...(typeof v.origin === "string" ? { origin: v.origin } : {}),
        config: v.config,
      };
  } catch {}
  return undefined;
}

/**
 * The name of the entry install would move, or undefined when there is none
 * Throws for an mcp.json that cannot be read. An entry in mcp.json is always
 * pending, even with a file already moved: mcp.json wins (the user put it
 * back, or a crash left both).
 */
export function pendingEntry(
  io: PiEntryIo,
  origin: string,
): string | undefined {
  const c = readConfig(io.file);
  if (!c) return undefined;
  return findEntry(c.servers, origin);
}

/**
 * Moves the instance's entry out of Pi's mcp.json, replacing a file moved
 * earlier. The file it goes to is written first, so nothing is lost.
 */
export function moveEntry(io: PiEntryIo, origin: string): boolean {
  const c = readConfig(io.file);
  if (!c) return false;
  const name = findEntry(c.servers, origin);
  if (name === undefined) return false;
  const keys = Object.keys(c.servers);
  const moved: Moved = {
    name,
    index: keys.indexOf(name),
    origin,
    config: c.servers[name] as Rec,
  };
  io.write(io.moved, `${JSON.stringify(moved, null, 2)}\n`, 0o600);
  const { [name]: _gone, ...rest } = c.servers;
  writeConfig(io, c, rest);
  return true;
}

/**
 * Puts the entry back, in its old place. An entry the user has since put under
 * that name stays as theirs. Returns whether the entry was put back.
 */
export function restoreEntry(io: PiEntryIo): boolean {
  const m = readMoved(io.moved);
  if (!m) return false;
  const c = readConfig(io.file);
  let put = false;
  if (!c || c.servers[m.name] === undefined) {
    const entries = Object.entries(c?.servers ?? {});
    entries.splice(Math.min(Math.max(m.index, 0), entries.length), 0, [
      m.name,
      m.config,
    ]);
    writeConfig(
      io,
      c ?? { parsed: {}, servers: {}, indent: "  ", bom: false },
      Object.fromEntries(entries),
    );
    put = true;
  }
  rmSync(io.moved, { force: true });
  return put;
}
