/** A safe markdown subset for comment bodies (#2338). Pure: the text goes in, a
    small tree comes out, and the renderer (Markdown.tsx) builds React elements
    from it. Nothing here is HTML, and the tree can hold only the node kinds below.

    Supported: **bold**, *italic*, `code`, fenced code, bulleted and numbered lists
    (one level), block quotes, headings (a bold line), [text](url) and bare URLs
    (linkify's rules: http and https only). Everything else stays literal text.

    Cost is bounded: the input is capped, nesting is capped, and every scan that
    can repeat spends from one step budget, so no input is worse than linear in
    the budget. There is no regex with nested quantifiers. */
import { linkify } from "./linkify";

export type Inline =
  | { t: "text"; s: string }
  | { t: "b" | "i"; c: Inline[] }
  | { t: "code"; s: string }
  | { t: "a"; href: string; label: string };

export type Block =
  | { t: "p" | "h"; c: Inline[] }
  | { t: "pre"; s: string }
  | { t: "q"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] };

/** Past this the rest of the body is shown as plain text. Comments are 2,000 at most. */
export const MAX_INPUT = 5000;
const STEPS = 20000;
const MAX_INLINE_DEPTH = 4;
const MAX_QUOTE_DEPTH = 3;

type Ctx = { steps: number };

// Control, bidi, zero-width and other invisible formatting characters.
const INVISIBLE_RANGES: [number, number][] = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];
const hex = (n: number) => `\\u${n.toString(16).padStart(4, "0")}`;
const INVISIBLE_SRC = `[${INVISIBLE_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join("")}]`;
const INVISIBLE = new RegExp(INVISIBLE_SRC);
const INVISIBLE_G = new RegExp(INVISIBLE_SRC, "g");
const ESCAPABLE = "\\`*_[]()#>-+.!<~|{}";

const isSpace = (c: string | undefined) =>
  c === undefined || c === " " || c === "\n" || c === "\t" || /\s/.test(c);
const isAlnum = (c: string | undefined) => {
  if (c === undefined) return false;
  const n = c.charCodeAt(0);
  if (n < 128)
    return (
      (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122)
    );
  return /[\p{L}\p{N}]/u.test(c);
};

function runLen(s: string, i: number, ch: string): number {
  let j = i;
  while (s[j] === ch) j++;
  return j - i;
}

/** Index of the next backtick run of exactly `n` at or after `from`, or -1. */
function findCodeClose(s: string, from: number, n: number, ctx: Ctx): number {
  let j = from;
  while (j < s.length) {
    if (--ctx.steps < 0) return -1;
    const k = s.indexOf("`", j);
    if (k < 0) return -1;
    const r = runLen(s, k, "`");
    if (r === n) return k;
    j = k + r;
  }
  return -1;
}

/** The href when `url` is exactly one linkify URL with nothing hidden in it. */
function safeHref(url: string): string | null {
  if (url.length > 2000 || INVISIBLE.test(url) || /\s/.test(url)) return null;
  const p = linkify(url);
  return p.length === 1 && p[0]?.url && p[0].text === url ? url : null;
}

function parseLink(s: string, i: number, ctx: Ctx): [Inline, number] | null {
  let j = i + 1;
  while (j < s.length && s[j] !== "]" && s[j] !== "[" && s[j] !== "\n") j++;
  if (s[j] !== "]" || s[j + 1] !== "(") return null;
  let k = j + 2;
  let depth = 0;
  for (; k < s.length; k++) {
    if (--ctx.steps < 0) return null;
    const c = s[k];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(c ?? "")) return null;
  }
  if (s[k] !== ")") return null;
  const href = safeHref(s.slice(j + 2, k));
  if (!href) return null;
  let label = s.slice(i + 1, j).replace(INVISIBLE_G, "");
  if (!label.trim()) return null;
  // Text that reads as an address but is not this one would spoof the target.
  const spoof =
    label.includes("://") || (!/\s/.test(label) && label.includes("."));
  if (spoof && label !== href) label = href;
  return [{ t: "a", href, label }, k + 1];
}

function urlAt(s: string, i: number): string | null {
  if (s[i - 1] === "@") return null; // the name of an @-mention
  const head = s.slice(i, i + 8).toLowerCase();
  if (!head.startsWith("http://") && !head.startsWith("https://")) return null;
  // URL_RE stops at whitespace, so the word alone decides it (linear overall).
  let end = i;
  while (end < s.length && !/\s/.test(s[end] as string)) end++;
  const first = linkify(s.slice(i, end))[0];
  return first?.url ? safeHref(first.text) : null;
}

function findEmClose(
  s: string,
  from: number,
  ch: string,
  n: number,
  ctx: Ctx,
): number {
  let j = from;
  while (j < s.length) {
    if (--ctx.steps < 0) return -1;
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === "`") {
      const r = runLen(s, j, "`");
      const close = findCodeClose(s, j + r, r, ctx);
      j = close >= 0 ? close + r : j + r;
    } else if (c === ch) {
      const r = runLen(s, j, ch);
      if (
        r === n &&
        j > from &&
        !isSpace(s[j - 1]) &&
        (ch === "*" || !isAlnum(s[j + n]))
      )
        return j;
      j += r;
    } else j++;
  }
  return -1;
}

