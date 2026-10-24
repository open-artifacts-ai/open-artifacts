import { type Format, isId, normalizePath, viewerPath } from "@oa/shared";
import { type Context, Hono } from "hono";
import { methodNotAllowed, ROBOTS } from "../app.js";
import { isPubliclyServable } from "../auth/policy.js";
import { enforceContentPolicy, mw } from "../auth/route-policy.js";
import type { Env } from "../env.js";
import { contentFrameAncestors } from "../http/embed.js";
import { ApiError, appOrigin, toErrorResponse } from "../http/errors.js";
import { CONTENT_CSP } from "../http/middleware.js";
import { injectRuntime } from "./inject.js";
import {
  CAPTURE_HEADER,
  type ContentViewer,
  type SignMode,
  verifyCapture,
  verifyContentToken,
} from "./signing.js";

type ManifestEntry = {
  path: string;
  key: string;
  size: number;
  contentType: string;
};
type VersionData = {
  entry: string;
  language: string | null;
  /** Null for rows written before migration 0002: use the artifact's. */
  format: Format | null;
  files: Map<string, ManifestEntry>;
};
type CEnv = { Bindings: Env };

const notFound = () => new ApiError("not_found", "Not found");
const VERSION_NUM = /^[1-9]\d{0,8}$/;
// /c/{token}/{id}/v{v}/{rest} | /p/{id}/v{v}/{rest}  (rest may be empty → 404)
const SIGNED = /^\/c\/([^/]+)\/([^/]+)\/v([^/]+)\/(.*)$/s;
const PUBLIC = /^\/p\/([^/]+)\/v([^/]+)\/(.*)$/s;
const CACHE_SIGNED = "private, max-age=300";
/** Revalidated on every use: a public→private switch must take effect at once. */
const CACHE_PUBLIC = "public, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";
const JS = "text/javascript; charset=utf-8";

// ------------------------------------------------------------ /_oa via ASSETS

type ViteEntry = {
  file?: unknown;
  css?: unknown;
  assets?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
};
type Oa = {
  /** The render entry (src/index.ts in /_oa/manifest.json), with its CSS. */
  render: { js: string; css: string[] } | null;
  /** `<script src="/_oa/…">` for the runtime (packages/runtime), or null when not deployed. */
  runtimeTag: string | null;
  /** Files reachable from either manifest's entry: the only servable /_oa paths. */
  files: Set<string>;
};
const ASSET_ORIGIN = "https://assets.invalid";
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

async function readManifest(
  env: Env,
  path: string,
): Promise<Record<string, ViteEntry> | null> {
  const r = await env.ASSETS.fetch(new Request(new URL(path, ASSET_ORIGIN)));
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`ASSETS ${path}: ${r.status}`);
  }
  try {
    const j: unknown = await r.json();
    return j && typeof j === "object" && !Array.isArray(j)
      ? (j as Record<string, ViteEntry>)
      : null;
  } catch {
    return null; // SPA fallback (index.html): the manifest isn't deployed.
  }
}

/**
 * Adds every file reachable from the manifest's `src/index.ts` entry:
 * file, css and assets, following imports and dynamicImports recursively.
 */
function collect(m: Record<string, ViteEntry> | null, files: Set<string>) {
  if (!m) return;
  const seen = new Set<string>();
  const stack = ["src/index.ts"];
  while (stack.length) {
    const k = stack.pop() as string;
    if (seen.has(k) || !Object.hasOwn(m, k)) continue;
    seen.add(k);
    const e = m[k];
    if (typeof e?.file === "string") files.add(e.file);
    for (const f of [...strs(e?.css), ...strs(e?.assets)]) files.add(f);
    stack.push(...strs(e?.imports), ...strs(e?.dynamicImports));
  }
}

function entryOf(m: Record<string, ViteEntry> | null) {
  const e = m && Object.hasOwn(m, "src/index.ts") ? m["src/index.ts"] : null;
  return e && typeof e.file === "string"
    ? { js: e.file, css: strs(e.css) }
    : null;
}

/** Per-isolate (per ASSETS binding) cache; assets are fixed per deploy. */
const oaCache = new WeakMap<object, Promise<Oa>>();
function loadOa(env: Env): Promise<Oa> {
  if (!env.ASSETS)
    return Promise.resolve({
      render: null,
      runtimeTag: null,
      files: new Set(),
    });
  let p = oaCache.get(env.ASSETS);
  if (!p) {
    p = (async () => {
      const [render, runtime] = await Promise.all([
        readManifest(env, "/_oa/manifest.json"),
        readManifest(env, "/_oa/runtime.manifest.json"),
      ]);
      const files = new Set<string>();
      collect(render, files);
      collect(runtime, files);
      const rt = entryOf(runtime);
      return {
        render: entryOf(render),
        runtimeTag: rt ? `<script src="/_oa/${esc(rt.js)}"></script>` : null,
        files,
      };
    })();
    p.catch(() => oaCache.delete(env.ASSETS));
    oaCache.set(env.ASSETS, p);
  }
  return p;
}

