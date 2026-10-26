/**
 * MSW v2 handlers mirroring the R.* contract (see the JSDoc on each key in routes.ts).
 *
 * - Stateful: every createHandlers() call deep-copies the fixtures, and mutations are
 *   reflected by later reads. Ids and timestamps are stable within an instance.
 * - Relative patterns (`*` + path), so any origin works.
 * - Access: owner/editor may publish, patch and restore; only the owner may share, change
 *   visibility, delete or undelete. A caller without the needed access gets 404, never 403.
 * - CSRF (test convenience): a mutating request carrying a `cookie` header but no
 *   `X-OA-Request: 1` gets 403 csrf; Bearer requests are exempt.
 * - Auth: a request with no cookie and no Bearer gets 401 on every authed route (all mutations
 *   except signed-URL upload PUT, plus me/members/tokens/oauth-clients/settings/usage/list/search);
 *   public-artifact reads stay anonymous-OK, and so do data doc writes on a public artifact
 *   with allowAnonymousWrites (updatedBy "anon"), as on the server (B13). An anonymous read
 *   of a non-public artifact (GET, content-url, versions, data list/query/doc) gets 404, and
 *   so does an anonymous data/storage write to one (the server checks access first).
 *   `X-OA-Embed: 1` (or `?embed=1`) counts as anonymous even with a cookie or Bearer.
 * - quotaExceeded: every /api/v1 route answers 503 quota_exceeded.
 * - emailEnabled: sets Me.instance.emailEnabled (default false, from the fixtures).
 * - update: sets Me.instance.update (default null, from the fixtures).
 * - hosted: opt-in hosted M1 mocks (./hosted.ts): sign-in, spaces, roles, `can`,
 *   directory, transfer. Off by default, so every existing response is unchanged.
 */
import { delay, type HttpHandler, HttpResponse, http } from "msw";
import type { z } from "zod";
import { type ErrorCode, QUOTA_MESSAGE, STATUS_FOR } from "../errors.js";
import type { Format } from "../formats.js";
import { newId, newPat } from "../ids.js";
import {
  INLINE_TOO_LARGE_MESSAGE,
  LIMITS,
  type Plan,
  usageLimit,
  VERSIONS_PAGE_SIZE,
} from "../limits.js";
import { viewerPath } from "../routes.js";
import {
  ArtifactPatchSchema,
  type ArtifactSummary,
  type DataDoc,
  DataNameSchema,
  DataPatchBodySchema,
  DataQuerySchema,
  DataSetBodySchema,
  type FileEntry,
  type InstanceUpdate,
  ListQuerySchema,
  type Member,
  MemberInviteSchema,
  MemberPatchSchema,
  MePatchSchema,
  OAuthClientPatchSchema,
  PublishInputSchema,
  resolveDataWriters,
  SettingsPatchSchema,
  type Share,
  ShareInputSchema,
  SNIPPET_MARK,
  type StorageEntry,
  StorageSetBodySchema,
  TokenCreateInputSchema,
  TokenPatchSchema,
  UploadCreateInputSchema,
  type UserRef,
} from "../schemas.js";
import type { ArtifactEventsMock } from "./events.js";
import { fixtures } from "./fixtures.js";
import { createHostedMock, type HostedMockOptions } from "./hosted.js";

export type MockOptions = {
  latencyMs?: number;
  quotaExceeded?: boolean;
  emailEnabled?: boolean;
  /** Me.instance.plan, and GET /usage `plan` and its limits (default "free"). */
  plan?: Plan;
  update?: InstanceUpdate | null;
  /**
   * The R.events mock (createArtifactEvents()): hello reports the store's
   * currentVersion; publish/restore emit `version`, delete and
   * visibility/capabilities changes emit `gone`.
   */
  events?: ArtifactEventsMock;
  /** Hosted M1 mocks (true = defaults). Off by default. */
  hosted?: boolean | HostedMockOptions;
};

const err = (code: ErrorCode, message: string, details?: unknown) =>
  HttpResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: STATUS_FOR[code] },
  );
const notFound = () => err("not_found", "Not found");
const badRequest = (m: string) => err("bad_request", m);
const noContent = () => new HttpResponse(null, { status: 204 });
const iso = () => new Date().toISOString();

// 1x1 lossless WebP.
const WEBP = Uint8Array.from(
  atob("UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAfQ//73v/+BiOh/AAA="),
  (c) => c.charCodeAt(0),
);
const TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
};
const typeOf = (path: string) =>
  TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