function parseInline(s: string, ctx: Ctx, depth: number): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", s: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "\\" && ESCAPABLE.includes(s[i + 1] ?? "\n")) {
      buf += s[i + 1];
      i += 2;
    } else if (ch === "`") {
      const n = runLen(s, i, "`");
      const close = findCodeClose(s, i + n, n, ctx);
      if (close < 0) {
        buf += "`".repeat(n);
        i += n;
        continue;
      }
      flush();
      let code = s.slice(i + n, close);
      if (
        code.length > 2 &&
        code.startsWith(" ") &&
        code.endsWith(" ") &&
        code.trim()
      )
        code = code.slice(1, -1);
      out.push({ t: "code", s: code });
      i = close + n;
    } else if (ch === "[" && s[i - 1] !== "!") {
      const l = parseLink(s, i, ctx);
      if (!l) {
        buf += ch;
        i++;
        continue;
      }
      flush();
      out.push(l[0]);
      i = l[1];
    } else if (ch === "h" || ch === "H") {
      const url = urlAt(s, i);
      if (!url) {
        buf += ch;
        i++;
        continue;
      }
      flush();
      out.push({ t: "a", href: url, label: url });
      i += url.length;
    } else if (ch === "*" || ch === "_") {
      const n = runLen(s, i, ch);
      const canOpen =
        n <= 3 &&
        depth < MAX_INLINE_DEPTH &&
        !isSpace(s[i + n]) &&
        (ch === "*" || !isAlnum(s[i - 1]));
      const close = canOpen ? findEmClose(s, i + n, ch, n, ctx) : -1;
      if (close < 0) {
        buf += ch.repeat(n);
        i += n;
        continue;
      }
      flush();
      const inner = parseInline(s.slice(i + n, close), ctx, depth + 1);
      out.push(
        n === 1
          ? { t: "i", c: inner }
          : n === 2
            ? { t: "b", c: inner }
            : { t: "b", c: [{ t: "i", c: inner }] },
      );
      i = close + n;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return out;
}

const FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/;

function parseBlocks(lines: string[], ctx: Ctx, qd: number): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length)
      out.push({ t: "p", c: parseInline(para.join("\n"), ctx, 0) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const len = open[1]?.length ?? 3;
      let j = i + 1;
      while (j < lines.length) {
        const c = FENCE_CLOSE.exec(lines[j] as string);
        if (c && (c[1]?.length ?? 0) >= len) break;
        j++;
      }
      if (j < lines.length) {
        flushPara();
        out.push({ t: "pre", s: lines.slice(i + 1, j).join("\n") });
        i = j + 1;
        continue;
      }
      // No closing fence: the line stays literal text.
      para.push(line);
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h?.[1]?.trim()) {
      flushPara();
      out.push({ t: "h", c: parseInline(h[1].trim(), ctx, 0) });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push({
        t: "q",
        c:
          qd < MAX_QUOTE_DEPTH
            ? parseBlocks(inner, ctx, qd + 1)
            : [{ t: "p", c: [{ t: "text", s: inner.join("\n") }] }],
      });
      continue;
    }
    const m = ITEM.exec(line);
    const ordered = m ? /\d/.test(m[1] ?? "") : false;
    const startsAt = m && ordered ? Number.parseInt(m[1] ?? "1", 10) : 1;
    if (m && !(para.length && ordered && startsAt !== 1)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] as string;
        const im = ITEM.exec(cur);
        if (im && /\d/.test(im[1] ?? "") === ordered) items.push(im[2] ?? "");
        else if (!im && /^ {2,}\S/.test(cur) && items.length)
          items[items.length - 1] += `\n${cur.trim()}`;
        else break;
        i++;
      }
      out.push({
        t: "list",
        ordered,
        start: startsAt,
        items: items.map((x) => parseInline(x, ctx, 0)),
      });
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

export function parseMarkdown(body: string): Block[] {
  const ctx: Ctx = { steps: STEPS };
  const head = body.slice(0, MAX_INPUT);
  const blocks = parseBlocks(head.replace(/\r\n?/g, "\n").split("\n"), ctx, 0);
  if (body.length > MAX_INPUT)
    blocks.push({ t: "p", c: [{ t: "text", s: body.slice(MAX_INPUT) }] });
  return blocks;
}

/** Inline markup only (no lists, quotes or fences), for text inside a button. */
export function parseInlineOnly(body: string): Inline[] {
  const ctx: Ctx = { steps: STEPS };
  const out = parseInline(body.slice(0, MAX_INPUT), ctx, 0);
  if (body.length > MAX_INPUT)
    out.push({ t: "text", s: body.slice(MAX_INPUT) });
  return out;
}
