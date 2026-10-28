import { normalizeEmail } from "@oa/auth-core";
import {
  type Format,
  LIMITS,
  type Page,
  type SearchHit,
  SNIPPET_MARK,
} from "@oa/shared";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  authorize,
  type Caller,
  checkListSpace,
  levelSql,
  listFilterSql,
} from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { artifacts, shares, spaces, users } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import {
  decorate,
  decorates,
  redact,
  spaceCols,
  toSummary,
} from "./artifacts.js";
import type { ManifestEntry } from "./manifest.js";
import { imageThumbnail } from "./thumbs.js";

/**
 * The FTS5 table (migration 0000; kept out of schema.ts so drizzle-kit leaves
 * it alone). Rows use rowid = artifacts.rowid.
 */
export const artifactSearch = sqliteTable("artifact_search", {
  rowid: integer("rowid").notNull(),
  artifactId: text("artifact_id").notNull(),
  title: text("title"),
  description: text("description"),
  body: text("body"),
});

const bad = (message: string, path: string) =>
  new ApiError("bad_request", message, { path, reason: "invalid" });

// ------------------------------------------------------------- query syntax

const MAX_TOKENS = 16;
export const MAX_QUERY = 500;
/** C0 controls (NUL, and the SNIPPET_MARK \u0002/\u0003) and DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROLS = /[\u0000-\u001f\u007f]/g;
/** The snippet markers, stripped from everything indexed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the SNIPPET_MARK characters
const MARKS = /[\u0002\u0003]/g;
export const stripMarks = (s: string) => s.replace(MARKS, "");
/** SQL twin of stripMarks over a column expression. */
const unmarkSql = (col: string) =>
  `replace(replace(${col}, char(2), ''), char(3), '')`;
/** The FTS title/description columns, as selected from artifacts. */
const UNMARKED = `${unmarkSql("title")}, ${unmarkSql("description")}`;
/** unicode61 token characters; a word without any can't match anything. */
const WORDY = /[\p{L}\p{N}]/u;

/**
 * User text → FTS5 MATCH expression, or null if nothing searchable remains.
 * Each whitespace-separated word becomes a quoted phrase (inner `"` doubled),
 * so operators, column filters and `*` are inert; the last gets `*` (prefix).
 * Words are ANDed; at most MAX_TOKENS.
 */
export function sanitizeQuery(q: string): string | null {
  const toks = q
    .split(/\s+/)
    .map((t) => t.replace(CONTROLS, ""))
    .filter((t) => t && WORDY.test(t))
    .slice(0, MAX_TOKENS)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (!toks.length) return null;
  toks[toks.length - 1] += "*";
  return toks.join(" AND ");
}

/** The list `q` filter: artifacts whose FTS row matches. 400 if empty/too long. */
export function ftsFilter(q: string): SQL {
  const text = q.trim();
  if (text.length > MAX_QUERY)
    throw bad(`q exceeds ${MAX_QUERY} characters`, "q");
  const m = sanitizeQuery(text);
  if (!m) throw bad("q has no searchable words", "q");
  return sql`${artifacts}.rowid in (select rowid from ${artifactSearch} where ${artifactSearch} match ${m})`;
}

// --------------------------------------------------------------- extraction

/** Elements whose content is never indexed, and how each skip ends. */
const SKIP_OPEN = /<!--|<(script|style|noscript|template)\b/gi;
/** Each skipped element's terminator (global: matched from an index). */
const CLOSE: Record<string, RegExp> = {
  script: /<\/script\s*>/gi,
  style: /<\/style\s*>/gi,
  noscript: /<\/noscript\s*>/gi,
  template: /<\/template\s*>/gi,
};
const COMMENT = Symbol("comment");
/**
 * Comments/skipped elements per entry, at most: past this, reading stops
 * (each costs a few regex steps; 100k tiny comments cost ~18 ms, 10k ~1.5 ms).
 */
export const MAX_SKIPS = 10_000;
/**
 * Runs of tags (and the whitespace between) collapse in one match. `[^<>]`
 * keeps it linear on `<a<a<a…` with no `>`.
 */
