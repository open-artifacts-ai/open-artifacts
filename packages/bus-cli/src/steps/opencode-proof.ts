import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type Doc,
  jsoncValue,
  parseJsonc,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";
import { mcpUrl } from "@oa/bus-adapter-opencode";
import { BUS_CMD } from "@oa/bus-protocol";

/**
 * #1856: OpenCode's own remote entry cannot add a per-session proof, and
 * OpenCode names a server's tools after its key. So install replaces the
 * instance's token-file entry, in its place and under its name, with the local
 * proxy (`oa-bus mcp-proxy`), and keeps the user's entry in this file (0600,
 * in the bus home); uninstall puts it back. An OAuth entry or one with another
 * kind of token stays as it is: the proxy has no sign-in of its own.
 */
export const OPENCODE_ENTRY_FILE = "opencode-mcp-entry.json";

type Path = (string | number)[];
const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `Bearer {file:PATH}`, as the connect card writes it; PATH is kept as written. */
const FILE_TOKEN = /^Bearer \{file:([^}\s]+)\}$/;
const PROXY_CMD = "mcp-proxy";

export type OcEntryIo = {
  /** OpenCode's config files that exist, in the order OpenCode reads them. */
  files: string[];
  /** Where the moved entry is kept. */
  moved: string;
  /** Reads a config file's text ("" when missing); throws when it is not JSONC. */
  read: (file: string) => string;
  /** Writes `next` only after `ok` accepts what it parses to. */
  save: (
    file: string,
    before: string,
    next: string,
    ok: (d: Doc) => boolean,
  ) => void;
  writeMoved: (data: string) => void;
  /** The user's home: `~/` in a token path means it. */
  home: string;
  /** The proxy's command line start: [oa-bus] or [node, entry]. */
  busBin: string[];
  /** OA_BUS_HOME when the bus lives elsewhere. */
  busHome?: string;
};

/** Where the instance's entries may be: `mcp.servers.<name>` and `mcp.<name>`. */
function candidates(text: string): { name: string; path: Path; entry: Doc }[] {
  const mcp = parseJsonc(text, "config").mcp;
  if (!isRecord(mcp)) return [];
  const out: { name: string; path: Path; entry: Doc }[] = [];
  if (isRecord(mcp.servers))
    for (const [name, e] of Object.entries(mcp.servers))
      if (isRecord(e))
        out.push({ name, path: ["mcp", "servers", name], entry: e });
  for (const [name, e] of Object.entries(mcp))
    if (name !== "servers" && isRecord(e))
      out.push({ name, path: ["mcp", name], entry: e });
  return out;
}

const isInstance = (e: Doc, origin: string) => {
  if (e.type !== "remote" || typeof e.url !== "string") return false;
  try {
    const u = new URL(e.url);
    return (
      u.origin === origin &&
      u.pathname.replace(/\/+$/, "") === "/mcp" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

/** The token file an entry reads, when it is the one form the proxy can use. */
function tokenFileOf(e: Doc): string | undefined {
  if (e.oauth !== false || !isRecord(e.headers)) return undefined;
  const auth = Object.entries(e.headers).filter(
    ([k]) => k.toLowerCase() === "authorization",
  );
  if (auth.length !== 1 || Object.keys(e.headers).length !== 1)
    return undefined;
  const v = auth[0]?.[1];
  return typeof v === "string" ? FILE_TOKEN.exec(v)?.[1] : undefined;
}

/** What a remote entry has that a local one does not. Everything else (timeout, enabled, ...) is kept. */
const REMOTE_ONLY = new Set(["type", "url", "headers", "oauth"]);

/** OpenCode reads `{file:X}` with `~/` expanded and a relative path from the config file's folder. */
export function resolveTokenFile(x: string, configFile: string, home: string) {
  if (x === "~") return home;
  if (x.startsWith("~/")) return join(home, x.slice(2));
  return isAbsolute(x) ? x : resolve(dirname(configFile), x);
}

/** The proxy entry for `entry`: its other fields stay, its command and environment are ours. */
const proxyEntry = (
  io: OcEntryIo,
  origin: string,
  tokenFile: string,
  entry: Doc,
): Doc => {
  const kept = Object.fromEntries(
    Object.entries(entry).filter(
      ([k]) => !REMOTE_ONLY.has(k) && k !== "command",
    ),
  );
  const env = isRecord(entry.environment) ? entry.environment : undefined;
  return {
    type: "local",
    command: [
      ...io.busBin,
      PROXY_CMD,
      "--instance",
      origin,
      "--token-file",
      tokenFile,
    ],
    ...kept,
    ...(io.busHome || env
      ? {
          environment: {
            ...env,
            ...(io.busHome ? { OA_BUS_HOME: io.busHome } : {}),
          },
        }
      : {}),
  };
};

/** Our own entry: a local server running `mcp-proxy` for this instance. */
function ourEntry(e: Doc, origin: string): { tokenFile: string } | undefined {
  if (e.type !== "local" || !Array.isArray(e.command)) return undefined;
  const c = e.command as unknown[];
  const i = c.lastIndexOf(PROXY_CMD);
  if (i < 0 || c[i + 1] !== "--instance" || c[i + 2] !== origin)
    return undefined;
  const f = c[i + 4];
  return c[i + 3] === undefined ||
    c[i + 3] !== "--token-file" ||
    typeof f !== "string"
    ? undefined
    : { tokenFile: f };
}

type Moved = { file: string; path: Path; origin: string; config: Doc };
function readMoved(path: string): Moved | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(v) &&
      typeof v.file === "string" &&
      Array.isArray(v.path) &&
      typeof v.origin === "string" &&
      isRecord(v.config)
    )
      return v as unknown as Moved;
  } catch {}
  return undefined;
}

