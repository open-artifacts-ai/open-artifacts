import { existsSync, readFileSync, rmSync } from "node:fs";
import { mcpUrl } from "@oa/bus-adapter-claude-code";
import { BUS_CMD } from "@oa/bus-protocol";
import { parse } from "smol-toml";
import {
  CODEX_ENTRY,
  type Doc,
  headerKeys,
  joinLines,
  type Line,
  plain,
  readToml,
  same,
  scan,
  splitLines,
  str,
} from "./codex.ts";

/**
 * #1856: Codex's own remote entry cannot add a per-thread proof, and Codex
 * names a server's tools after its key. So install swaps the instance's
 * bearer-env entry, in its place and under its name, for the local proxy
 * (`oa-bus mcp-proxy --for codex`), editing that one table's own lines as text
 * and keeping the user's lines in this file (0600, in the bus home); uninstall
 * puts them back. The token stays where Codex reads it: a variable's name, in
 * the proxy's args and `env_vars`, never a value. An OAuth entry, or one with
 * another kind of credential, stays as it is: the proxy has no sign-in.
 * The daemon reads `name` from this file to attest the proxy's calls.
 */

/** The first Codex that sends `_meta.threadId` on MCP tool calls (#18093). */
export const CODEX_MIN_VERSION = "0.123.0";

const PROXY_CMD = "mcp-proxy";
/** The keys install writes for the proxy; they come off again to put the remote keys back. */
const OURS = ["command", "args", "env", "env_vars"] as const;
/** The remote entry's own keys the proxy takes over. */
const MOVED_KEYS = ["url", "bearer_token_env_var"] as const;
/** Remote or stdio keys the proxy cannot stand in for. */
const BLOCKING = [
  "bearer_token",
  "http_headers",
  "env_http_headers",
  "http_headers_helper",
  "oauth",
  "oauth_resource",
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
] as const;

export type CxEntryIo = {
  /** Codex's config.toml. */
  file: string;
  /** Where the moved lines are kept. */
  moved: string;
  /** Writes the config (atomically). */
  write: (text: string) => void;
  writeMoved: (data: string) => void;
  /** The proxy's command line start: [oa-bus] or [node, entry]. */
  busBin: string[];
  /** OA_BUS_HOME when the bus lives elsewhere. */
  busHome?: string;
};

type Moved = {
  name: string;
  origin: string;
  /** The user's lines for the keys install took over, verbatim. */
  lines: string[];
  /** The table's text as the user had it, and as install wrote it. */
  original: string;
  swapped: string;
};

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readMoved(path: string): Moved | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(v) &&
      typeof v.name === "string" &&
      typeof v.origin === "string" &&
      Array.isArray(v.lines) &&
      v.lines.every((l) => typeof l === "string") &&
      typeof v.original === "string" &&
      typeof v.swapped === "string"
    )
      return v as unknown as Moved;
  } catch {}
  return undefined;
}

/** Whether a moved entry is waiting to be put back. */
export const hasMoved = (io: CxEntryIo) => readMoved(io.moved) !== undefined;

const servers = (doc: Doc): Doc =>
  isRecord(doc.mcp_servers) ? doc.mcp_servers : {};