const TAG = /(?:<[a-zA-Z/!?][^<>]*>\s*)+/g;
/** A partial tag longer than this at a chunk end is treated as text. */
const MAX_CARRY = 8 * 1024;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
/** Entities decoded per entry, at most; the rest stay raw (search quality only). */
export const MAX_ENTITIES = 16_000;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
function decodeEntity(m: string, e: string): string {
  if (e[0] === "#") {
    const n =
      e[1] === "x" || e[1] === "X"
        ? Number.parseInt(e.slice(2), 16)
        : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
}
/** At most MAX_ENTITIES decodes: an entity-dense page cost ~9 ms in one replace. */
function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let pos = 0;
  ENTITY.lastIndex = 0;
  for (let n = 0; n < MAX_ENTITIES; n++) {
    const m = ENTITY.exec(s);
    if (!m) break;
    out += s.slice(pos, m.index) + decodeEntity(m[0], m[1] as string);
    pos = ENTITY.lastIndex;
  }
  return out + s.slice(pos);
}

/**
 * Tags out of a text run: each run of tags → " ". One callback-free pass,
 * so inline tags also break words (`qu<b>ar</b>t` → 2 words).
 */
const stripTags = (s: string) => (s.indexOf("<") < 0 ? s : s.replace(TAG, " "));

/**
 * Whitespace runs → one space. Matches only runs that change (2+ chars, or
 * one non-space char): stripped markup is mostly single spaces, and
 * replacing each of those with itself cost ~3× the rest of extraction.
 */
const WS = /\s{2,}|[^\S ]/g;
const collapse = (s: string) => s.replace(WS, " ");

/**
 * Streaming HTML → text. State survives chunk boundaries: inside a comment or
 * a skipped element, input is discarded until its close (only a short tail is
 * kept, to catch a close split across chunks), so no length of skipped content
 * ever reverts to text. Script-data-escaped states are not modelled.
 */
class HtmlText {
  /** The terminator being skipped to (`-->` or `</script`…), or null. */
  private close: RegExp | typeof COMMENT | null = null;
  private carry = "";
  /** Comments and skipped elements opened so far (each costs a few regex steps). */
  private skips = 0;
  /** MAX_SKIPS reached: the rest of the input is ignored. */
  exhausted = false;

  /** Feeds a chunk; returns the text it yields. Index-based: no re-slicing per element. */
  push(chunk: string, final: boolean): string {
    if (this.exhausted) return "";
    const buf = this.carry + chunk;
    this.carry = "";
    let out = "";
    let pos = 0;
    for (;;) {
      if (this.close) {
        let end: number;
        if (this.close === COMMENT) {
          const e = buf.indexOf("-->", pos);
          end = e < 0 ? -1 : e + 3;
        } else {
          this.close.lastIndex = pos;
          const m = this.close.exec(buf);
          end = m ? m.index + m[0].length : -1;
        }
        if (end < 0) {
          // Keep a tail that could start a split terminator.
          if (!final) this.carry = buf.slice(Math.max(pos, buf.length - 16));
          return out;
        }
        pos = end;
        this.close = null;
        out += " ";
      }
      SKIP_OPEN.lastIndex = pos;
      const o = SKIP_OPEN.exec(buf);
      if (!o) {
        let end = buf.length;
        if (!final) {
          // A partial tag (or partial `<!--`/`<script`) at the end waits.
          const lt = buf.lastIndexOf("<");
          if (
            lt >= pos &&
            buf.indexOf(">", lt) < 0 &&
            buf.length - lt <= MAX_CARRY
          )
            end = lt;
        }
        this.carry = buf.slice(end);
        return out + stripTags(buf.slice(pos, end));
      }
      if (o.index > pos) out += stripTags(buf.slice(pos, o.index));
      if (++this.skips > MAX_SKIPS) {
        // Budget spent: drop the rest of the document.
        this.exhausted = true;
        return out;
      }
      const name = o[1];
      this.close = name ? (CLOSE[name.toLowerCase()] ?? COMMENT) : COMMENT;
      pos = o.index + o[0].length;
    }
  }
}

/**
 * Indexing reads and extracts at most this many leading bytes of an entry
 * (the DO alarm's CPU budget); the rest of the document is not indexed.
 */
export const INDEX_INPUT_BYTES = LIMITS.indexTextBytes;