export type Outcome = { notes: string[] };

/**
 * Puts the proxy in place of the instance's token-file entry, and brings an
 * earlier proxy entry up to date. Handles the first match in OpenCode's own
 * (global) config files only; a project's opencode.json is never touched. The moved file
 * is written before the config is. Throws for a config that cannot be read.
 */
export function installEntry(io: OcEntryIo, origin: string): Outcome {
  const notes: string[] = [];
  for (const file of io.files) {
    const text = io.read(file);
    for (const { name, path, entry } of candidates(text)) {
      const ours = ourEntry(entry, origin);
      if (ours) {
        const want = proxyEntry(io, origin, ours.tokenFile, entry);
        if (JSON.stringify(entry) !== JSON.stringify(want))
          io.save(file, text, setJsoncValue(text, path, want), (d) =>
            sameAt(d, path, want),
          );
        return { notes };
      }
      if (!isInstance(entry, origin) || entry.enabled === false) continue;
      try {
        mcpUrl(origin);
      } catch {
        notes.push(
          `left the ${name} entry in ${file} as it is: oa-bus only passes on https addresses, or http on this machine. Its tools still work, but OpenCode won't show as its own session on pages.`,
        );
        continue;
      }
      const tokenFile = tokenFileOf(entry);
      if (tokenFile === undefined) {
        notes.push(
          `left the ${name} entry in ${file} as it is: it signs in with \`opencode mcp auth\` or another kind of token that oa-bus can't pass on. Its tools still work, but OpenCode won't show as its own session on pages.`,
        );
        continue;
      }
      const want = proxyEntry(
        io,
        origin,
        resolveTokenFile(tokenFile, file, io.home),
        entry,
      );
      io.writeMoved(
        `${JSON.stringify({ file, path, origin, config: entry } satisfies Moved, null, 2)}\n`,
      );
      io.save(file, text, setJsoncValue(text, path, want), (d) =>
        sameAt(d, path, want),
      );
      notes.push(
        `OpenCode now reaches Open Artifacts through oa-bus (the ${name} entry in ${file}). To undo, run ${BUS_CMD} uninstall: it puts your entry back.`,
      );
      return { notes };
    }
  }
  return { notes };
}

const sameAt = (d: Doc, path: Path, want: unknown) => {
  let v: unknown = d;
  for (const k of path) v = isRecord(v) ? v[k] : undefined;
  return JSON.stringify(v) === JSON.stringify(want);
};

/**
 * Puts the user's entry back where it was, unless they have changed that
 * entry since. Returns whether it was put back. Throws when the config cannot
 * be read or written; the moved file stays then, so nothing is lost.
 */
export function restoreEntry(io: OcEntryIo): boolean {
  const m = readMoved(io.moved);
  if (!m) return false;
  let put = false;
  if (existsSync(m.file)) {
    const text = io.read(m.file);
    const now = jsoncValue(text, m.path);
    if (isRecord(now) && ourEntry(now, m.origin)) {
      io.save(m.file, text, setJsoncValue(text, m.path, m.config), (d) =>
        sameAt(d, m.path, m.config),
      );
      put = true;
    }
  }
  rmSync(io.moved, { force: true });
  return put;
}

/** Whether a moved entry is waiting to be put back. */
export const hasMoved = (io: OcEntryIo) => readMoved(io.moved) !== undefined;

/**
 * The first program a proxy entry runs that is not there: an absolute path
 * that does not exist, or a bare name not on PATH. Undefined when the entry is
 * absent or fine.
 */
export function proxyProgramMissing(
  entry: Doc,
  origin: string | undefined,
  which: (cmd: string) => boolean,
): string | undefined {
  if (!Array.isArray(entry.command)) return undefined;
  const c = entry.command as unknown[];
  const i = c.lastIndexOf(PROXY_CMD);
  if (i < 0 || c[i + 1] !== "--instance" || typeof c[i + 2] !== "string")
    return undefined;
  if (origin !== undefined && c[i + 2] !== origin) return undefined;
  for (const part of c.slice(0, i)) {
    if (typeof part !== "string") continue;
    if (isAbsolute(part) ? !existsSync(part) : !which(part)) return part;
  }
  return undefined;
}

/** Every proxy entry in `text`, by name. */
export function proxyEntries(text: string): { name: string; entry: Doc }[] {
  return candidates(text)
    .filter(
      ({ entry }) =>
        Array.isArray(entry.command) &&
        (entry.command as unknown[]).includes(PROXY_CMD),
    )
    .map(({ name, entry }) => ({ name, entry }));
}
