import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexAppBin, resolveCodexBin } from "@oa/bus-daemon";
import { parse } from "smol-toml";

/**
 * Codex (C26e). Its MCP servers live in `${CODEX_HOME:-~/.codex}/config.toml`,
 * which the desktop app also writes (`[desktop]`), so install edits only our
 * own table, as text, and never re-serializes the file. Install owns that
 * table whole: keys added to it by hand do not survive the next install.
 * The wake binary's file and lookup are the daemon's (transports/codex.ts).
 */

/**
 * Our entry's name. The tool namespace (`mcp__oa_bus`) comes from it, and
 * the daemon's attestation looks for that namespace in the rollout.
 */
export const CODEX_ENTRY = "oa_bus";

type Env = Record<string, string | undefined>;

/** `${CODEX_HOME:-~/.codex}`, absolute. */
export const codexHome = (home: string, env: Env): string =>
  env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");

/** CODEX_HOME when it is set and not the default: the daemon's service needs it. */
export function codexHomeEnv(
  home: string,
  env: Env,
): { CODEX_HOME: string } | Record<string, never> {
  const dir = codexHome(home, env);
  return dir === join(home, ".codex") ? {} : { CODEX_HOME: dir };
}

export const codexConfig = (home: string, env: Env): string =>
  join(codexHome(home, env), "config.toml");

/** Codex is here: on PATH, its home exists, or the app is installed. */
export function hasCodex(o: {
  home: string;
  env: Env;
  which: (cmd: string) => boolean;
  /** The app's bundle; undefined looks for none. */
  app?: string;
}): boolean {
  if (o.which("codex")) return true;
  try {
    lstatSync(codexHome(o.home, o.env));
    return true;
  } catch {}
  return o.app !== undefined && codexAppBin(o.app) !== undefined;
}

/**
 * The `codex` the daemon would wake threads with, by the daemon's own lookup:
 * the pin in `configFile` (when given), PATH, then the app (undefined: none).
 */
export const findCodexBin = (o: {
  configFile?: string;
  path?: string;
  app?: string;
}): string | undefined => resolveCodexBin({ ...o, app: o.app ?? null })?.path;

export type CodexEntry = {
  command: string;
  args: string[];
  default_tools_approval_mode: "approve";
  env?: Record<string, string>;
};

type Doc = Record<string, unknown>;

/** The config as text and parsed: missing is empty, invalid TOML throws. */
export function readToml(path: string): { text: string; doc: Doc } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", doc: {} };
    throw e;
  }
  try {
    return { text, doc: parse(text) as Doc };
  } catch {
    throw new Error(`${path} is not valid TOML`);
  }
}

/** Plain JSON values: smol-toml's tables have no prototype. */
const plain = (v: unknown): unknown =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));

const servers = (doc: Doc) => doc.mcp_servers as Doc | undefined;
/** Our entry as parsed, if any. */
export const codexEntryOf = (doc: Doc): unknown =>
  plain(servers(doc)?.[CODEX_ENTRY]);

/**
 * The entry install writes: the CLI's argv with `mcp codex`, tool approval
 * on (D3), and a moved Open Artifacts bus home in its env, since Codex filters the
 * server's environment.
 */
export function codexEntry(
  busBin: string[],
  home: string,
  busHome: string,
): CodexEntry {
  const ob = resolve(busHome);
  return {
    command: busBin[0] as string,
    args: [...busBin.slice(1), "mcp", "codex"],
    ...(ob === join(home, ".oa-bus") ? {} : { env: { OA_BUS_HOME: ob } }),
    default_tools_approval_mode: "approve",
  };
}

/**
 * Whether the parsed entry reads as `renderEntry(want)` does, env included.
 * Without a known command (`binKnown` false), only the command and the args
 * before `mcp codex` may differ.
 */
export function entryIs(
  entry: unknown,
  want: CodexEntry,
  binKnown: boolean,
): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const rendered = plain(parse(renderEntry(want).join("\n")).mcp_servers);
  const w = (rendered as Doc)[CODEX_ENTRY] as Doc;
  if (binKnown) return same(entry, w);
  const e = entry as Doc;
  const args = e.args;
  return (
    typeof e.command === "string" &&
    Array.isArray(args) &&
    args.slice(-2).join(" ") === "mcp codex" &&
    same({ ...e, command: "", args: [] }, { ...w, command: "", args: [] })
  );
}

const table = (v: unknown): Doc | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Doc)
    : undefined;

/**
 * Whether the config lets a thread write CODEX_HOME, which the attestation
 * assumes only Codex writes (docs/probes/codex.md §2): the active profile's
 * `sandbox_mode`, else the top-level one, is `danger-full-access`, or a
 * `[sandbox_workspace_write] writable_roots` entry overlaps the Codex home,
 * as a parent of it or a folder inside it.
 * Command-line `--yolo` and `-s danger-full-access` are not in the config,
 * so they are not seen.
 */