/**
 * Indexable text of an entry, at most LIMITS.searchBodyChars, with SNIPPET_MARK
 * characters stripped. html: markup stripped, script/style/noscript/template
 * and comment content dropped, entities decoded, whitespace collapsed;
 * markdown/code: raw; pdf: "" (the viewer extracts and PUTs it); image: ""
 * (an image is searched by its title and description only, never its bytes).
 * A stream is read until the output reaches the cap, INDEX_INPUT_BYTES bytes
 * have been read (the chunk crossing it is truncated there) or MAX_SKIPS
 * comments/skipped elements were opened, then cancelled; at most
 * MAX_ENTITIES entities are decoded. These bound the CPU per entry (B17).
 *
 * html is regex/indexOf based, not HTMLRewriter: a text handler costs one
 * JS↔native crossing per text chunk, measured at ~500 ms for a 200k-char
 * page (vs ~4 ms here), far over the 10 ms CPU budget.
 */
export async function extractText(
  format: Format,
  body: ReadableStream | string,
): Promise<string> {
  const cap = LIMITS.searchBodyChars;
  if (format === "pdf" || format === "image") {
    if (typeof body !== "string") await body.cancel().catch(() => {});
    return "";
  }
  const html = format === "html";
  const finish = (s: string) =>
    stripMarks(html ? collapse(decodeEntities(s)).trim() : s).slice(0, cap);
  if (typeof body === "string")
    return finish(html ? new HtmlText().push(body, true) : body);
  const h = new HtmlText();
  let out = "";
  let bytes = 0;
  const dec = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const stop =
      bytes >= INDEX_INPUT_BYTES ||
      h.exhausted ||
      // Entities only shrink text, so the cap on undecoded text is safe.
      out.length >= (html ? cap * 1.25 : cap);
    const r = stop ? { done: true as const } : await reader.read();
    if (stop) await reader.cancel().catch(() => {});
    let chunk: string;
    if (r.done) chunk = dec.decode();
    else {
      const room = INDEX_INPUT_BYTES - bytes;
      const v = r.value.byteLength > room ? r.value.subarray(0, room) : r.value;
      bytes += v.byteLength;
      chunk = dec.decode(v, { stream: true });
    }
    out += html ? collapse(h.push(chunk, r.done)) : chunk;
    if (r.done) break;
  }
  return finish(out);
}

// ----------------------------------------------------------------- indexing

type IndexRow = {
  rid: number;
  format: Format;
  cv: number;
  entry: string;
  manifest: string;
  text_indexed: number;
};

/** Binds (id, version): `version` is still the live current version of `id`. */
const CURRENT =
  "exists (select 1 from artifacts where id = ? and current_version = ? and deleted_at is null)";

/**
 * Search indexing is asynchronous (C3): publish, restore and undelete call
 * enqueueIndex, and the artifact's DO runs indexVersionOrThrow from its alarm.
 * Until then the FTS row matches on title/description only (seedSearchStmt
 * gives a new or undeleted artifact a row with an empty body; a new version
 * keeps the previous version's body).
 */

/**
 * Replaces the artifact's FTS row (by rowid) with version `version`'s text
 * (skipped when unchanged), if it is still current (live, not superseded): otherwise a no-op. Non-pdf
 * versions are marked text_indexed. A pdf keeps body text a viewer already
 * contributed for this version. Throws on D1/R2/extraction errors (the DO
 * alarm retries).
 */
export async function indexVersionOrThrow(
  env: Pick<Env, "DB" | "FILES">,
  artifactId: string,
  version: number,
): Promise<void> {
  const row = await env.DB.prepare(
    `select a.rowid as rid, coalesce(v.format, a.format) as format, a.current_version as cv,
            v.entry, v.manifest, v.text_indexed
     from artifacts a join versions v on v.artifact_id = a.id and v.version = ?
     where a.id = ? and a.deleted_at is null`,
  )
    .bind(version, artifactId)
    .first<IndexRow>();
  if (!row || row.cv !== version) return;
  let body = "";
  const pdf = row.format === "pdf";
  const entry = (JSON.parse(row.manifest) as ManifestEntry[]).find(
    (e) => e.path === row.entry,
  );
  if (row.format === "image") {
    // Title and description only: the bytes are never read as text. The
    // thumbnail comes from the image itself (bounded, best-effort).
    if (entry) await imageThumbnail(env, artifactId, version, entry);
  } else if (pdf) {
    if (row.text_indexed === 1) {
      const old = await env.DB.prepare(
        "select body from artifact_search where rowid = ?",
      )
        .bind(row.rid)
        .first<{ body: string | null }>();
      body = old?.body ?? "";
    }
  } else {
    // Only the first INDEX_INPUT_BYTES are read: ask R2 for no more.
    const obj = entry
      ? await env.FILES.get(
          entry.key,
          entry.size > INDEX_INPUT_BYTES
            ? { range: { offset: 0, length: INDEX_INPUT_BYTES } }
            : undefined,
        )
      : null;
    if (obj) body = await extractText(row.format, obj.body);
  }
  const guard = [artifactId, version] as const;
  await env.DB.batch([
    // One FTS write instead of delete + insert (#248: each bills a row), and
    // none when the row already holds this text and title/description.
    env.DB.prepare(
      `insert or replace into artifact_search (rowid, artifact_id, title, description, body)
       select a.rid, a.id, a.t, a.d, ?1 from (
         select rowid as rid, id, ${unmarkSql("title")} as t, ${unmarkSql("description")} as d
         from artifacts where id = ?2 and current_version = ?3 and deleted_at is null
       ) a
       where not exists (select 1 from artifact_search s
         where s.rowid = a.rid and s.body = ?1 and s.title is a.t and s.description is a.d)`,
    ).bind(body, ...guard),
    // pdf: text_indexed stays 1 only if its contributed text survived.
    env.DB.prepare(
      `update versions set text_indexed = ? where artifact_id = ? and version = ? and ${CURRENT}`,
    ).bind(pdf ? (body ? 1 : 0) : 1, ...guard, ...guard),
  ]);
}

