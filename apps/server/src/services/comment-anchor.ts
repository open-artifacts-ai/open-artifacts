import { CONTEXT_CHARS, planOf } from "@oa/shared";
import { decodeHTML } from "entities";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { sha256Sink } from "../util/digest.js";

// Quote verification for comment anchors (#682). The html page's own code is
// untrusted and receives anchors in the frame, so a text anchor on an html
// version is checked against that version's static visible text before it is
// stored. A quote found there keeps its context (re-derived when off). A quote
// not found is still accepted (#1735): the page's own script may have rendered
// it, which the static text never holds. Its prefix and suffix are cleared
// (and checkAnchor drops the block hint) because the page's code can forge an
// anchor, so no context we could not check is stored.

/** Visible text past this many characters is not read (a degenerate page). */
export const MAX_VISIBLE_CHARS = 4 * 1024 * 1024;

/** Runs of whitespace become one space; trimmed. */
export const normalizeText = (s: string): string =>
  s.replace(/\s+/g, " ").trim();

/**
 * Decodes the character references of one text node the way a browser does:
 * every HTML5 named entity, the legacy forms without a semicolon (&copy),
 * and numeric references (U+0000, surrogates and values past U+10FFFF become
 * U+FFFD; &#128; to &#159; use the windows-1252 table). An unknown name stays
 * as written. The client quote comes from the rendered page, so the two
 * sides must agree on every entity (#1735).
 */
export function decodeEntities(s: string): string {
  return s.includes("&") ? decodeHTML(s) : s;
}

/** Elements whose text is never visible. */
const HIDDEN = "script, style, template, noscript, title";
/** Elements that break a line: a space on both sides, so words don't fuse. */
const BLOCKS =
  "p, div, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, br, hr, tr, td, th, table, section, article, header, footer, nav, aside, main, blockquote, pre, figure, figcaption, form, fieldset, address";

/**
 * Registers an end tag handler. False for a void or self-closed element
 * (br, hr, img, svg/): workerd has no canHaveContent or selfClosing to ask
 * and onEndTag throws "No end tag" there.
 */
function onEnd(e: Element, fn: () => void): boolean {
  try {
    e.onEndTag(fn);
    return true;
  } catch {
    return false;
  }
}

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
        // A void or self-closed element has no end tag: onEndTag throws.
        if (!onEnd(e, () => void hidden--)) hidden--;
      },
    })
    .on(BLOCKS, {
      element(e) {
        push(" ");
        onEnd(e, () => push(" "));
      },
    })
    .on("*", {
      text(t) {
        // A text node can arrive in pieces: decode it whole. Hidden text
        // (a huge script) and text past the cap are never buffered.
        if (hidden === 0 && size + node.length < MAX_VISIBLE_CHARS)
          node += t.text;
        if (!t.lastInTextNode) return;
        if (node !== "") push(decodeEntities(node));
        node = "";
      },
    });
  const res = rewriter.transform(new Response(html));
  await res.arrayBuffer();
  return parts.join("");
}

export type Quote = { exact: string; prefix?: string; suffix?: string };

/** Moves an offset off the middle of a surrogate pair (toward `dir`). */
function snap(text: string, i: number, dir: 1 | -1): number {
  if (i <= 0 || i >= text.length) return i;
  const low = text.charCodeAt(i);
  const high = text.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
    ? i + dir
    : i;
}

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
  const end = at + exact.length;
  return {
    prefix: text.slice(snap(text, Math.max(0, at - CONTEXT_CHARS), 1), at),
    suffix: text.slice(end, snap(text, end + CONTEXT_CHARS, -1)),
  };
}

const notIn = () =>
  new ApiError(
    "anchor_not_in_version",
    "The quoted text is not in that version",
  );

/** An entry over this is never parsed for verification (the quote is accepted with its context cleared). */
export const MAX_VERIFY_BYTES = 5 * 1024 * 1024;

type VersionRow = { format: string | null; manifest: string };

/**
 * Whether version `version` of the artifact exists; when its format is html,
 * its entry's static visible text is searched for the quote. Returns the
 * (possibly re-derived) context when the quote is found. When it is not found,
 * or the entry is over MAX_VERIFY_BYTES and so not parsed, the quote is
 * accepted with prefix "" and suffix "": the text may be rendered by the
 * page's script, and context we could not check is not stored. Returns null
 * when the version is not html (schema checks only). 422 anchor_not_in_version
 * for a version that does not exist or an html entry file that is missing. The
 * MCP comment tools call this with the quote and version = current.
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
  const unchecked = { prefix: "", suffix: "" };
  const entry = (
    JSON.parse(row.manifest) as { path: string; key: string; size?: number }[]
  ).find((e) => e.path === row.entry);
  if (entry && (entry.size ?? 0) > MAX_VERIFY_BYTES) return unchecked;
  const body = entry ? await env.FILES.get(entry.key) : null;
  if (body && body.size > MAX_VERIFY_BYTES) return unchecked;
  if (!body) throw notIn();
  const text = normalizeText(await visibleText(body.body));
  return findQuote(text, q) ?? unchecked;
}

/** The format of a version, or null when it does not exist. */
export async function versionFormat(
  env: Pick<Env, "DB">,
  artifactId: string,
  artifactFormat: string,
  version: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "select format from versions where artifact_id = ? and version = ?",
  )
    .bind(artifactId, version)
    .first<{ format: string | null }>();
  return row ? (row.format ?? artifactFormat) : null;
}

/** The pin hash lookup's answer: the version's entry sha256, null (unknown), or missing version. */
export type EntryHash = { hash: string | null } | null;

/**
 * SHA-256 (hex) of a version's entry file; null when the version does not
 * exist. The hash is the manifest digest when recorded. Otherwise (an uploaded
 * entry on a free instance, or a version from before digests) a paid instance
 * streams the bytes from R2 every time (manifests stay immutable: a written
 * digest would split STORED_BYTES' count of a kept file); a free instance (10 ms CPU) answers `hash: null`
 * (unknown) with no R2 read.
 */
export async function versionEntryHash(
  env: Pick<Env, "DB" | "FILES" | "PLAN">,
  artifactId: string,
  version: number,
): Promise<EntryHash> {
  const row = await env.DB.prepare(
    "select entry, manifest from versions where artifact_id = ? and version = ?",
  )
    .bind(artifactId, version)
    .first<{ entry: string; manifest: string }>();
  if (!row) return null;
  const list = JSON.parse(row.manifest) as {
    path: string;
    key: string;
    digest?: string;
  }[];
  const e = list.find((m) => m.path === row.entry);
  if (!e) return null;
  if (e.digest) return { hash: e.digest };
  if (planOf(env.PLAN) !== "paid") return { hash: null };
  const obj = await env.FILES.get(e.key);
  if (!obj) return null;
  const sink = sha256Sink();
  await obj.body.pipeTo(sink.writable);
  return { hash: await sink.hex() };
}
