import { CONTEXT_CHARS } from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";

// Quote verification for comment anchors (#682). The html page's own code is
// untrusted and receives anchors in the frame, so a text anchor on an html
// version is checked against that version's visible text before it is stored:
// a quote the page never showed is refused (422 anchor_not_in_version).

/** Visible text past this many characters is not read (a degenerate page). */
export const MAX_VISIBLE_CHARS = 4 * 1024 * 1024;

/** Runs of whitespace become one space; trimmed. */
export const normalizeText = (s: string): string =>
  s.replace(/\s+/g, " ").trim();

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  plusmn: "±",
  frac12: "½",
};

/** Decodes the entities of one text node: named (a common set), decimal and hex. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED[name] ?? whole;
      const cp =
        dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) return whole;
      if (cp >= 0xd800 && cp <= 0xdfff) return whole;
      return String.fromCodePoint(cp);
    },
  );
}

/** Elements whose text is never visible. */
const HIDDEN = "script, style, template, noscript, title";
/** Elements that break a line: a space on both sides, so words don't fuse. */
const BLOCKS =
  "p, div, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, br, hr, tr, td, th, table, section, article, header, footer, nav, aside, main, blockquote, pre, figure, figcaption, form, fieldset, address";

/**
 * The visible text of an html document: script, style, template, noscript and
 * title skipped, entities decoded, blocks separated by a space. Not
 * normalised: pass it through normalizeText.
 */
export async function visibleText(
  html: ReadableStream<Uint8Array> | string,
): Promise<string> {
  const parts: string[] = [];
  let size = 0;
  let hidden = 0;
  let node = "";
  const push = (s: string) => {
    if (size >= MAX_VISIBLE_CHARS) return;
    parts.push(s);
    size += s.length;
  };
  const rewriter = new HTMLRewriter()
    .on(HIDDEN, {
      element(e) {
        hidden++;
        // A void or self-closed element has no end tag handler.
        if (e.onEndTag) e.onEndTag(() => void hidden--);
        else hidden--;
      },
    })
    .on(BLOCKS, {
      element(e) {
        push(" ");
        if (e.onEndTag) e.onEndTag(() => push(" "));
      },
    })
    .on("*", {
      text(t) {
        // A text node can arrive in pieces: decode it whole.
        node += t.text;
        if (!t.lastInTextNode) return;
        if (hidden === 0) push(decodeEntities(node));
        node = "";
      },
    });
  const res = rewriter.transform(new Response(html));
  await res.arrayBuffer();
  return parts.join("");
}

export type Quote = { exact: string; prefix?: string; suffix?: string };

/**
 * Finds the quote in `text` (already normalised). The prefix + exact + suffix
 * must occur together; when they don't but `exact` does, the context is
 * re-derived (CONTEXT_CHARS each side) around the first occurrence. Both
 * sides are whitespace-normalised first. Null when `exact` is not in the text.
 */
export function findQuote(
  text: string,
  q: Quote,
): { prefix: string; suffix: string } | null {
  const exact = normalizeText(q.exact);
  if (exact === "") return null;
  const prefix = q.prefix ?? "";
  const suffix = q.suffix ?? "";
  const whole = normalizeText(prefix + q.exact + suffix);
  if (text.includes(whole))
    return {
      prefix: normalizeText(prefix),
      suffix: normalizeText(suffix),
    };
  const at = text.indexOf(exact);
  if (at < 0) return null;
  return {
    prefix: text.slice(Math.max(0, at - CONTEXT_CHARS), at),
    suffix: text.slice(at + exact.length, at + exact.length + CONTEXT_CHARS),
  };
}

const notIn = () =>
  new ApiError(
    "anchor_not_in_version",
    "The quoted text is not in that version",
  );

type VersionRow = { format: string | null; manifest: string };

/**
 * Whether version `version` of the artifact exists; when its format is html,
 * its entry's visible text must hold the quote. Returns the (possibly
 * re-derived) context, or null when the version is not html (schema checks
 * only). 422 anchor_not_in_version otherwise. The MCP comment tools call this
 * with the quote and version = current.
 */
export async function verifyQuote(
  env: Pick<Env, "DB" | "FILES">,
  artifactId: string,
  artifactFormat: string,
  version: number,
  q: Quote,
): Promise<{ prefix: string; suffix: string } | null> {
  const row = await env.DB.prepare(
    "select format, manifest, entry from versions where artifact_id = ? and version = ?",
  )
    .bind(artifactId, version)
    .first<VersionRow & { entry: string }>();
  if (!row) throw notIn();
  if ((row.format ?? artifactFormat) !== "html") return null;
  const entry = (
    JSON.parse(row.manifest) as { path: string; key: string }[]
  ).find((e) => e.path === row.entry);
  const body = entry ? await env.FILES.get(entry.key) : null;
  if (!body) throw notIn();
  const text = normalizeText(await visibleText(body.body));
  const found = findQuote(text, q);
  if (!found) throw notIn();
  return found;
}

/** Whether a version exists (a pin or a note names one). */
export async function versionExists(
  env: Pick<Env, "DB">,
  artifactId: string,
  version: number,
): Promise<boolean> {
  return !!(await env.DB.prepare(
    "select 1 from versions where artifact_id = ? and version = ?",
  )
    .bind(artifactId, version)
    .first());
}