/**
 * Gives a live artifact without an FTS row one with title/description and an
 * empty body (searchable by title before its body is indexed). A no-op when a
 * row exists; joins the publish/undelete batch.
 */
export const seedSearchStmt = (db: D1Database, id: string) =>
  db
    .prepare(
      `insert into artifact_search (rowid, artifact_id, title, description, body)
       select rowid, id, ${UNMARKED}, '' from artifacts a
       where id = ? and deleted_at is null
         and not exists (select 1 from artifact_search s where s.rowid = a.rowid)`,
    )
    .bind(id);

/** Keeps the FTS title/description in step with a PATCH (body unchanged). */
export const syncTitleStmt = (env: Env, id: string) =>
  env.DB.prepare(
    `update artifact_search set
       title = (select ${unmarkSql("title")} from artifacts where id = ?1),
       description = (select ${unmarkSql("description")} from artifacts where id = ?1)
     where rowid = (select rowid from artifacts where id = ?1 and deleted_at is null)`,
  ).bind(id);

/**
 * Viewer+ (else 404; a version that doesn't exist → 404). Applies only if the
 * artifact is pdf, `v` is current and not yet text_indexed; otherwise a no-op.
 * One D1 batch, every statement guarded, the flag flipped last: only the
 * first contribution wins.
 */
export async function putExtractedText(
  env: Env,
  caller: Caller,
  id: string,
  v: number,
  text: string,
): Promise<void> {
  const { artifact: a } = await authorize(env, caller, id, "version.text");
  if (v > a.currentVersion) throw new ApiError("not_found", "Not found");
  if (a.format !== "pdf" || v !== a.currentVersion) return;
  const body = stripMarks(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.searchBodyChars);
  const ok = `exists (select 1 from versions where artifact_id = ? and version = ? and text_indexed = 0)
    and exists (select 1 from artifacts where id = ? and current_version = ? and format = 'pdf' and deleted_at is null)`;
  const args = [id, v, id, v] as const;
  await env.DB.batch([
    env.DB.prepare(
      `delete from artifact_search where rowid = (select rowid from artifacts where id = ?) and ${ok}`,
    ).bind(id, ...args),
    env.DB.prepare(
      `insert into artifact_search (rowid, artifact_id, title, description, body)
       select rowid, id, ${UNMARKED}, ? from artifacts where id = ? and ${ok}`,
    ).bind(body, id, ...args),
    env.DB.prepare(
      `update versions set text_indexed = 1 where artifact_id = ? and version = ? and ${ok}`,
    ).bind(id, v, ...args),
  ]);
}

// ------------------------------------------------------------------- search

/** Deepest offset a search cursor may reach (bm25 order isn't keyset-stable). */
export const MAX_OFFSET = 1000;
const B64URL = /^[A-Za-z0-9_-]+$/;

