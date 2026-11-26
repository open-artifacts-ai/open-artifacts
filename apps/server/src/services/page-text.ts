import { decodeHTML } from "entities";

// #3165: HTML-to-text view, block search, and unified line diff for get_artifact.

export const FIND_MAX_BYTES = 4 * 1024;
export const DIFF_MAX_BYTES = 8 * 1024;

const SKIP_TAGS = new Set(["head", "style", "script", "noscript", "template"]);
const HEADING_LEVEL: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "form",
  "fieldset",
  "address",
  "caption",
  "details",
  "summary",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "hr",
]);

const encoder = new TextEncoder();

function decode(s: string): string {
  return s.includes("&") ? decodeHTML(s) : s;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Find the closing `>` of a tag starting at `lt`, respecting quoted attrs. */
function findTagEnd(html: string, lt: number): number {
  let quote = 0;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function extractHref(attrs: string): string | null {
  const m = HREF_RE.exec(attrs);
  if (!m) return null;
  const raw = decode(m[1] ?? m[2] ?? m[3] ?? "").trim();
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return null;
  return raw;
}

/**
 * Extract readable visible text from HTML without DOM or HTMLRewriter.
 * Keeps headings (`#`/`##`), list items (`- `), table rows (`a | b`),
 * and links (`text (href)`). Drops head, style, script, comments, and markup.
 */
export function htmlToText(html: string): string {
  const lines: string[] = [];
  let skipTag: string | null = null;
  let heading = 0;
  let inLi = false;
  let rowCells: string[] | null = null;
  let inCell = false;
  let buf = "";
  let inLink = false;
  let linkHref: string | null = null;
  let linkBuf = "";

  const appendText = (s: string) => {
    if (inLink) linkBuf += s;
    else buf += s;
  };

  const finishLink = () => {
    if (!inLink) return;
    const text = collapseWs(linkBuf);
    const href = linkHref;
    inLink = false;
    linkHref = null;
    linkBuf = "";
    if (text && href && text !== href) {
      buf += `${text} (${href})`;
    } else if (text) {
      buf += text;
    } else if (href) {
      buf += href;
    }
  };

  const finishCell = () => {
    if (!inCell || !rowCells) return;
    finishLink();
    rowCells.push(collapseWs(buf));
    buf = "";
    inCell = false;
  };

  const finishRow = () => {
    if (!rowCells) return;
    finishCell();
    if (rowCells.some((c) => c.length > 0)) {
      lines.push(rowCells.join(" | "));
    }
    rowCells = null;
  };

  const flushBlock = () => {
    finishLink();
    const text = collapseWs(buf);
    buf = "";
    if (!text) return;
    if (heading > 0) {
      lines.push(`${"#".repeat(heading)} ${text}`);
    } else if (inLi) {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  };

  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!skipTag) appendText(decode(html.slice(i)));
      break;
    }
    if (lt > i && !skipTag) {
      appendText(decode(html.slice(i, lt)));
    }

    // HTML comments
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    // Doctype / processing instructions
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      if (!skipTag) appendText(decode(html.slice(lt)));
      break;
    }

    const rawTag = html.slice(lt + 1, gt);
    i = gt + 1;

    const m = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawTag);
    if (!m) {
      if (!skipTag) appendText(`<${rawTag}>`);
      continue;
    }
    const closing = m[1] === "/";
    const tag = (m[2] as string).toLowerCase();
    const selfClosing = !closing && rawTag.trimEnd().endsWith("/");

    if (skipTag) {
      if (closing && tag === skipTag) skipTag = null;
      continue;
    }

    if (SKIP_TAGS.has(tag)) {
      if (!closing && !selfClosing) skipTag = tag;
      continue;
    }

    if (tag === "a") {
      if (!closing) {
        if (inLink) finishLink();
        inLink = true;
        linkHref = extractHref(rawTag.slice(m[0].length));
        linkBuf = "";
      } else {
        finishLink();
      }
      continue;
    }

    const hLevel = HEADING_LEVEL[tag];
    if (hLevel !== undefined) {
      if (inCell) {
        appendText(" ");
      } else if (!closing) {
        flushBlock();
        heading = hLevel;
      } else {
        flushBlock();
        heading = 0;
      }
      continue;
    }

    if (tag === "tr") {
      if (!closing) {
        if (rowCells) finishRow();
        else flushBlock();
        rowCells = [];
        inCell = false;
      } else {
        finishRow();
      }
      continue;
    }

    if (tag === "td" || tag === "th") {
      if (!closing) {
        if (!rowCells) {
          flushBlock();
          rowCells = [];
        }
        if (inCell) finishCell();
        inCell = true;
        buf = "";
      } else {
        finishCell();
      }
      continue;
    }

    if (tag === "table") {
      if (closing) finishRow();
      else flushBlock();
      continue;
    }

    if (tag === "li") {
      if (inCell) {
        appendText(" ");
      } else if (!closing) {
        flushBlock();
        inLi = true;
      } else {
        flushBlock();
        inLi = false;
      }
      continue;
    }

    if (tag === "br") {
      if (inCell) appendText(" ");
      else flushBlock();
      continue;
    }

    if (BLOCK_TAGS.has(tag)) {
      if (inCell) appendText(" ");
      else flushBlock();
    }
  }

  if (rowCells) finishRow();
  else flushBlock();

  return lines.join("\n");
}