export function sandboxRisk(
  doc: Doc,
  home: string,
  codexDir: string,
): "full-access" | "writable-root" | undefined {
  const name = doc.profile;
  const profile =
    typeof name === "string" ? table(table(doc.profiles)?.[name]) : undefined;
  const mode = profile?.sandbox_mode ?? doc.sandbox_mode;
  if (mode === "danger-full-access") return "full-access";
  if (mode === "read-only") return undefined;
  const roots = [doc, profile].flatMap((d) => {
    const r = table(d?.sandbox_workspace_write)?.writable_roots;
    return Array.isArray(r) ? r.filter((x) => typeof x === "string") : [];
  });
  const covers = (root: string) => {
    const r = resolve(
      root === "~"
        ? home
        : root.startsWith("~/")
          ? join(home, root.slice(2))
          : root,
    );
    // Either way round: a root inside the home (sessions/) reaches the
    // rollouts the call check reads.
    return (
      r === "/" ||
      codexDir === r ||
      codexDir.startsWith(`${r}/`) ||
      r.startsWith(`${codexDir}/`)
    );
  };
  return roots.some(covers) ? "writable-root" : undefined;
}

const str = (s: string) => JSON.stringify(s);
const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : str(k));

/** Our table as TOML lines. */
export function renderEntry(e: CodexEntry): string[] {
  const env = Object.entries(e.env ?? {});
  return [
    `[mcp_servers.${CODEX_ENTRY}]`,
    `command = ${str(e.command)}`,
    `args = [${e.args.map(str).join(", ")}]`,
    ...(env.length
      ? [`env = { ${env.map(([k, v]) => `${key(k)} = ${str(v)}`).join(", ")} }`]
      : []),
    `default_tools_approval_mode = ${str(e.default_tools_approval_mode)}`,
  ];
}

/**
 * Each line's kind, outside strings: a table header (and its dotted name),
 * blank or comment, or other. A multi-line string's lines are "other".
 */
function scan(lines: string[]): ("blank" | "other" | { header: string })[] {
  let open: '"""' | "'''" | undefined;
  return lines.map((line) => {
    const startsInString = open !== undefined;
    let i = 0;
    let code = false;
    while (i < line.length) {
      if (open) {
        // A basic string's escapes (`\"`) never close it; a literal has none.
        if (open === '"""' && line[i] === "\\") {
          i += 2;
          continue;
        }
        if (!line.startsWith(open, i)) {
          i++;
          continue;
        }
        // A closing run may carry up to two more quotes of the string.
        i += 3;
        while (line[i] === open[0]) i++;
        open = undefined;
        continue;
      }
      const c = line[i] as string;
      if (c === "#") break;
      if (c === '"' || c === "'") {
        code = true;
        const triple = line.startsWith(c.repeat(3), i);
        if (triple) {
          open = c === '"' ? '"""' : "'''";
          i += 3;
          continue;
        }
        i++;
        while (i < line.length && line[i] !== c)
          i += c === '"' && line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c !== " " && c !== "\t" && c !== "\r") code = true;
      i++;
    }
    if (startsInString) return "other";
    const m = /^[ \t]*\[\[?([^\]]*)\]\]?[ \t]*(#.*)?$/.exec(line);
    if (m) return { header: m[1] as string };
    return code ? "other" : "blank";
  });
}

/** A header's dotted name as keys: `mcp_servers . "oa_bus"` is `["mcp_servers","oa_bus"]`. */
function headerKeys(name: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  while (re.lastIndex < name.length) {
    const m = re.exec(name);
    if (!m) break;
    out.push(
      m[1] !== undefined
        ? (JSON.parse(`"${m[1]}"`) as string)
        : (m[2] ?? m[3] ?? ""),
    );
    if (!m[4]) break;
  }
  return out;
}

/** Whether a header names our table or one of its subtables. */
const ours = (header: string) => {
  try {
    const keys = headerKeys(header);
    return keys[0] === "mcp_servers" && keys[1] === CODEX_ENTRY;
  } catch {
    // An escape JSON does not share (`\U…`): not a name we write.
    return false;
  }
};

/**
 * Every run of lines our table or its subtables span, header included,
 * through the last line of content: comments and blanks before the next
 * table belong to that table. Install owns them all, so a subtable set
 * apart from ours (`[mcp_servers.oa_bus.env]` after `[desktop]`) is one too.
 */
function spans(lines: string[]): { from: number; to: number }[] {
  const kinds = scan(lines);
  const out: { from: number; to: number }[] = [];
  for (let from = 0; from < lines.length; from++) {
    const k = kinds[from];
    if (typeof k !== "object" || !ours(k.header)) continue;
    let to = from;
    let i = from + 1;
    for (; i < lines.length; i++) {
      const n = kinds[i];
      if (typeof n === "object" && !ours(n.header)) break;
      if (n !== "blank") to = i;
    }
    out.push({ from, to });
    from = i - 1;
  }
  return out;
}

/** Everything but our entry, for the guard; an emptied `mcp_servers` counts as absent. */
function others(doc: Doc): unknown {
  const rest = plain(doc) as Doc;
  const s = rest.mcp_servers as Doc | undefined;
  if (s) {
    delete s[CODEX_ENTRY];
    if (Object.keys(s).length === 0) delete rest.mcp_servers;
  }
  return rest;
}