// ---------------------------------------------------------------- manifests

/** In-isolate LRU of immutable version manifests (never visibility/deletion). */
const LRU_MAX = 200;
const lru = new Map<string, VersionData>();
function lruGet(k: string): VersionData | undefined {
  const v = lru.get(k);
  if (v) {
    lru.delete(k);
    lru.set(k, v);
  }
  return v;
}
function lruSet(k: string, v: VersionData): void {
  lru.set(k, v);
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value as string);
}

type Row = {
  format: Format;
  current_version: number;
  visibility: string;
  deleted_at: number | null;
  /** The token's bound viewer (P3 T11); null without a uid or a user row. */
  viewer_status: string | null;
  viewer_epoch: number | null;
  entry?: string;
  manifest?: string;
  language?: string | null;
  vformat?: Format | null;
};

// The bound viewer's row by primary key, in the same statement (P3 T11):
// with no uid (?2 null) the join matches nothing. No KV deny list, and the
// space's public-links toggle is deliberately absent (it only blocks new
// public links).
const VIEWER_COLS =
  "u.status as viewer_status, u.session_epoch as viewer_epoch";
const VIEWER_JOIN = "left join users u on u.id = ?2";

/**
 * One D1 read: the artifact's live state, the token's viewer (status and
 * epoch), plus the version's manifest on an LRU miss. Null when the artifact
 * or version doesn't exist.
 */
async function load(
  env: Env,
  id: string,
  v: number,
  uid: string | null,
): Promise<{ row: Row; data: VersionData } | null> {
  const key = `${id}:${v}`;
  const cached = lruGet(key);
  if (cached) {
    const row = await env.DB.prepare(
      `select a.format, a.current_version, a.visibility, a.deleted_at, ${VIEWER_COLS}
       from artifacts a ${VIEWER_JOIN} where a.id = ?1`,
    )
      .bind(id, uid)
      .first<Row>();
    return row ? { row, data: cached } : null;
  }
  const row = await env.DB.prepare(
    `select a.format, a.current_version, a.visibility, a.deleted_at, v.entry, v.manifest, v.language,
       v.format as vformat, ${VIEWER_COLS}
     from artifacts a join versions v on v.artifact_id = a.id ${VIEWER_JOIN}
     where a.id = ?1 and v.version = ?3`,
  )
    .bind(id, uid, v)
    .first<Row>();
  if (!row || row.entry == null || row.manifest == null) return null;
  const entries = JSON.parse(row.manifest) as ManifestEntry[];
  const data: VersionData = {
    entry: row.entry,
    language: row.language ?? null,
    format: row.vformat ?? null,
    files: new Map(entries.map((e) => [e.path, e])),
  };
  lruSet(key, data);
  return { row, data };
}

// ------------------------------------------------------------------ helpers

const TEXTY =
  /^(text\/[^;]+|application\/(javascript|json|xml|[^;]*\+(xml|json))|image\/svg\+xml)\s*(;|$)/i;