const DEFAULT_ENTRY = {
  html: "index.html",
  markdown: "document.md",
  code: "file.txt",
  pdf: "document.pdf",
} as const;

/**
 * Anonymous = no cookie and no Bearer token, or the embed-mode hint
 * (`X-OA-Embed: 1`, or `?embed=1` on the data-subscribe socket), which drops
 * both, as on the server.
 */
const isAnon = (req: Request) =>
  req.headers.get("x-oa-embed") === "1" ||
  new URL(req.url).searchParams.get("embed") === "1" ||
  (!req.headers.has("cookie") &&
    !/^bearer\s/i.test(req.headers.get("authorization") ?? ""));
const hideEmail = (u: UserRef): UserRef => ({ ...u, email: null });
const redactArt = (a: ArtifactSummary, req: Request): ArtifactSummary =>
  a.visibility === "public" && isAnon(req)
    ? { ...a, owner: hideEmail(a.owner) }
    : a;

const userRef = (u: UserRef): UserRef => ({
  id: u.id,
  email: u.email,
  name: u.name,
});

async function body<T extends z.ZodType>(req: Request, schema: T) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: badRequest("Body must be valid JSON") };
  }
  const r = schema.safeParse(raw);
  // Oversize inline content is 413, as on the server.
  if (
    !r.success &&
    r.error.issues.some((i) => i.message === INLINE_TOO_LARGE_MESSAGE)
  )
    return { error: err("too_large", INLINE_TOO_LARGE_MESSAGE) };
  if (!r.success)
    return {
      error: err("bad_request", "Invalid request body", r.error.issues),
    };
  return { data: r.data as z.infer<T> };
}