/** Tables with their keys sorted, all the way down: order is not a value. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : typeof v === "object" && v !== null
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Doc)[k])]),
        )
      : v;

/** Equal values, whatever order a table's keys were parsed in. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The guard on every edit: the result parses, our entry is `want` (or gone),
 * and everything else reads exactly as before. Else nothing is written.
 */
function checked(path: string, before: Doc, next: string, want: unknown) {
  let doc: Doc;
  try {
    doc = parse(next) as Doc;
  } catch {
    throw new Error(`editing ${path} went wrong; left it untouched`);
  }
  if (
    !same(codexEntryOf(doc), plain(want)) ||
    !same(others(doc), others(before))
  )
    throw new Error(`editing ${path} went wrong; left it untouched`);
  return next;
}

/** One line: its text, and its own ending (`\n`, `\r\n`, or none at the end). */
type Line = { text: string; eol: string };

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  const re = /\r?\n/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ text: text.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), eol: "" });
  return out;
}

const joinLines = (lines: Line[]) => lines.map((l) => l.text + l.eol).join("");

/** The ending new lines get: the file's last one, else LF. */
const eolOf = (lines: Line[]) =>
  [...lines].reverse().find((l) => l.eol)?.eol ?? "\n";

const blank = (l: Line | undefined) => l !== undefined && l.text.trim() === "";

/**
 * `lines` without the span, and the blank lines after it: what install's
 * append added comes off again, and a table that follows keeps its blank
 * line. A span that ends the file takes the blank lines before it too.
 */
function cut(lines: Line[], at: { from: number; to: number }): Line[] {
  let to = at.to + 1;
  while (to < lines.length - 1 && blank(lines[to])) to++;
  let from = at.from;
  if (to >= lines.length - 1) while (from > 0 && blank(lines[from - 1])) from--;
  return [...lines.slice(0, from), ...lines.slice(to)];
}

/**
 * The config with our table set to `entry`: replaced in place, else appended.
 * Every byte outside our table is kept, each line's ending included.
 */
export function upsertCodexEntry(
  path: string,
  text: string,
  doc: Doc,
  entry: CodexEntry,
): string {
  return withBom(text, (body) => upsert(path, body, doc, entry));
}

/**
 * Runs `edit` on the text after a leading UTF-8 BOM, which would hide a
 * header on the first line, and puts the BOM back in front.
 */
function withBom(text: string, edit: (body: string) => string): string {
  if (!text.startsWith(BOM)) return edit(text);
  const body = text.slice(BOM.length);
  const next = edit(body);
  return next === body ? text : BOM + next;
}
const BOM = "\uFEFF";

function upsert(
  path: string,
  text: string,
  doc: Doc,
  entry: CodexEntry,
): string {
  let lines = splitLines(text);
  const all = spans(lines.map((l) => l.text));
  const at = all[0];
  const block = renderEntry(entry);
  let next: string;
  if (at) {
    const mine = lines.slice(at.from, at.to + 1).map((l) => l.text);
    if (all.length === 1 && same(block, mine)) return text;
    // Ours is the first span; the rest go, last first, so indexes hold.
    for (const later of all.slice(1).reverse()) lines = cut(lines, later);
    // New lines end as our header did; the last keeps the span's own ending.
    const eol = lines[at.from]?.eol || eolOf(lines);
    const end = lines[at.to]?.eol ?? "";
    next = joinLines([
      ...lines.slice(0, at.from),
      ...block.map((t, i) => ({
        text: t,
        eol: i === block.length - 1 ? end : eol,
      })),
      ...lines.slice(at.to + 1),
    ]);
  } else {
    // Set some other way (an inline table, dotted keys): not ours to rewrite.
    if (servers(doc)?.[CODEX_ENTRY] !== undefined)
      throw new Error(
        `${path} sets mcp_servers.${CODEX_ENTRY} in a form install can't edit; left it untouched`,
      );
    const eol = eolOf(lines);
    // A blank line before it; the file's own ending is kept.
    const ended = lines.at(-1)?.text === "" && lines.length > 1;
    const sep =
      text === "" ? "" : ended ? (blank(lines.at(-2)) ? "" : eol) : eol + eol;
    next = `${text}${sep}${block.join(eol)}${eol}`;
  }
  return checked(path, doc, next, entry);
}

/** The config without our table; unchanged when it has none. */
export function removeCodexEntry(path: string, text: string, doc: Doc): string {
  if (servers(doc)?.[CODEX_ENTRY] === undefined) return text;
  return withBom(text, (body) => remove(path, body, doc));
}

function remove(path: string, text: string, doc: Doc): string {
  let lines = splitLines(text);
  const all = spans(lines.map((l) => l.text));
  if (all.length === 0)
    throw new Error(
      `${path} sets mcp_servers.${CODEX_ENTRY} in a form uninstall can't edit; left it untouched`,
    );
  for (const at of all.reverse()) lines = cut(lines, at);
  return checked(path, doc, joinLines(lines), undefined);
}