const isInstance = (e: Doc, origin: string) => {
  if (typeof e.url !== "string") return false;
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

/** An environment variable's name as Codex and a shell take it. */
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const keyOf = (line: string): string | undefined =>
  /^\s*("([^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/
    .exec(line)?.[1]
    ?.replace(/^["']|["']$/g, "");

/** The line range [from, to] of `[mcp_servers.<name>]`'s own keys (after its header, before the next table). */
function ownLines(
  lines: Line[],
  name: string,
): { header: number; from: number; to: number } | "none" | "many" {
  const kinds = scan(lines.map((l) => l.text));
  const heads: number[] = [];
  kinds.forEach((k, i) => {
    if (typeof k !== "object") return;
    try {
      const ks = headerKeys(k.header);
      if (ks.length === 2 && ks[0] === "mcp_servers" && ks[1] === name)
        heads.push(i);
    } catch {}
  });
  if (heads.length === 0) return "none";
  if (heads.length > 1) return "many";
  const header = heads[0] as number;
  let to = lines.length;
  for (let i = header + 1; i < lines.length; i++)
    if (typeof kinds[i] === "object") {
      to = i;
      break;
    }
  // Blank lines and comments before the next table stay with the next table.
  let end = to;
  while (end > header + 1 && kinds[end - 1] === "blank") end--;
  return { header, from: header + 1, to: end };
}

/** The table's own lines with `remove` keys cut and `add` lines put right after the header. */
function edit(
  text: string,
  name: string,
  remove: readonly string[],
  add: string[],
): { next: string; before: string; after: string } | undefined {
  const lines = splitLines(text);
  const at = ownLines(lines, name);
  if (typeof at === "string") return undefined;
  const eol = lines[at.header]?.eol || "\n";
  const body = lines.slice(at.from, at.to);
  const kept = body.filter((l) => {
    const k = keyOf(l.text);
    return k === undefined || !remove.includes(k);
  });
  const fresh = add.map((t) => ({ text: t, eol }));
  const span = (ls: Line[]) =>
    joinLines(lines.slice(at.header, at.header + 1).concat(ls));
  const out = [
    ...lines.slice(0, at.header + 1),
    ...fresh,
    ...kept,
    ...lines.slice(at.to),
  ];
  return {
    next: joinLines(out),
    before: span(body),
    after: span([...fresh, ...kept]),
  };
}

type Plan =
  | { kind: "none" }
  | { kind: "note"; note: string }
  | { kind: "ours"; name: string; entry: Doc }
  | { kind: "swap"; name: string; entry: Doc; tokenEnv: string };

const proxyArgs = (origin: string, tokenEnv: string) => [
  PROXY_CMD,
  "--instance",
  origin,
  "--for",
  "codex",
  "--token-env",
  tokenEnv,
];

/** Our own entry: a stdio server running `mcp-proxy --for codex` for this instance. */
function ourEntry(e: Doc, origin: string): { tokenEnv: string } | undefined {
  if (typeof e.command !== "string" || !Array.isArray(e.args)) return undefined;
  const a = e.args as unknown[];
  const i = a.lastIndexOf(PROXY_CMD);
  if (
    i < 0 ||
    a[i + 1] !== "--instance" ||
    a[i + 2] !== origin ||
    a[i + 3] !== "--for" ||
    a[i + 4] !== "codex" ||
    a[i + 5] !== "--token-env" ||
    typeof a[i + 6] !== "string"
  )
    return undefined;
  return { tokenEnv: a[i + 6] as string };
}

function plan(doc: Doc, origin: string): Plan {
  for (const [name, e] of Object.entries(servers(doc))) {
    if (name === CODEX_ENTRY || !isRecord(e)) continue;
    const ours = ourEntry(e, origin);
    if (ours) return { kind: "ours", name, entry: e };
    if (!isInstance(e, origin) || e.enabled === false) continue;
    const left = (why: string): Plan => ({
      kind: "note",
      note: `left the ${name} entry in the Codex config as it is: ${why} Its tools still work, but Codex won't show as its own session on pages.`,
    });
    try {
      mcpUrl(origin);
    } catch {
      return left(
        "oa-bus only passes on https addresses, or http to localhost.",
      );
    }
    const blocker = BLOCKING.find((k) => e[k] !== undefined);
    const tokenEnv = e.bearer_token_env_var;
    if (
      blocker !== undefined ||
      typeof tokenEnv !== "string" ||
      !VAR.test(tokenEnv)
    )
      return left(
        "it signs in with `codex mcp login` or another kind of token that oa-bus can't pass on.",
      );
    return { kind: "swap", name, entry: e, tokenEnv };
  }
  return { kind: "none" };
}

/**
 * Whether an entry waits to be swapped: its name, so the caller can check the
 * Codex version first (only then is it worth asking). A note comes back for
 * an entry that must stay.
 */
export function pendingEntry(
  io: CxEntryIo,
  origin: string,
): { name: string } | { note: string } | undefined {
  const p = plan(readToml(io.file).doc, origin);
  if (p.kind === "swap") return { name: p.name };
  if (p.kind === "note") return { note: p.note };
  return undefined;
}

const wantEntry = (io: CxEntryIo, origin: string, tokenEnv: string) => {
  const add = [
    `command = ${str(io.busBin[0] as string)}`,
    `args = [${[...io.busBin.slice(1), ...proxyArgs(origin, tokenEnv)].map(str).join(", ")}]`,
    `env_vars = [${str(tokenEnv)}]`,
    ...(io.busHome ? [`env = { OA_BUS_HOME = ${str(io.busHome)} }`] : []),
  ];
  return add;
};

/** The doc is as before but for this one table, which must read as `entry`. */
function checked(
  file: string,
  before: Doc,
  next: string,
  name: string,
  entry: unknown,
) {
  let doc: Doc;
  try {
    doc = readTomlText(next);
  } catch {
    throw new Error(`editing ${file} went wrong; left it untouched`);
  }
  const rest = (d: Doc) => {
    const c = plain(d) as Doc;
    if (isRecord(c.mcp_servers)) delete c.mcp_servers[name];
    return c;
  };
  if (!same(servers(doc)[name], plain(entry)) || !same(rest(doc), rest(before)))
    throw new Error(`editing ${file} went wrong; left it untouched`);
  return next;
}

const readTomlText = (text: string) => parse(text) as Doc;

export type Outcome = { notes: string[] };

/**
 * Swaps the instance's entry for the proxy, and brings an earlier proxy entry
 * up to date. The moved file is written before the config is. Throws for a
 * config that cannot be read. The caller has checked the Codex version.
 */
export function installEntry(io: CxEntryIo, origin: string): Outcome {
  const { text, doc } = readToml(io.file);
  const p = plan(doc, origin);
  if (p.kind === "note") return { notes: [p.note] };
  if (p.kind === "none") return { notes: [] };
  if (p.kind === "ours") {
    const tokenEnv = (ourEntry(p.entry, origin) as { tokenEnv: string })
      .tokenEnv;
    const e = edit(text, p.name, OURS, wantEntry(io, origin, tokenEnv));
    if (!e) return { notes: [] };
    if (e.next === text) return { notes: [] };
    const m = readMoved(io.moved);
    const want = { ...(plain(p.entry) as Doc) };
    for (const k of OURS) delete want[k];
    const fresh = plain(
      readTomlText(`[x]\n${wantEntry(io, origin, tokenEnv).join("\n")}\n`).x,
    ) as Doc;
    io.write(checked(io.file, doc, e.next, p.name, { ...want, ...fresh }));
    if (m)
      io.writeMoved(`${JSON.stringify({ ...m, swapped: e.after }, null, 2)}\n`);
    return { notes: [] };
  }
  const lines = splitLines(text);
  const at = ownLines(lines, p.name);
  if (typeof at === "string")
    return {
      notes: [
        `left the ${p.name} entry in ${io.file} as it is: it is written in a form oa-bus can't edit. Its tools still work, but Codex won't show as its own session on pages.`,
      ],
    };
  const mine = lines
    .slice(at.from, at.to)
    .filter((l) => MOVED_KEYS.includes(keyOf(l.text) as never))
    .map((l) => l.text);
  const e = edit(text, p.name, MOVED_KEYS, wantEntry(io, origin, p.tokenEnv));
  if (!e || mine.length !== MOVED_KEYS.length)
    return {
      notes: [
        `left the ${p.name} entry in ${io.file} as it is: it is written in a form oa-bus can't edit. Its tools still work, but Codex won't show as its own session on pages.`,
      ],
    };
  const want = { ...(plain(p.entry) as Doc) };
  for (const k of MOVED_KEYS) delete want[k];
  const fresh = plain(
    readTomlText(`[x]\n${wantEntry(io, origin, p.tokenEnv).join("\n")}\n`).x,
  ) as Doc;
  const next = checked(io.file, doc, e.next, p.name, { ...want, ...fresh });
  io.writeMoved(
    `${JSON.stringify({ name: p.name, origin, lines: mine, original: e.before, swapped: e.after } satisfies Moved, null, 2)}\n`,
  );
  io.write(next);
  return {
    notes: [
      `Codex now reaches Open Artifacts through oa-bus (the ${p.name} entry in ${io.file}). To undo, run ${BUS_CMD} uninstall: it puts your entry back.`,
    ],
  };
}

/**
 * Puts the user's lines back in the table, unless they have changed it into
 * something that is no longer our proxy. Returns whether it was put back.
 * Throws when the config cannot be read or written; the moved file stays then.
 */
export function restoreEntry(io: CxEntryIo): boolean {
  const m = readMoved(io.moved);
  if (!m) return false;
  let put = false;
  if (existsSync(io.file)) {
    const { text, doc } = readToml(io.file);
    const cur = servers(doc)[m.name];
    const lines = splitLines(text);
    const at = ownLines(lines, m.name);
    if (isRecord(cur) && ourEntry(cur, m.origin) && typeof at !== "string") {
      // Untouched since install: the user's own bytes go back. Edited: only
      // our keys come off and the user's lines go back in.
      const same_ = joinLines(lines.slice(at.header, at.to)) === m.swapped;
      const out = same_
        ? joinLines([
            ...lines.slice(0, at.header),
            ...linesOf(m.original),
            ...lines.slice(at.to),
          ])
        : edit(text, m.name, OURS, m.lines)?.next;
      if (out === undefined)
        throw new Error(
          `${io.file}: the ${m.name} table is not in a form oa-bus can edit`,
        );
      const want = { ...(plain(cur) as Doc) };
      for (const k of OURS) delete want[k];
      const orig = plain(readTomlText(`[x]\n${m.lines.join("\n")}\n`).x) as Doc;
      io.write(checked(io.file, doc, out, m.name, { ...want, ...orig }));
      put = true;
    }
  }
  rmSync(io.moved, { force: true });
  return put;
}

/** `text` as lines, without the empty piece after a final line ending. */
function linesOf(text: string): Line[] {
  const ls = splitLines(text);
  const last = ls.at(-1);
  if (last && last.text === "" && last.eol === "") ls.pop();
  return ls;
}