/** Text types get `; charset=utf-8` unless a charset is already present. */
function withCharset(ct: string): string {
  return TEXTY.test(ct) && !/;\s*charset=/i.test(ct)
    ? `${ct}; charset=utf-8`
    : ct;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");

/**
 * Static renderer page for markdown/code/pdf; only escaped metadata inline.
 * The runtime follows the oa-format meta: it reads it at startup and leaves
 * hello and thumb.request to the renderer on these pages.
 */
function renderPage(
  oa: Oa,
  entry: string,
  format: Format,
  language: string | null,
) {
  const r = oa.render;
  if (!r) return null;
  const css = r.css
    .map((f) => `<link rel="stylesheet" href="/_oa/${esc(f)}">\n`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="oa-entry" content="${esc(entry)}">
<meta name="oa-format" content="${esc(format)}">
<meta name="oa-language" content="${esc(language ?? "")}">
${oa.runtimeTag ?? ""}${css}<script type="module" src="/_oa/${esc(r.js)}"></script>
</head><body></body></html>
`;
}

const RENDERER_MISSING = `<!doctype html>
<html><head><meta charset="utf-8"><title>Renderer not deployed yet</title></head>
<body><p>Renderer not deployed yet.</p></body></html>
`;

/** Decode once (malformed escapes, e.g. `100%.txt`, stay raw), normalize; null when invalid. */
function filePath(rest: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(rest);
  } catch {
    p = rest;
  }
  const r = normalizePath(p);
  return r.ok ? r.path : null;
}

/** Single `bytes=` range → R2 range; undefined = serve whole; null = 416. */
function parseRange(
  h: string | undefined,
  size: number,
): { offset: number; length: number } | undefined | null {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return null;
    const len = Math.min(n, size);
    return { offset: size - len, length: len };
  }
  const start = Number(m[1]);
  if (start >= size) return null;
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return undefined;
  return { offset: start, length: end - start + 1 };
}

const isHtml = (ct: string) => /^text\/html\s*(;|$)/i.test(ct);

/** `attachment` with the file's basename, RFC 6266/5987 encoded. */
function attachment(path: string): string {
  const name = path.split("/").pop() || "download";
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const star = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/**
 * Streams one manifest file. text/html always gets the runtime injected
 * (whole body; Range is ignored for HTML); others honor a single byte range.
 * A download is the stored bytes as an attachment: no injection, ranges kept.
 */
async function serveFile(
  c: Context<CEnv>,
  e: ManifestEntry,
  cache: string,
  contentType = e.contentType,
  download = false,
): Promise<Response> {
  const html = !download && isHtml(contentType);
  const headers = new Headers({
    "Content-Type": withCharset(contentType),
    "Cache-Control": cache,
  });
  if (download) headers.set("Content-Disposition", attachment(e.path));
  if (html) {
    const obj = await c.env.FILES.get(e.key);
    if (!obj) throw notFound();
    const { runtimeTag } = await loadOa(c.env);
    return injectRuntime(new Response(obj.body, { headers }), runtimeTag);
  }
  headers.set("Accept-Ranges", "bytes");
  const range = parseRange(c.req.header("range"), e.size);
  if (range === null) {
    headers.set("Content-Range", `bytes */${e.size}`);
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 416, headers });
  }
  const obj = await c.env.FILES.get(e.key, range ? { range } : undefined);
  if (!obj) throw notFound();
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`,
    );
    headers.set("Content-Length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function serve(
  c: Context<CEnv>,
  id: string,
  vRaw: string,
  rest: string,
  signed: string | null,
): Promise<Response> {
  if (!isId(id) || !VERSION_NUM.test(vRaw)) throw notFound();
  const v = Number(vRaw);
  // `dl` must be exactly one `dl=1`; anything else under that name is tampering.
  const dls = new URL(c.req.url).searchParams.getAll("dl");
  if (dls.length > 1 || (dls.length === 1 && dls[0] !== "1")) throw notFound();
  const dl = dls.length === 1;
  // Downloads are signed only: an unsigned /p/ URL can't ask for one.
  let mode: SignMode | null = "frame";
  let viewer: ContentViewer | null = null;
  if (signed !== null) {
    const t = await verifyContentToken(c.env, signed, id, v, dl);
    mode = t?.mode ?? null;
    viewer = t?.viewer ?? null;
  } else if (dl) mode = null;
  if (mode === null) throw notFound();
  const path = rest === "__view" ? "__view" : filePath(rest);
  if (path === null || (mode === "dl" && path === "__view")) throw notFound();
  const got = await load(c.env, id, v, viewer?.uid ?? null);
  if (!got) throw notFound();
  const { row, data } = got;
  if (row.deleted_at != null) throw notFound();
  // A uid-bound token serves only while its user is active and still at the
  // epoch it was minted under (any status change bumps it).
  if (
    viewer &&
    (row.viewer_status !== "active" || row.viewer_epoch !== viewer.epoch)
  )
    throw notFound();
  if (
    signed === null &&
    !isPubliclyServable({
      visibility: row.visibility,
      deleted: row.deleted_at != null,
    })
  )
    throw notFound();
  // The content host never renders top level: a browser's top-level visit
  // goes to the viewer on the app host (fixed origin, validated id and v).
  // The one exception is server-side thumbnail capture, proven by a MAC'd
  // request header that never appears in a URL; that response is not cached.
  let capture = false;
  if (mode === "frame" && c.req.header("sec-fetch-dest") === "document") {
    capture = await verifyCapture(c.env, c.req.header(CAPTURE_HEADER), id, v);
    if (!capture) return toViewer(c.env, id, v, row.current_version);
  }
  const cache = capture
    ? "no-store"
    : signed === null
      ? CACHE_PUBLIC
      : CACHE_SIGNED;

  if (path !== "__view") {
    const e = data.files.get(path);
    if (!e) throw notFound();
    return serveFile(c, e, cache, e.contentType, mode === "dl");
  }
  const format = data.format ?? row.format;
  if (format !== "html") {
    const oa = await loadOa(c.env);
    const page = renderPage(oa, data.entry, format, data.language);
    return new Response(page ?? RENDERER_MISSING, {
      status: page ? 200 : 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": page ? cache : "no-store",
      },
    });
  }
  // A nested entry must load from its own directory so relative URLs work.
  if (data.entry.includes("/"))
    return new Response(null, {
      status: 302,
      headers: { Location: entryLocation(data.entry), "Cache-Control": cache },
    });
  const e = data.files.get(data.entry);
  if (!e) throw notFound();
  return serveFile(c, e, cache, "text/html");
}

/**
 * 303 to the viewer, nothing else: the current version opens full-screen
 * (`/a/{id}/full`), an older one at `/a/{id}/v/{v}`. Never cached.
 */
function toViewer(env: Env, id: string, v: number, current: number) {
  const path = v === current ? `${viewerPath(id)}/full` : viewerPath(id, v);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${appOrigin(env)}${path}`,
      "Cache-Control": "no-store",
    },
  });
}

/** Relative, per-segment-encoded; ':' encoded so it can't read as a scheme. */
const entryLocation = (entry: string) =>
  entry
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/:/g, "%3A"))
    .join("/");

// ---------------------------------------------------------------------- app

/** Content host: untrusted artifact files only. No session, no cookies. */
export const contentApp = new Hono<CEnv>();

// On every response, errors included (onError/notFound run inside compose).
contentApp.use(
  mw(async (c, next) => {
    await next();
    c.res = new Response(c.res.body, c.res);
    const h = c.res.headers;
    // Embed origins may frame only served public content, never signed/private.
    const publicOk =
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      c.res.ok &&
      PUBLIC.test(new URL(c.req.url).pathname);
    h.delete("Set-Cookie");
    h.set(
      "Content-Security-Policy",
      `${CONTENT_CSP}; frame-ancestors ${contentFrameAncestors(c.env, appOrigin(c.env), publicOk)}`,
    );
    h.set("Cross-Origin-Resource-Policy", "cross-origin");
    // Sandboxed (opaque-origin) frames send `Origin: null`: allow any origin,
    // never with credentials, and never vary on Origin. A top-level visit gets
    // a redirect instead of the content (unless it's a capture): caches must
    // key on both.
    h.set("Access-Control-Allow-Origin", "*");
    h.delete("Access-Control-Allow-Credentials");
    h.set("Vary", `Sec-Fetch-Dest, ${CAPTURE_HEADER}`);
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    if (c.res.status >= 400 || !h.has("Cache-Control"))
      h.set("Cache-Control", "no-store");
  }),
);
contentApp.use(enforceContentPolicy());
contentApp.onError((e) => toErrorResponse(e));
contentApp.notFound(() => toErrorResponse(notFound()));

contentApp.get("/robots.txt", (c) => c.text(ROBOTS));
// Ordering: after the GET route so only non-GET/HEAD methods land here.
contentApp.all("/robots.txt", methodNotAllowed);

// Only files named by the /_oa manifests are served from ASSETS (its SPA
// fallback would otherwise answer every miss with index.html).
contentApp.get("/_oa/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  let name: string;
  try {
    name = decodeURIComponent(path.slice("/_oa/".length));
  } catch {
    throw notFound();
  }
  if (!(await loadOa(c.env)).files.has(name)) throw notFound();
  const r = await c.env.ASSETS.fetch(new Request(new URL(path, ASSET_ORIGIN)));
  if (!r.ok) throw notFound();
  const headers = new Headers({ "Cache-Control": IMMUTABLE });
  for (const h of ["Content-Type", "ETag", "Content-Length"]) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (/\.m?js$/i.test(name)) headers.set("Content-Type", JS);
  else if (/\.css$/i.test(name))
    headers.set("Content-Type", "text/css; charset=utf-8");
  return new Response(r.body, { headers });
});

// Raw pathname: Hono's param decoding is bypassed so we decode exactly once.
contentApp.get("*", (c) => {
  const p = new URL(c.req.url).pathname;
  const s = SIGNED.exec(p);
  if (s) return serve(c, s[2] ?? "", s[3] ?? "", s[4] ?? "", s[1] ?? "");
  const q = PUBLIC.exec(p);
  if (q) return serve(c, q[1] ?? "", q[2] ?? "", q[3] ?? "", null);
  throw notFound();
});

// Build the route matchers at module scope, not on the first request (see app.ts).
contentApp.router.match("GET", "/");