/** Truncate `s` to fit within `maxBytes` UTF-8 bytes, appending `note`. */
function capBytes(s: string, maxBytes: number, note: string): string {
  if (encoder.encode(s).byteLength <= maxBytes) return s;
  const noteBytes = encoder.encode(note).byteLength;
  const budget = Math.max(0, maxBytes - noteBytes);
  // Binary search by code unit index, snapping off high surrogates.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (encoder.encode(s.slice(0, mid)).byteLength <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) {
    const code = s.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo--;
  }
  const cut = s.slice(0, lo);
  const lastNl = cut.lastIndexOf("\n");
  const clean = lastNl > lo * 0.5 ? cut.slice(0, lastNl) : cut;
  return clean + note;
}

/**
 * Return blocks containing `needle` (case-insensitive), each with 1 block of
 * context before and after, separated by `...`. Output is capped at 4 KB.
 */
export function findInText(
  text: string,
  needle: string,
  maxBytes = FIND_MAX_BYTES,
): { content: string; matches: number } {
  const blocks = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const q = needle.toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if ((blocks[i] as string).toLowerCase().includes(q)) hits.push(i);
  }
  if (hits.length === 0) return { content: "", matches: 0 };

  const windows: Array<{ start: number; end: number }> = [];
  for (const idx of hits) {
    const start = Math.max(0, idx - 1);
    const end = Math.min(blocks.length - 1, idx + 1);
    const prev = windows[windows.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      windows.push({ start, end });
    }
  }

  const joined = windows
    .map((w) => blocks.slice(w.start, w.end + 1).join("\n"))
    .join("\n...\n");
  const kb = Math.round(maxBytes / 1024);
  return {
    content: capBytes(joined, maxBytes, `\n... (truncated at ${kb} KB)`),
    matches: hits.length,
  };
}

type DiffOp = { kind: "=" | "-" | "+"; line: string };

/**
 * Myers O((N+M)D) line diff on the differing middle slice, bounded by `maxD`
 * so pathological inputs stay within Workers CPU limits.
 */
function myersDiff(a: string[], b: string[], maxD = 1000): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (
        k === -d ||
        (k !== d &&
          (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
      ) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Backtrack to reconstruct edit script.
        const ops: DiffOp[] = [];
        let bx = n;
        let by = m;
        for (let step = d; step > 0; step--) {
          const prev = trace[step] as Int32Array;
          const bk = bx - by;
          let prevK: number;
          if (
            bk === -step ||
            (bk !== step &&
              (prev[offset + bk - 1] as number) <
                (prev[offset + bk + 1] as number))
          ) {
            prevK = bk + 1;
          } else {
            prevK = bk - 1;
          }
          const prevX = prev[offset + prevK] as number;
          const prevY = prevX - prevK;
          while (bx > prevX && by > prevY) {
            ops.push({ kind: "=", line: a[bx - 1] as string });
            bx--;
            by--;
          }
          if (bx === prevX) {
            ops.push({ kind: "+", line: b[by - 1] as string });
            by--;
          } else {
            ops.push({ kind: "-", line: a[bx - 1] as string });
            bx--;
          }
        }
        while (bx > 0 && by > 0) {
          ops.push({ kind: "=", line: a[bx - 1] as string });
          bx--;
          by--;
        }
        ops.reverse();
        return ops;
      }
    }
  }

  // Fallback if edit distance exceeds maxD: delete old middle, insert new middle.
  const ops: DiffOp[] = [];
  for (const line of a) ops.push({ kind: "-", line });
  for (const line of b) ops.push({ kind: "+", line });
  return ops;
}

/**
 * Unified line diff from `oldText` (fromVersion) to `newText` (toVersion),
 * capped at 8 KB with a truncation note. Returns "" when identical.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  fromVersion: number,
  toVersion: number,
  maxBytes = DIFF_MAX_BYTES,
): string {
  if (oldText === newText) return "";
  const a = oldText === "" ? [] : oldText.split(/\r?\n/);
  const b = newText === "" ? [] : newText.split(/\r?\n/);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return "";

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++)
    ops.push({ kind: "=", line: a[i] as string });
  for (const op of myersDiff(midA, midB)) ops.push(op);
  for (let i = a.length - suffix; i < a.length; i++) {
    ops.push({ kind: "=", line: a[i] as string });
  }

  // Group into unified hunks with 3 lines of context.
  const CTX = 3;
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if ((ops[i] as DiffOp).kind !== "=") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return "";

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - CTX);
    const end = Math.min(ops.length - 1, idx + CTX);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Precompute 1-based line numbers before each op.
  const oldLineAt = new Int32Array(ops.length + 1);
  const newLineAt = new Int32Array(ops.length + 1);
  let ol = 1;
  let nl = 1;
  for (let i = 0; i < ops.length; i++) {
    oldLineAt[i] = ol;
    newLineAt[i] = nl;
    const k = (ops[i] as DiffOp).kind;
    if (k === "=" || k === "-") ol++;
    if (k === "=" || k === "+") nl++;
  }
  oldLineAt[ops.length] = ol;
  newLineAt[ops.length] = nl;

  const out: string[] = [`--- v${fromVersion}`, `+++ v${toVersion}`];
  for (const r of ranges) {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = r.start; i <= r.end; i++) {
      const op = ops[i] as DiffOp;
      if (op.kind === "=") {
        oldCount++;
        newCount++;
        body.push(` ${op.line}`);
      } else if (op.kind === "-") {
        oldCount++;
        body.push(`-${op.line}`);
      } else {
        newCount++;
        body.push(`+${op.line}`);
      }
    }
    const oldStart =
      oldCount === 0
        ? (oldLineAt[r.start] as number) - 1
        : (oldLineAt[r.start] as number);
    const newStart =
      newCount === 0
        ? (newLineAt[r.start] as number) - 1
        : (newLineAt[r.start] as number);
    out.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...body,
    );
  }

  const kb = Math.round(maxBytes / 1024);
  return capBytes(out.join("\n"), maxBytes, `\n... (truncated at ${kb} KB)`);
}
