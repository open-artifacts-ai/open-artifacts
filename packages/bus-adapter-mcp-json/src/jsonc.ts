/**
 * OpenCode's configs are JSONC. These edits go through jsonc-parser so the
 * user's comments, formatting and other keys stay byte-for-byte; each takes
 * and returns the file's text, and returns it unchanged when there is nothing
 * to do.
 */
import {
  createScanner,
  findNodeAtLocation,
  type JSONPath,
  type Node,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";
import type { Doc, McpServer } from "./index.ts";

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Empty text is an empty object; anything jsonc-parser rejects throws. */
export function parseJsonc(text: string, where: string): Doc {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const doc: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(doc))
    throw new Error(`${where} is not a JSON object; left it untouched`);
  return doc;
}

const eol = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

const nest = (path: JSONPath, value: unknown) =>
  path.reduceRight<unknown>(
    (v, k) => (typeof k === "number" ? [v] : { [k]: v }),
    value,
  );

const splice = (text: string, from: number, to: number, content = "") =>
  text.slice(0, from) + content + text.slice(to);

/** The node itself, or for an object member the whole `"key": value`. */
const member = (node: Node) =>
  node.parent?.type === "property" ? node.parent : node;

/** Leading whitespace of the line `offset` is on, and whether it starts it. */
function lineAt(text: string, offset: number) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(start, offset);
  const indent = /^[ \t]*/.exec(lead)?.[0] ?? "";
  return { indent, starts: indent === lead };
}

/**
 * Sets `path` to `value`. New text goes only after the last sibling (or into
 * an empty parent), so `removeAt` of the same path restores the input
 * exactly; neighbouring members, comments and spacing are never reformatted.
 */
function insert(text: string, path: JSONPath, value: unknown): string {
  const nl = eol(text);
  const root = parseTree(text);
  if (root === undefined)
    return `${JSON.stringify(nest(path, value), null, 2)}${nl}`;
  const found = findNodeAtLocation(root, path);
  if (found !== undefined)
    return splice(
      text,
      found.offset,
      found.offset + found.length,
      JSON.stringify(value),
    );
  // Attach under the deepest ancestor that exists; build the rest here.
  let depth = path.length - 1;
  while (
    depth > 0 &&
    findNodeAtLocation(root, path.slice(0, depth)) === undefined
  )
    depth--;
  const parent =
    depth === 0
      ? root
      : (findNodeAtLocation(root, path.slice(0, depth)) as Node);
  const key = path[depth];
  const head = parent.type === "object" ? `${JSON.stringify(key)}: ` : "";
  const v = nest(path.slice(depth + 1), value);
  const render = (indent: string) =>
    head +
    JSON.stringify(v, null, 2)
      .split("\n")
      .join(nl + indent);
  const last = parent.children?.at(-1);
  if (last === undefined) {
    const outer = lineAt(text, parent.offset).indent;
    const indent = `${outer}  `;
    const inner = text.slice(
      parent.offset + 1,
      parent.offset + parent.length - 1,
    );
    // Keep comments in an otherwise empty parent.
    if (inner.trim() !== "")
      return splice(
        text,
        parent.offset + 1,
        parent.offset + 1,
        `${nl}${indent}${render(indent)},`,
      );
    return splice(
      text,
      parent.offset + 1,
      parent.offset + parent.length - 1,
      `${nl}${indent}${render(indent)}${nl}${outer}`,
    );
  }
  const end = last.offset + last.length;
  const at = lineAt(text, last.offset);
  return splice(
    text,
    end,
    end,
    at.starts
      ? `,${nl}${at.indent}${render(at.indent)}`
      : `, ${head}${JSON.stringify(v)}`,
  );
}

// jsonc-parser's SyntaxKind is a const enum, which isolated modules cannot read.
export const JSONC_TOKENS = {
  CommaToken: 5,
  LineCommentTrivia: 12,
  BlockCommentTrivia: 13,
  LineBreakTrivia: 14,
  Trivia: 15,
  EOF: 17,
} as const;
const SyntaxKind = JSONC_TOKENS;
type Kind = number;

type Token = { kind: Kind; offset: number; end: number };

function tokens(text: string): Token[] {
  const scanner = createScanner(text, false);
  const out: Token[] = [];
  for (let k: Kind = scanner.scan(); k !== SyntaxKind.EOF; k = scanner.scan()) {
    const offset = scanner.getTokenOffset();
    out.push({ kind: k, offset, end: offset + scanner.getTokenLength() });
  }
  return out;
}

const isSpace = (k: Kind) =>
  k === SyntaxKind.Trivia || k === SyntaxKind.LineBreakTrivia;
const isComment = (k: Kind) =>
  k === SyntaxKind.LineCommentTrivia || k === SyntaxKind.BlockCommentTrivia;

/**
 * Deletes the member at `path`: its own tokens and one separating comma,
 * never a comment, plus its line when it had one to itself. The inverse of
 * `insert` byte for byte.
 */