const params = (q: URLSearchParams) => {
  const o: Record<string, string> = {};
  q.forEach((v, k) => {
    o[k] = v;
  });
  return o;
};
const encodeCursor = (n: number) => btoa(String(n));
function decodeCursor(c: string | null | undefined): number {
  if (!c) return 0;
  try {
    const n = Number(atob(c));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function paginate<T>(all: T[], q: URLSearchParams, defLimit = 25) {
  const limit = Math.min(
    500,
    Math.max(1, Math.trunc(Number(q.get("limit"))) || defLimit),
  );
  const start = decodeCursor(q.get("cursor"));
  const next = start + limit;
  return HttpResponse.json({
    items: all.slice(start, next),
    nextCursor: next < all.length ? encodeCursor(next) : null,
  });
}

type Params = Record<string, string | readonly string[] | undefined>;
type Ctx = { request: Request; params: Params };
type Need = "read" | "write" | "owner";
const A = "*/api/v1/artifacts/:id";

export function createHandlers(opts: MockOptions = {}): HttpHandler[] {
  const { latencyMs = 0, quotaExceeded = false, plan = "free" } = opts;
  const f = structuredClone(fixtures);
  const me = f.me;
  if (opts.emailEnabled !== undefined)
    me.instance.emailEnabled = opts.emailEnabled;
  me.instance.plan = plan;
  if (opts.update !== undefined) me.instance.update = opts.update;
  const artifacts: ArtifactSummary[] = f.artifacts;
  if (opts.events)
    opts.events.currentVersion = (id) =>
      artifacts.find((x) => x.id === id && x.deletedAt === null)
        ?.currentVersion;
  const versions = f.versions;
  const files = new Map(Object.entries(f.files));
  const shares = f.shares;
  const members: Member[] = f.members;
  const tokens = f.tokens;
  const clients = f.oauthClients;
  const data = new Map<string, Map<string, Map<string, DataDoc>>>();
  const storage = new Map<string, Map<string, StorageEntry>>();
  for (const d of f.data) {
    const cols = data.get(d.artifactId) ?? new Map();
    const col = cols.get(d.collection) ?? new Map();
    col.set(d.doc.id, d.doc);
    cols.set(d.collection, col);
    data.set(d.artifactId, cols);
  }
  for (const s of f.storage) {
    const m = storage.get(s.artifactId) ?? new Map();
    m.set(s.entry.key, s.entry);
    storage.set(s.artifactId, m);
  }
  const docs = (id: string, col: string) => {
    const cols = data.get(id) ?? new Map<string, Map<string, DataDoc>>();
    data.set(id, cols);
    const c = cols.get(col) ?? new Map<string, DataDoc>();
    cols.set(col, c);
    return c;
  };
  const store = (id: string) => {
    const m = storage.get(id) ?? new Map<string, StorageEntry>();
    storage.set(id, m);
    return m;
  };
  const fileBody = (id: string, v: number, path: string) =>
    files.get(`${id}/${v}/${path}`) ?? `mock ${path} (v${v})`;

  /** Owner-level actions; a hosted space manager has them too (not transfer). */
  const full = (a: ArtifactSummary) =>
    a.access === "owner" || a.access === "manager";
  /** Resolve a live artifact the caller may use at the given level, else 404. */
  const withArt =
    (
      fn: (a: ArtifactSummary, ctx: Ctx) => Response | Promise<Response>,
      need: Need = "read",
    ) =>
    (ctx: Ctx) => {
      const a = artifacts.find((x) => x.id === ctx.params.id);
      if (!a || a.deletedAt !== null) return notFound();
      // Anonymous callers see only public artifacts; anything else is 404.
      if (a.visibility !== "public" && isAnon(ctx.request)) return notFound();
      if (need === "owner" && !full(a)) return notFound();
      if (need === "write" && a.access === "viewer") return notFound();
      return fn(a, ctx);
    };
  const names = (...v: unknown[]) =>
    v.every((x) => DataNameSchema.safeParse(x).success)
      ? undefined
      : badRequest("Invalid collection, document or key name");

  const addVersion = (
    a: ArtifactSummary,
    v: {
      message: string | null;
      entry: string;
      language: string | null;
      format: Format;
      list: FileEntry[];
      bodies: Map<string, string>;
      restoredFrom?: number;
    },
  ): Response => {
    const list = versions[a.id] ?? [];
    versions[a.id] = list;
    const version = Math.max(0, ...list.map((x) => x.version)) + 1;
    const createdAt = iso();
    list.unshift({
      version,
      message: v.message,
      agent: null,
      createdBy: userRef(me.user),
      createdAt,
      entry: v.entry,
      files: v.list,
      language: v.language,
      textIndexed: !v.list.some((x) => x.contentType === "application/pdf"),
      format: v.format,
    });
    a.format = v.format;
    for (const [p, b] of v.bodies) files.set(`${a.id}/${version}/${p}`, b);
    a.currentVersion = version;
    a.updatedAt = createdAt;
    opts.events?.emitVersion(a.id, {
      version,
      at: createdAt,
      by: { kind: "user", name: me.user.name ?? me.user.email ?? undefined },
      ...(v.restoredFrom === undefined ? {} : { restoredFrom: v.restoredFrom }),
    });
    return HttpResponse.json(
      { id: a.id, version, url: me.instance.appUrl + viewerPath(a.id) },
      { status: 201 },
    );
  };
  const publishTo = (
    a: ArtifactSummary,
    input: z.infer<typeof PublishInputSchema>,
  ): Response => {
    const bodies = new Map<string, string>();
    let entry: string;
    if (input.content !== undefined) {
      entry =
        input.entry ?? DEFAULT_ENTRY[input.format ?? a.format] ?? "index.html";
      bodies.set(entry, input.content);
    } else {
      for (const [p, c] of Object.entries(input.files ?? {})) {
        bodies.set(
          p,
          typeof c === "string" ? c : "base64" in c ? atob(c.base64) : "",
        );
      }
      entry = input.entry ?? [...bodies.keys()][0] ?? "index.html";
    }
    if (input.title) a.title = input.title;
    if (input.description !== undefined) a.description = input.description;
    if (input.format) a.format = input.format;
    a.lastAgent = null;
    return addVersion(a, {
      message: input.message ?? null,
      entry,
      language: input.language ?? null,
      format: a.format,
      bodies,
      list: [...bodies].map(([path, b]) => ({
        path,
        size: new TextEncoder().encode(b).length,
        contentType: typeOf(path),
      })),
    });
  };

  const withScope = (q: URLSearchParams, scope: string) => {
    const c = new URLSearchParams(q);
    c.set("scope", scope);
    return c;
  };
  const matches = (a: ArtifactSummary, q: URLSearchParams) => {
    const needle = (q.get("q") ?? "").toLowerCase();
    const scope = q.get("scope") ?? "all";
    const owner = q.get("owner");
    return (
      (q.get("includeDeleted") === "true" || a.deletedAt === null) &&
      (scope === "all" ||
        (scope === "mine" && a.owner.id === me.user.id) ||
        (scope === "shared" && a.access !== "owner") ||
        (scope === "team" && a.visibility === "team")) &&
      (!q.get("format") || a.format === q.get("format")) &&
      (!q.get("visibility") || a.visibility === q.get("visibility")) &&
      (!owner || a.owner.id === owner || a.owner.email === owner) &&
      (!q.get("agent") || a.lastAgent?.name === q.get("agent")) &&
      (!needle ||
        a.title.toLowerCase().includes(needle) ||
        (a.description ?? "").toLowerCase().includes(needle))
    );
  };
  const mark = (text: string, needle: string) => {
    const i = text.toLowerCase().indexOf(needle.toLowerCase());
    return i < 0
      ? null
      : `${text.slice(0, i)}${SNIPPET_MARK.open}${text.slice(i, i + needle.length)}${SNIPPET_MARK.close}${text.slice(i + needle.length)}`;
  };
  const byId = <T>(list: T[], key: (x: T) => string, id: unknown): number =>
    list.findIndex((x) => key(x) === id);
  const settings = () => ({
    name: me.instance.name,
    defaultVisibility: me.instance.defaultVisibility,
  });

  /** A data doc write on a public artifact that allows anonymous writes (B13). */
  const anonDataWrite = (path: string): boolean => {
    const m = /^\/artifacts\/([^/]+)\/data\/[^/]+\/[^/]+$/.exec(path);
    const a = m && artifacts.find((x) => x.id === m[1]);
    return !!a && a.visibility === "public" && a.allowAnonymousWrites === true;
  };
  /** updatedBy for a data write: "anon" for anonymous callers. */
  const writer = (request: Request) => (isAnon(request) ? "anon" : me.user.id);

  const h = opts.hosted
    ? createHostedMock(opts.hosted === true ? {} : opts.hosted, {
        me,
        members,
        artifacts,
        shares,
        err,
        body,
        isAnon,
      })
    : null;

  const pre: HttpHandler[] = [
    http.all("*/api/v1/*", async ({ request }) => {
      if (latencyMs) await delay(latencyMs);
      if (quotaExceeded) return err("quota_exceeded", QUOTA_MESSAGE);
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      const path = new URL(request.url).pathname.replace(/^.*\/api\/v1/, "");
      // Signed-URL uploads carry no session; public artifact reads are anonymous-OK.
      const needsAuth = mutating
        ? !/^\/uploads\/[^/]+$/.test(path)
        : /^\/(me|members|tokens|oauth-clients|settings|usage|artifacts|search)\/?$/.test(
            path,
          );
      // Runtime routes (data/storage) check access first, as on the server:
      // an anonymous caller gets 404 on a non-public artifact, then 401 for a
      // write it may not make; a data query is a read.
      const rt = /^\/artifacts\/([^/]+)\/(data|storage)(?:\/|$)/.exec(path);
      if (needsAuth && isAnon(request) && rt) {
        const a = artifacts.find((x) => x.id === rt[1]);
        if (!a || a.deletedAt !== null || a.visibility !== "public")
          return notFound();
        const query = rt[2] === "data" && /\/query$/.test(path);
        if (!query && !anonDataWrite(path))
          return err("unauthorized", "Authentication required");
      } else if (needsAuth && isAnon(request) && !anonDataWrite(path))
        return err("unauthorized", "Authentication required");
      if (
        mutating &&
        request.headers.has("cookie") &&
        request.headers.get("x-oa-request") !== "1"
      )
        return err("csrf", "Missing X-OA-Request header");
      return undefined; // fall through to the route handlers
    }),
  ];

  return [
    ...pre,
    ...(h?.handlers ?? []),
    http.get("*/api/v1/me", () => HttpResponse.json(me)),
    http.patch("*/api/v1/me", async ({ request }) => {
      const r = await body(request, MePatchSchema);
      if (r.error) return r.error;
      me.displayName = r.data.displayName;
      me.needsDisplayName = false;
      me.user.name = r.data.displayName;
      return HttpResponse.json(me);
    }),
    http.get("*/api/v1/artifacts", ({ request }) => {
      if (isAnon(request))
        return err("unauthorized", "Authentication required");
      const q = new URL(request.url).searchParams;
      // Hosted mocks narrow the space scopes ("space", "spaces") like the server.
      const p = ListQuerySchema.safeParse(params(q));
      if (!p.success)
        return err("bad_request", "Invalid query", p.error.issues);
      const inSpace = h?.listScope(p.data.scope, q.get("spaceId") ?? undefined);
      if (inSpace instanceof Response) return inSpace;
      return paginate(
        artifacts
          .filter((a) => (inSpace ? inSpace(a.space) : matches(a, q)))
          .filter((a) => !inSpace || matches(a, withScope(q, "all")))
          .map((a) => redactArt(a, request)),
        q,
      );
    }),
    http.post("*/api/v1/artifacts", async ({ request }) => {
      const r = await body(request, PublishInputSchema);
      if (r.error) return r.error;
      const existing = r.data.id
        ? artifacts.find((a) => a.id === r.data.id)
        : undefined;
      const placed = h?.checkPublish(r.data, existing);
      if (placed instanceof Response) return placed;
      if (h && !existing) {
        const refused = h.refuseCappedCreate();
        if (refused) return refused;
      }
      const noPublic = h?.refusePublic(
        existing ? existing.space : placed?.space,
        r.data.visibility,
        existing?.visibility,
      );
      if (noPublic) return noPublic;
      if (!existing && r.data.id && r.data.title === undefined)
        return badRequest("title is required when creating an artifact");
      if (existing)
        return existing.deletedAt !== null || existing.access === "viewer"
          ? notFound()
          : publishTo(existing, r.data);
      const now = iso();
      const a: ArtifactSummary = {
        id: r.data.id ?? newId(),
        title: r.data.title ?? "Untitled",
        description: r.data.description ?? null,
        format: r.data.format ?? "html",
        visibility: r.data.visibility ?? me.instance.defaultVisibility,
        owner: userRef(me.user),
        currentVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastAgent: null,
        thumbnailUrl: null,
        thumbnailVersion: null,
        access: "owner",
        capabilities: {
          db: false,
          viewer: false,
          storage: false,
          ...r.data.capabilities,
        },
        allowAnonymousWrites: r.data.allowAnonymousWrites ?? false,
        dataWriters:
          resolveDataWriters(
            r.data,
            r.data.visibility ?? me.instance.defaultVisibility,
          ) ?? "viewers",
      };
      artifacts.unshift(a);
      h?.placeNew(a, placed?.space ?? null);
      versions[a.id] = [];
      return publishTo(a, r.data);
    }),
    http.get(
      A,
      withArt((a, { request }) => HttpResponse.json(redactArt(a, request))),
    ),
    http.patch(A, async (ctx) => {
      return withArt(async (a) => {
        const r = await body(ctx.request, ArtifactPatchSchema);
        if (r.error) return r.error;
        if (r.data.visibility !== undefined && !full(a)) return notFound();
        const noPublic = h?.refusePublic(
          a.space,
          r.data.visibility,
          a.visibility,
        );
        if (noPublic) return noPublic;
        const { capabilities, ...rest } = r.data;
        const gone =
          (rest.visibility !== undefined && rest.visibility !== a.visibility) ||
          capabilities !== undefined;
        const dataWriters = resolveDataWriters(
          rest,
          rest.visibility ?? a.visibility,
        );
        Object.assign(a, rest, { updatedAt: iso() });
        if (dataWriters) a.dataWriters = dataWriters;
        if (capabilities) Object.assign(a.capabilities, capabilities);
        if (gone) opts.events?.emitGone(a.id, "changed");
        return HttpResponse.json(a);
      }, "write")(ctx);
    }),
    http.delete(
      A,
      withArt((a) => {
        a.deletedAt = iso();
        opts.events?.emitGone(a.id, "deleted");
        return noContent();
      }, "owner"),
    ),
    http.post(`${A}/undelete`, ({ params }) => {
      const a = artifacts.find((x) => x.id === params.id);
      if (!a || !full(a)) return notFound();
      a.deletedAt = null;
      return HttpResponse.json(a);
    }),
    http.get(
      `${A}/versions`,
      withArt((a, { request }) => {
        const raw = new URL(request.url).searchParams.get("before");
        if (raw !== null && !/^[1-9]\d*$/.test(raw))
          return badRequest("before must be a positive integer");
        const before = raw === null ? Infinity : Number(raw);
        const anon = a.visibility === "public" && isAnon(request);
        return HttpResponse.json(
          (versions[a.id] ?? [])
            .filter((v) => v.version < before)
            .sort((x, y) => y.version - x.version)
            .slice(0, VERSIONS_PAGE_SIZE)
            .map((v) =>
              anon ? { ...v, createdBy: hideEmail(v.createdBy) } : v,
            ),
        );
      }),
    ),
    http.post(
      `${A}/versions`,
      withArt(async (a, { request }) => {
        const r = await body(request, PublishInputSchema);
        return r.error ?? publishTo(a, r.data);
      }, "write"),
    ),
    http.get(
      `${A}/versions/:v/files/:path+`,
      withArt((a, { params }) => {
        const v = Number(params.v);
        const path = ([] as string[]).concat(params.path ?? []).join("/");
        const info = (versions[a.id] ?? []).find((x) => x.version === v);
        const file = info?.files.find((x) => x.path === path);
        return file
          ? new HttpResponse(fileBody(a.id, v, path), {
              headers: { "content-type": file.contentType },
            })
          : notFound();
      }),
    ),
    http.post(
      `${A}/versions/:v/restore`,
      withArt((a, { params }) => {
        const src = (versions[a.id] ?? []).find(
          (x) => x.version === Number(params.v),
        );
        if (!src) return notFound();
        const bodies = new Map(
          src.files.map((x) => [x.path, fileBody(a.id, src.version, x.path)]),
        );
        return addVersion(a, {
          message: `Restored v${src.version}`,
          entry: src.entry,
          language: src.language,
          format: src.format,
          list: structuredClone(src.files),
          bodies,
          restoredFrom: src.version,
        });
      }, "write"),
    ),
    http.put(
      `${A}/versions/:v/text`,
      withArt((a, { params }) => {
        return (versions[a.id] ?? []).some(
          (x) => x.version === Number(params.v),
        )
          ? noContent()
          : notFound();
      }, "write"),
    ),
    http.get(
      `${A}/thumbnail`,
      withArt((a) =>
        a.thumbnailUrl
          ? new HttpResponse(WEBP, {
              headers: { "content-type": "image/webp" },
            })
          : notFound(),
      ),
    ),
    http.put(
      `${A}/thumbnail`,
      withArt((a) => {
        a.thumbnailVersion = a.currentVersion;
        a.thumbnailUrl = `/api/v1/artifacts/${a.id}/thumbnail?v=${a.currentVersion}`;
        return noContent();
      }, "write"),
    ),
    http.get(
      `${A}/content-url`,
      withArt((a) =>
        HttpResponse.json({
          url: `https://content.example.com/c/${a.id}/index.html?sig=mock`,
          expiresAt:
            a.visibility === "public"
              ? null
              : new Date(
                  Date.now() + LIMITS.signedUrlTtlSec * 1000,
                ).toISOString(),
        }),
      ),
    ),
    http.get(
      `${A}/shares`,
      withArt((a) => HttpResponse.json(shares[a.id] ?? [])),
    ),
    http.put(
      `${A}/shares`,
      withArt(async (a, { request }) => {
        const r = await body(request, ShareInputSchema);
        if (r.error) return r.error;
        const email = r.data.email.toLowerCase();
        if (email === a.owner.email?.toLowerCase())
          return badRequest("Cannot share with the owner");
        const list = shares[a.id] ?? [];
        shares[a.id] = list;
        const i = byId(list, (s) => s.email, email);
        const share: Share = {
          email,
          role: r.data.role,
          createdAt: list[i]?.createdAt ?? iso(),
        };
        if (i >= 0) list[i] = share;
        else list.push(share);
        return HttpResponse.json({ ...share, emailed: false });
      }, "owner"),
    ),
    http.delete(
      `${A}/shares/:email`,
      withArt((a, { params }) => {
        const list = shares[a.id] ?? [];
        const i = byId(
          list,
          (s) => s.email,
          String(params.email).toLowerCase(),
        );
        if (i < 0) return notFound();
        list.splice(i, 1);
        return noContent();
      }, "owner"),
    ),
    http.post("*/api/v1/uploads", async ({ request }) => {
      const r = await body(request, UploadCreateInputSchema);
      if (r.error) return r.error;
      const uploadId = newId();
      return HttpResponse.json(
        {
          uploadId,
          artifactId: r.data.artifactId ?? newId(),
          url: `${me.instance.appUrl}/api/v1/uploads/${uploadId}?sig=mock&exp=0`,
          expiresAt: new Date(
            Date.now() + LIMITS.uploadUrlTtlSec * 1000,
          ).toISOString(),
        },
        { status: 201 },
      );
    }),
    http.put("*/api/v1/uploads/:uploadId", () => noContent()),
    http.get("*/api/v1/search", ({ request }) => {
      if (isAnon(request))
        return err("unauthorized", "Authentication required");
      const q = new URL(request.url).searchParams;
      const needle = (q.get("q") ?? "").trim();
      if (!needle) return badRequest("q is required");
      // spaceId narrows the hits as the list's scope "space" does.
      const spaceId = q.get("spaceId") ?? undefined;
      const inSpace = spaceId ? h?.listScope("space", spaceId) : null;
      if (inSpace instanceof Response) return inSpace;
      const hits = artifacts
        .filter(
          (a) =>
            a.deletedAt === null &&
            (!inSpace || inSpace(a.space)) &&
            matches(a, new URLSearchParams({ q: needle })),
        )
        .map((a) => ({
          ...redactArt(a, request),
          snippet:
            mark(a.description ?? "", needle) ??
            mark(a.title, needle) ??
            a.title,
        }));
      return paginate(hits, q);
    }),
    http.get("*/api/v1/members", () => HttpResponse.json(members)),
    http.post("*/api/v1/members", async ({ request }) => {
      const r = await body(request, MemberInviteSchema);
      if (r.error) return r.error;
      const email = r.data.email.toLowerCase();
      if (members.some((m) => m.email === email))
        return err("conflict", "Already a member");
      const m: Member = {
        id: newId(),
        email,
        name: null,
        role: r.data.role,
        lastSeenAt: null,
      };
      members.push(m);
      return HttpResponse.json({ ...m, emailed: false }, { status: 201 });
    }),
    http.patch("*/api/v1/members/:id", async ({ request, params }) => {
      const m = members.find((x) => x.id === params.id);
      if (!m) return notFound();
      const r = await body(request, MemberPatchSchema);
      if (r.error) return r.error;
      if (m.role === "owner") return badRequest("The owner cannot be demoted");
      m.role = r.data.role;
      return HttpResponse.json(m);
    }),
    http.delete("*/api/v1/members/:id", ({ params }) => {
      const i = byId(members, (m) => m.id, params.id);
      if (i < 0) return notFound();
      if (members[i]?.role === "owner")
        return badRequest("The owner cannot be removed");
      members.splice(i, 1);
      return noContent();
    }),
    http.get("*/api/v1/tokens", () => HttpResponse.json(tokens)),
    http.post("*/api/v1/tokens", async ({ request }) => {
      const r = await body(request, TokenCreateInputSchema);
      if (r.error) return r.error;
      const t = {
        id: newId(),
        label: r.data.label,
        createdAt: iso(),
        lastUsedAt: null,
        versionsPublished: 0,
      };
      tokens.push(t);
      return HttpResponse.json({ ...t, token: newPat() }, { status: 201 });
    }),
    http.patch("*/api/v1/tokens/:id", async ({ request, params }) => {
      const t = tokens.find((x) => x.id === params.id);
      if (!t) return notFound();
      const r = await body(request, TokenPatchSchema);
      if (r.error) return r.error;
      t.label = r.data.label;
      return HttpResponse.json(t);
    }),
    http.delete("*/api/v1/tokens/:id", ({ params }) => {
      const i = byId(tokens, (t) => t.id, params.id);
      if (i < 0) return notFound();
      tokens.splice(i, 1);
      return noContent();
    }),
    http.get("*/api/v1/oauth-clients", () => HttpResponse.json(clients)),
    http.patch(
      "*/api/v1/oauth-clients/:grantId",
      async ({ request, params }) => {
        const c = clients.find((x) => x.grantId === params.grantId);
        if (!c) return notFound();
        const r = await body(request, OAuthClientPatchSchema);
        if (r.error) return r.error;
        if (r.data.label === null) delete c.label;
        else c.label = r.data.label;
        return HttpResponse.json(c);
      },
    ),
    http.delete("*/api/v1/oauth-clients/:grantId", ({ params }) => {
      const i = byId(clients, (c) => c.grantId, params.grantId);
      if (i < 0) return notFound();
      clients.splice(i, 1);
      return noContent();
    }),
    http.get("*/api/v1/settings", () => HttpResponse.json(settings())),
    http.patch("*/api/v1/settings", async ({ request }) => {
      const r = await body(request, SettingsPatchSchema);
      if (r.error) return r.error;
      Object.assign(me.instance, r.data);
      return HttpResponse.json(settings());
    }),
    http.get("*/api/v1/usage", () =>
      HttpResponse.json({
        available: true,
        plan,
        date: iso().slice(0, 10),
        metrics: [
          { key: "requests", used: 1200, limit: usageLimit(plan, "requests") },
          { key: "d1_reads", used: 3400, limit: usageLimit(plan, "d1_reads") },
          { key: "d1_writes", used: 120, limit: usageLimit(plan, "d1_writes") },
          {
            key: "do_requests",
            used: 80,
            limit: usageLimit(plan, "do_requests"),
          },
        ],
      }),
    ),
    http.get(
      `${A}/data-subscribe`,
      withArt(
        () =>
          new HttpResponse("WebSocket upgrade is not available in mocks", {
            status: 426,
          }),
      ),
    ),
    http.post(
      `${A}/data/:col/query`,
      withArt(async (a, { request, params }) => {
        const bad = names(params.col);
        if (bad) return bad;
        const r = await body(request, DataQuerySchema);
        if (r.error) return r.error;
        const { where, orderBy, order, limit, cursor } = r.data;
        let list = [...docs(a.id, params.col as string).values()].filter((d) =>
          Object.entries(where ?? {}).every(
            ([k, v]) => (d.data as Record<string, unknown> | null)?.[k] === v,
          ),
        );
        if (orderBy) {
          const get = (d: DataDoc) =>
            (d.data as Record<string, string | number> | null)?.[orderBy] ?? "";
          list = list.sort((x, y) =>
            get(x) > get(y) ? 1 : get(x) < get(y) ? -1 : 0,
          );
          if (order === "desc") list.reverse();
        }
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor) q.set("cursor", cursor);
        return paginate(list, q, 100);
      }),
    ),
    http.get(
      `${A}/data/:col`,
      withArt((a, { request, params }) => {
        const bad = names(params.col);
        if (bad) return bad;
        return paginate(
          [...docs(a.id, params.col as string).values()],
          new URL(request.url).searchParams,
          100,
        );
      }),
    ),
    http.get(
      `${A}/data-count/:col`,
      withArt((a, { params }) => {
        const bad = names(params.col);
        if (bad) return bad;
        return HttpResponse.json({
          count: docs(a.id, params.col as string).size,
        });
      }),
    ),
    http.get(
      `${A}/data/:col/:doc`,
      withArt((a, { params }) => {
        const bad = names(params.col, params.doc);
        if (bad) return bad;
        const d = docs(a.id, params.col as string).get(params.doc as string);
        return d ? HttpResponse.json(d) : notFound();
      }),
    ),
    http.put(
      `${A}/data/:col/:doc`,
      withArt(async (a, { request, params }) => {
        const bad = names(params.col, params.doc);
        if (bad) return bad;
        const r = await body(request, DataSetBodySchema);
        if (r.error) return r.error;
        const d: DataDoc = {
          id: params.doc as string,
          data: r.data,
          updatedAt: iso(),
          updatedBy: writer(request),
        };
        docs(a.id, params.col as string).set(d.id, d);
        return HttpResponse.json(d);
      }),
    ),
    http.patch(
      `${A}/data/:col/:doc`,
      withArt(async (a, { request, params }) => {
        const bad = names(params.col, params.doc);
        if (bad) return bad;
        const r = await body(request, DataPatchBodySchema);
        if (r.error) return r.error;
        const col = docs(a.id, params.col as string);
        const d: DataDoc = col.get(params.doc as string) ?? {
          id: params.doc as string,
          data: {},
          updatedAt: iso(),
          updatedBy: writer(request),
        };
        d.data = { ...(d.data as object), ...r.data };
        d.updatedAt = iso();
        d.updatedBy = writer(request);
        col.set(d.id, d);
        return HttpResponse.json(d);
      }),
    ),
    http.delete(
      `${A}/data/:col/:doc`,
      withArt((a, { params }) => {
        const bad = names(params.col, params.doc);
        if (bad) return bad;
        docs(a.id, params.col as string).delete(params.doc as string);
        return noContent();
      }),
    ),
    http.get(
      `${A}/storage`,
      withArt((a, { request }) =>
        paginate(
          [...store(a.id).values()].map((e) => ({
            key: e.key,
            updatedAt: e.updatedAt,
          })),
          new URL(request.url).searchParams,
          100,
        ),
      ),
    ),
    http.get(
      `${A}/storage/:key`,
      withArt((a, { params }) => {
        const bad = names(params.key);
        if (bad) return bad;
        const e = store(a.id).get(params.key as string);
        return e ? HttpResponse.json(e) : notFound();
      }),
    ),
    http.put(
      `${A}/storage/:key`,
      withArt(async (a, { request, params }) => {
        const bad = names(params.key);
        if (bad) return bad;
        const r = await body(request, StorageSetBodySchema);
        if (r.error) return r.error;
        const entry: StorageEntry = {
          key: params.key as string,
          value: r.data.value,
          updatedAt: iso(),
        };
        store(a.id).set(entry.key, entry);
        return HttpResponse.json(entry);
      }),
    ),
    http.delete(
      `${A}/storage/:key`,
      withArt((a, { params }) => {
        const bad = names(params.key);
        if (bad) return bad;
        store(a.id).delete(params.key as string);
        return noContent();
      }),
    ),
    http.post("*/auth/logout", () => noContent()),
  ];
}