const encodeOffset = (o: number) =>
  btoa(JSON.stringify({ o }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Strict: anything but b64url JSON `{o: 0..MAX_OFFSET}` → 400. */
function decodeOffset(s: string): number {
  const invalid = () => bad("Invalid cursor", "cursor");
  if (!B64URL.test(s) || s.length > 64) throw invalid();
  let v: unknown;
  try {
    v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw invalid();
  }
  if (!v || typeof v !== "object" || Object.keys(v).length !== 1)
    throw invalid();
  const o = (v as { o?: unknown }).o;
  if (
    typeof o !== "number" ||
    !Number.isSafeInteger(o) ||
    o < 0 ||
    o > MAX_OFFSET
  )
    throw invalid();
  return o;
}

const snip = (col: 1 | 2 | 3) =>
  sql<string>`snippet(${artifactSearch}, ${sql.raw(String(col))}, char(2), char(3), '…', 12)`;

/**
 * The body snippet when it holds a real hit (open, text, close), else the
 * description's, else the title's. Indexed text never contains the markers.
 */
const HIT = new RegExp(
  `${SNIPPET_MARK.open}[^${SNIPPET_MARK.open}${SNIPPET_MARK.close}]+${SNIPPET_MARK.close}`,
);
function pickSnippet(body: string, desc: string, title: string): string {
  for (const s of [body, desc, title]) if (HIT.test(s)) return s;
  // No real hit: never pass through stray markers.
  return stripMarks(body || desc || title);
}

/**
 * The search SELECT (exported for the EXPLAIN test): FTS MATCH `m` joined to
 * live, visible artifacts (in `spaceId` when given) with the caller's level
 * per hit (levelSql), bm25 order, `limit + 1` rows from `offset`.
 */
export function searchQuery(
  env: Env,
  caller: Caller & { kind: "user" },
  m: string,
  offset: number,
  limit: number,
  spaceId?: string,
) {
  const email = normalizeEmail(caller.user.email);
  return getDb(env)
    .select({
      a: artifacts,
      ownerEmail: users.email,
      ownerName: users.name,
      ownerDisplayName: users.displayName,
      level: levelSql(caller),
      // The joined space, for `space` and `can` (withSpace).
      space: spaceCols(caller, decorates(env, caller)),
      sb: snip(3),
      sd: snip(2),
      st: snip(1),
    })
    .from(artifactSearch)
    .innerJoin(artifacts, sql`${artifacts}.rowid = ${artifactSearch.rowid}`)
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .leftJoin(spaces, eq(spaces.id, artifacts.spaceId))
    .leftJoin(
      shares,
      and(
        eq(shares.artifactId, artifacts.id),
        email ? eq(shares.email, email) : sql`0`,
      ),
    )
    .where(
      and(
        sql`${artifactSearch} match ${m}`,
        listFilterSql(caller, "all", false, spaceId),
      ),
    )
    .orderBy(sql`bm25(${artifactSearch})`, artifacts.id)
    .limit(limit + 1)
    .offset(offset);
}

/**
 * Signed-in only (401). FTS MATCH of the sanitized query, joined to artifacts
 * through listFilterSql(caller, "all") (live, visible rows only; one space
 * with `spaceId`), ordered by bm25 then id, with an offset cursor capped at
 * MAX_OFFSET.
 */
export async function search(
  env: Env,
  caller: Caller,
  q: string,
  cursor?: string,
  limit = 25,
  spaceId?: string,
): Promise<Page<SearchHit>> {
  if (caller.kind !== "user")
    throw new ApiError("unauthorized", "Sign in required");
  const m = sanitizeQuery(q);
  if (!m) throw bad("q has no searchable words", "q");
  const offset = cursor === undefined ? 0 : decodeOffset(cursor);
  if (spaceId !== undefined) await checkListSpace(env, caller, spaceId);
  const rows = await searchQuery(env, caller, m, offset, limit, spaceId);
  const page = rows.slice(0, limit);
  const next = offset + limit;
  return {
    // Built in SearchHitSchema's key order (summary fields, then snippet);
    // validated by the tests, not per hit in production.
    // Rows the policy denies are dropped (belt and braces with listFilterSql).
    items: page.flatMap((r): SearchHit[] => {
      const { level } = r;
      if (!level) return [];
      const out = toSummary(
        env,
        r.a,
        redact(
          {
            id: r.a.ownerId,
            email: r.ownerEmail,
            name: r.ownerName,
            displayName: r.ownerDisplayName,
          },
          caller,
        ),
        level,
      );
      return [
        {
          ...decorate(env, caller, out, level, r.a.spaceId, r.space),
          snippet: pickSnippet(r.sb ?? "", r.sd ?? "", r.st ?? ""),
        },
      ];
    }),
    nextCursor:
      rows.length > limit && next <= MAX_OFFSET ? encodeOffset(next) : null,
  };
}