function removeAt(text: string, path: JSONPath): string {
  const root = parseTree(text);
  const found = root && findNodeAtLocation(root, path);
  if (found === undefined) return text;
  const node = member(found);
  const parent = node.parent as Node;
  const toks = tokens(text);
  const s = node.offset;
  const e = node.offset + node.length;
  const comments = (from: number, to: number) =>
    toks.some((t) => isComment(t.kind) && t.offset >= from && t.end <= to);
  const solid = (t: Token) => !isSpace(t.kind) && !isComment(t.kind);
  const p = toks.filter((t) => t.end <= s && solid(t)).at(-1);
  const f = toks.find((t) => t.offset >= e && solid(t));
  const open = parent.offset + 1;
  const close = parent.offset + parent.length - 1;
  // The only member of a parent without comments: leave it `{}` / `[]`.
  if (
    p?.offset === parent.offset &&
    f?.offset === close &&
    !comments(open, close)
  )
    return splice(text, open, close);
  const comma = (t: Token | undefined) => t?.kind === SyntaxKind.CommaToken;
  if (p && comma(p) && !comments(p.end, s)) return splice(text, p.offset, e);
  let to = e;
  const cuts: [number, number][] = [];
  if (f && comma(f)) {
    if (comments(e, f.offset)) cuts.push([f.offset, f.end]);
    else to = f.end;
  } else if (p && comma(p)) cuts.push([p.offset, p.end]);
  let from = s;
  const lineStart = text.lastIndexOf("\n", s - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, s)) && lineStart > 0) {
    // Joining onto a line that ends in `//` would comment out what follows.
    const afterLineComment = toks.some(
      (t) =>
        t.kind === SyntaxKind.LineCommentTrivia &&
        /^\r?\n$/.test(text.slice(t.end, lineStart)),
    );
    const rest = /^[ \t]*(\r?\n|$)/.exec(text.slice(to));
    if (!afterLineComment)
      from = lineStart - (text[lineStart - 2] === "\r" ? 2 : 1);
    else if (rest) {
      from = lineStart;
      to += rest[0].length;
    }
  }
  cuts.push([from, to]);
  return cuts
    .sort((x, y) => y[0] - x[0])
    .reduce((out, [a, b]) => splice(out, a, b), text);
}

/** The value at `path`, or undefined; the text must parse. */
export function jsoncValue(text: string, path: JSONPath): unknown {
  let v: unknown = parseJsonc(text, "config");
  for (const k of path) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

/** Removes the container at `path` if it is an empty object or array. */
export function removeIfEmpty(text: string, path: JSONPath): string {
  const v = jsoncValue(text, path);
  const root = parseTree(text);
  const node = root && findNodeAtLocation(root, path);
  // A comment inside is the user's: the container is not empty.
  const commented =
    node !== undefined &&
    tokens(text.slice(node.offset, node.offset + node.length)).some((t) =>
      isComment(t.kind),
    );
  const empty =
    !commented &&
    ((Array.isArray(v) && v.length === 0) ||
      (isRecord(v) && Object.keys(v).length === 0));
  return empty ? verified(removeAt(text, path), path, undefined) : text;
}

/** Refuses an edit whose result does not parse or holds the wrong value. */
function verified(text: string, path: JSONPath, want: unknown): string {
  let ok = false;
  try {
    ok = same(jsoncValue(text, path), want);
  } catch {}
  if (!ok)
    throw new Error(`editing ${path.join(".")} failed; left it untouched`);
  return text;
}

function record(v: unknown, where: string): Doc | undefined {
  if (v === undefined) return undefined;
  // null included: there is no object to add our entry to.
  if (!isRecord(v)) throw new Error(`${where} is not an object`);
  return v;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * OpenCode v2: `mcp.servers.<name>`. A top-level `mcp.<name>` is the
 * deprecated v1 shape; ours is dropped so the server is never listed twice.
 */
export function upsertOpencodeMcp(
  text: string,
  name: string,
  server: McpServer,
): string {
  const mcp = record(parseJsonc(text, "config").mcp, "mcp");
  const servers = record(mcp?.servers, "mcp.servers");
  let out = text;
  if (mcp?.[name] !== undefined) out = removeAt(out, ["mcp", name]);
  if (!same(servers?.[name], server))
    out = insert(out, ["mcp", "servers", name], server);
  verified(out, ["mcp", name], undefined);
  return verified(out, ["mcp", "servers", name], server);
}

export function removeOpencodeMcp(text: string, name: string): string {
  const mcp = record(parseJsonc(text, "config").mcp, "mcp");
  const servers = record(mcp?.servers, "mcp.servers");
  let out = text;
  if (servers?.[name] !== undefined)
    out = removeAt(out, ["mcp", "servers", name]);
  if (mcp?.[name] !== undefined) out = removeAt(out, ["mcp", name]);
  verified(out, ["mcp", name], undefined);
  return verified(out, ["mcp", "servers", name], undefined);
}

function plugins(text: string): unknown[] | undefined {
  const v = parseJsonc(text, "config").plugins;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error("plugins is not an array");
  return v;
}

const names = (entry: unknown, path: string) =>
  entry === path || (isRecord(entry) && entry.package === path);

/** OpenCode v2 `cli.json` plugins: strings or `{ package }` entries. */
export function upsertPlugin(text: string, pluginPath: string): string {
  const list = plugins(text);
  if (list?.some((e) => names(e, pluginPath))) return text;
  return verified(
    insert(text, ["plugins", list?.length ?? 0], pluginPath),
    ["plugins"],
    [...(list ?? []), pluginPath],
  );
}

export function removePlugin(text: string, pluginPath: string): string {
  const list = plugins(text);
  if (!list?.some((e) => names(e, pluginPath))) return text;
  let out = text;
  for (let i = list.length - 1; i >= 0; i--)
    if (names(list[i], pluginPath)) out = removeAt(out, ["plugins", i]);
  return verified(
    out,
    ["plugins"],
    list.filter((e) => !names(e, pluginPath)),
  );
}
