// P3 T16: every artifact surface, as a probe that answers allow or deny for
// one caller on one artifact. Exported for P5 (tenant A credentials against
// tenant B ids) and run by scripts/authz-probe.ts against a live instance.
//
// Read-only by construction unless `mutates` is set:
// - Writes the gate guards are probed with the session cookie and WITHOUT
//   X-OA-Request: the policy gate runs first (app.ts), so an allowed caller
//   gets 403 csrf before any handler runs, and a refused one 401 or 404.
// - Writes whose exact rule lives in the handler send a body that fails
//   validation after that rule (an invalid data name, a non-WebP thumbnail,
//   spaceId on an existing artifact, a share with oneself).
// - The rest (`mutates`) write when allowed; the matrix runs them on data
//   it owns and the probe script skips them.
// Pure fetch (no workerd imports), so Node can load it.
import type { SurfaceAction, Via } from "./expect.ts";

/** One caller's credentials. Anonymous: none. */
export type Cred = {
  /** `Cookie` header value (the session cookie). */
  cookie?: string;
  /** Agent token for Authorization: Bearer (a PAT or an MCP OAuth grant). */
  token?: string;
  /** The caller's address (share_artifact: a share with oneself). */
  email?: string;
};
export type Verdict = "allow" | "deny";
export type ProbeIO = {
  fetch?: (req: Request) => Promise<Response>;
  /** The content host origin (the /p/ probe). */
  contentBase?: string;
};
export type Surface = {
  name: string;
  action: SurfaceAction;
  via: Via;
  /** ROUTE_POLICY keys, `tool:<name>` for MCP tools, `content:<key>` for CONTENT_POLICY. */
  routes: readonly string[];
  /**
   * Writes when allowed. "data": harmless to access (data docs, a version, an
   * upload row); "access": changes access, so the matrix gives every cell a
   * throwaway artifact. scripts/authz-probe.ts never runs either.
   */
  mutates?: "data" | "access";
  probe(
    base: string,
    cred: Cred,
    artifactId: string,
    io?: ProbeIO,
  ): Promise<Verdict>;
};

/** A response the probe can't classify: a failure, never a verdict. */
export class Unexpected extends Error {}

const ARTS = "/api/v1/artifacts/:id";
const A = (id: string) => `/api/v1/artifacts/${id}`;
/** A data or storage name the schema refuses ('.' is not allowed). */
const BAD = "bad.name";
/** Garbage session cookies (both names): resolves to no one, still trips CSRF. */
const ANON_COOKIE = "oa_session=probe; __Host-oa_session=probe";
/** The address the unshare probes remove (the matrix seeds it). */
export const PROBE_SHARE_EMAIL = "authz-probe@example.invalid";

const doFetch = (io: ProbeIO | undefined, req: Request) =>
  (io?.fetch ?? fetch)(req);

type Init = {
  method?: string;
  body?: unknown;
  /** Raw body with this Content-Type instead of JSON. */
  raw?: { type: string; data: string };
  /** Leave X-OA-Request off (the CSRF probe). */
  noCsrf?: boolean;
};

/** One app request as `cred`: the cookie when there is one, else the token. */
async function send(
  io: ProbeIO | undefined,
  base: string,
  path: string,
  cred: Cred,
  init: Init = {},
): Promise<{ status: number; code: string; message: string; body: string }> {
  const headers: Record<string, string> = {};
  if (!init.noCsrf) headers["x-oa-request"] = "1";
  if (init.noCsrf) headers.cookie = cred.cookie ?? ANON_COOKIE;
  else if (cred.cookie) headers.cookie = cred.cookie;
  else if (cred.token) headers.authorization = `Bearer ${cred.token}`;
  let body: string | undefined;
  if (init.raw) {
    headers["content-type"] = init.raw.type;
    body = init.raw.data;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const r = await doFetch(
    io,
    new Request(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    }),
  );
  const text = await r.text();
  let code = "";
  let message = "";
  try {
    const e = (
      JSON.parse(text) as { error?: { code: string; message: string } }
    ).error;
    code = e?.code ?? "";
    message = e?.message ?? "";
  } catch {}
  return { status: r.status, code, message, body: text };
}

const DENY = new Set([401, 404]);
function classify(
  what: string,
  r: { status: number; code: string; body: string },
  allow: (r: { status: number; code: string }) => boolean,
): Verdict {
  if (allow(r)) return "allow";
  if (DENY.has(r.status)) return "deny";
  throw new Unexpected(`${what}: ${r.status} ${r.body.slice(0, 200)}`);
}
const status =
  (...s: number[]) =>
  (r: { status: number }) =>
    s.includes(r.status);

/** A read: allowed when it answers one of `ok`. */
const read =
  (path: (id: string) => string, ...ok: number[]) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) =>
    classify(path(id), await send(io, base, path(id), cred), status(...ok));

/**
 * A gate-guarded write, probed read-only: the cookie without X-OA-Request.
 * Allowed → 403 csrf (no handler ran); refused → 401 or 404.
 */
const csrf =
  (method: string, path: (id: string) => string) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) => {
    if (!cred.cookie && cred.token)
      throw new Unexpected("the CSRF probe needs a session cookie");
    const r = await send(io, base, path(id), cred, { method, noCsrf: true });
    return classify(
      `${method} ${path(id)}`,
      r,
      (x) => x.status === 403 && x.code === "csrf",
    );
  };

/** A write whose request fails validation once access is proven. */
const exact =
  (
    method: string,
    path: (id: string) => string,
    init: (id: string, cred: Cred) => Init,
    allow: (r: { status: number; code: string; message: string }) => boolean,
    deny: (r: {
      status: number;
      code: string;
      message: string;
    }) => boolean = () => false,
  ) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) => {
    const r = await send(io, base, path(id), cred, {
      method,
      ...init(id, cred),
    });
    if (deny(r)) return "deny" as const;
    return classify(`${method} ${path(id)}`, r, allow);
  };

const badRequest = (r: { status: number; code: string }) =>
  r.status === 400 && r.code === "bad_request";

/** Pages a listing until `id` shows up. */
async function listed(
  page: (
    cursor: string | undefined,
  ) => Promise<{ items: { id: string }[]; nextCursor: string | null } | "deny">,
  id: string,
): Promise<Verdict> {
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const p = await page(cursor);
    if (p === "deny") return "deny";
    if (p.items.some((x) => x.id === id)) return "allow";
    if (!p.nextCursor) return "deny";
    cursor = p.nextCursor;
  }
  throw new Unexpected("listing did not end");
}

const restList =
  (path: (id: string, cursor?: string) => string) =>
  (base: string, cred: Cred, id: string, io?: ProbeIO) =>
    listed(async (cursor) => {
      const r = await send(io, base, path(id, cursor), cred);
      if (r.status === 200)
        return JSON.parse(r.body) as {
          items: { id: string }[];
          nextCursor: string | null;
        };
      if (DENY.has(r.status)) return "deny";
      throw new Unexpected(`${path(id)}: ${r.status} ${r.body.slice(0, 200)}`);
    }, id);

// ------------------------------------------------------------------- MCP

export type ToolOut = {
  /** HTTP status of /mcp (401: the token is refused). */
  http: number;
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
};

/** One tools/call on /mcp (stateless JSON-RPC), as the caller's agent token. */
export async function callTool(
  io: ProbeIO | undefined,
  base: string,
  cred: Cred,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOut> {
  if (!cred.token) return { http: 401, isError: true, text: "no token" };
  const r = await doFetch(
    io,
    new Request(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cred.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await r.text();
  if (r.status !== 200) return { http: r.status, isError: true, text };
  const json = text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5) ?? "");
  let msg: {
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: { message: string };
  };
  try {
    msg = JSON.parse(json);
  } catch {
    throw new Unexpected(
      `${name}: unparsable /mcp reply ${text.slice(0, 200)}`,
    );
  }
  if (msg.error) throw new Unexpected(`${name}: ${msg.error.message}`);
  return {
    http: 200,
    isError: msg.result?.isError === true,
    text: (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
    structured: msg.result?.structuredContent,
  };
}

/** Allowed when `allow(out)`; refused for a refused token or not_found. */
const tool =
  (
    name: string,
    args: (id: string, cred: Cred) => Record<string, unknown>,
    allow: (o: ToolOut) => boolean = (o) => !o.isError,
  ) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) => {
    if (!cred.token) return "deny" as const;
    const o = await callTool(io, base, cred, name, args(id, cred));
    if (o.http === 401 || o.http === 403) return "deny" as const;
    if (o.http === 200 && allow(o)) return "allow" as const;
    // 404, or the contract's 403 for a create by a capped caller.
    if (
      o.http === 200 &&
      o.isError &&
      /^(not_found|space_forbidden)\b/.test(o.text)
    )
      return "deny" as const;
    throw new Unexpected(`${name}: ${o.http} ${o.text.slice(0, 200)}`);
  };

const toolList =
  (name: string, args: (id: string) => Record<string, unknown>) =>
  (base: string, cred: Cred, id: string, io?: ProbeIO) =>
    listed(async (cursor) => {
      const o = await callTool(io, base, cred, name, {
        ...args(id),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (o.http === 401 || o.http === 403) return "deny";
      if (o.isError) throw new Unexpected(`${name}: ${o.text.slice(0, 200)}`);
      return o.structured as {
        items: { id: string }[];
        nextCursor: string | null;
      };
    }, id);

const data = (name: string, extra: Record<string, unknown> = {}) =>
  tool(`artifact_data_${name}`, (id) => ({ id, collection: "c", ...extra }));

// --------------------------------------------------------------- content

/** Mints the frame URL as the caller (content-url) and loads it. */
async function frame(
  base: string,
  cred: Cred,
  id: string,
  io?: ProbeIO,
): Promise<Verdict> {
  const m = await send(io, base, `${A(id)}/content-url`, cred);
  if (DENY.has(m.status)) return "deny";
  if (m.status !== 200)
    throw new Unexpected(`content-url: ${m.status} ${m.body.slice(0, 200)}`);
  const { url } = JSON.parse(m.body) as { url: string };
  const r = await doFetch(io, new Request(url));
  await r.body?.cancel();
  return classify(url, { status: r.status, code: "", body: "" }, status(200));
}

/** get_artifact's download URL (/c/...?dl=1, signed for the caller), loaded. */
async function download(
  base: string,
  cred: Cred,
  id: string,
  io?: ProbeIO,
): Promise<Verdict> {
  const o = await callTool(io, base, cred, "get_artifact", {
    id,
    includeContent: false,
  });
  if (o.http === 401 || o.http === 403) return "deny";
  if (o.isError) {
    if (/^not_found\b/.test(o.text)) return "deny";
    throw new Unexpected(`get_artifact: ${o.text.slice(0, 200)}`);
  }
  const url = (o.structured as { downloadUrl?: string } | undefined)
    ?.downloadUrl;
  if (!url || !/[?&]dl=1(&|$)/.test(url))
    throw new Unexpected(`get_artifact: no dl URL (${url})`);
  const r = await doFetch(io, new Request(url));
  await r.body?.cancel();
  return classify(url, { status: r.status, code: "", body: "" }, status(200));
}

/** /p/{id}/v1/: no credentials at all, whoever asks. */
async function publicLink(
  _base: string,
  _cred: Cred,
  id: string,
  io?: ProbeIO,
): Promise<Verdict> {
  if (!io?.contentBase) throw new Unexpected("/p/ needs contentBase");
  const r = await doFetch(
    io,
    new Request(`${io.contentBase}/p/${id}/v1/index.html`),
  );
  await r.body?.cancel();
  return classify("/p/", { status: r.status, code: "", body: "" }, status(200));
}

// --------------------------------------------------------------- surfaces

const rest = (
  name: string,
  action: SurfaceAction,
  routes: string[],
  probe: Surface["probe"],
  mutates?: Surface["mutates"],
): Surface => ({
  name,
  action,
  via: "rest",
  routes,
  probe,
  ...(mutates ? { mutates } : {}),
});
const mcp = (
  name: string,
  action: SurfaceAction,
  probe: Surface["probe"],
  mutates?: Surface["mutates"],
): Surface => ({
  name: `mcp ${name}`,
  action,
  via: "mcp",
  routes: [`tool:${name}`],
  probe,
  ...(mutates ? { mutates } : {}),
});

const PUBLISH_BODY = (spaceId: string) => ({
  format: "html",
  content: "<p>probe</p>",
  // On an existing artifact: 400 use_move, after the publish check.
  spaceId,
});
/** A well-formed id for the use_move probes (never looked up). */
const SOME_ID = "AAAAAAAAAAAAAAAA";

export const SURFACES: readonly Surface[] = [
  // REST
  rest("rest get", "view", [`GET ${ARTS}`], read(A, 200)),
  rest(
    "rest patch",
    "publish",
    [`PATCH ${ARTS}`],
    // An empty patch: the publish check, then nothing to write.
    exact("PATCH", A, () => ({ body: {} }), status(200)),
  ),
  rest(
    "rest publish version",
    "publish",
    [`POST ${ARTS}/versions`],
    exact(
      "POST",
      (id) => `${A(id)}/versions`,
      () => ({ body: PUBLISH_BODY(SOME_ID) }),
      (r) => r.status === 400 && r.code === "use_move",
    ),
  ),
  rest(
    "rest restore_version",
    "restore",
    [`POST ${ARTS}/versions/:v/restore`],
    csrf("POST", (id) => `${A(id)}/versions/1/restore`),
  ),
  rest(
    "rest list_versions",
    "versions",
    [`GET ${ARTS}/versions`],
    read((id) => `${A(id)}/versions`, 200),
  ),
  rest(
    "rest version file",
    "version.file",
    [`GET ${ARTS}/versions/:v/files/*`],
    read((id) => `${A(id)}/versions/1/files/index.html`, 200),
  ),
  rest(
    "rest version text PUT",
    "version.text",
    [`PUT ${ARTS}/versions/:v/text`],
    csrf("PUT", (id) => `${A(id)}/versions/1/text`),
  ),
  rest(
    "rest thumbnail GET",
    "thumbnail.read",
    [`GET ${ARTS}/thumbnail`],
    read((id) => `${A(id)}/thumbnail`, 200),
  ),
  rest(
    "rest thumbnail PUT",
    "thumbnail.write",
    [`PUT ${ARTS}/thumbnail`],
    // The exact rule (first thumbnail for viewers) runs before the WebP check.
    exact(
      "PUT",
      (id) => `${A(id)}/thumbnail`,
      () => ({ raw: { type: "image/webp", data: "not webp" } }),
      badRequest,
    ),
  ),
  rest(
    "rest uploads",
    "upload",
    ["POST /api/v1/uploads"],
    exact(
      "POST",
      () => "/api/v1/uploads",
      (id) => ({
        body: {
          artifactId: id,
          path: "probe.txt",
          size: 1,
          contentType: "text/plain",
        },
      }),
      status(201),
    ),
    "data",
  ),
  rest(
    "rest share (list)",
    "share",
    [`GET ${ARTS}/shares`],
    read((id) => `${A(id)}/shares`, 200),
  ),
  rest(
    "rest share (put)",
    "share",
    [`PUT ${ARTS}/shares`],
    csrf("PUT", (id) => `${A(id)}/shares`),
  ),
  rest(
    "rest unshare",
    "unshare",
    [`DELETE ${ARTS}/shares/:email`],
    csrf(
      "DELETE",
      (id) => `${A(id)}/shares/${encodeURIComponent(PROBE_SHARE_EMAIL)}`,
    ),
  ),
  rest(
    "rest visibility",
    "visibility",
    [`PATCH ${ARTS}`],
    exact(
      "PATCH",
      A,
      () => ({ body: { visibility: "private" } }),
      status(200),
      (r) =>
        r.status === 400 && /only the owner can change sharing/.test(r.message),
    ),
    "access",
  ),
  rest("rest delete", "delete", [`DELETE ${ARTS}`], csrf("DELETE", A)),
  rest(
    "rest undelete",
    "undelete",
    [`POST ${ARTS}/undelete`],
    csrf("POST", (id) => `${A(id)}/undelete`),
  ),
  rest(
    "rest move",
    "move",
    [`POST ${ARTS}/move`],
    csrf("POST", (id) => `${A(id)}/move`),
  ),
  rest(
    "rest transfer",
    "transfer",
    [`POST ${ARTS}/transfer`],
    csrf("POST", (id) => `${A(id)}/transfer`),
  ),
  // List and search
  rest(
    "rest list",
    "list",
    ["GET /api/v1/artifacts"],
    restList(
      (_id, cursor) =>
        `/api/v1/artifacts?scope=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  ),
  rest(
    "rest search",
    "list",
    ["GET /api/v1/search"],
    // Fixture titles carry the artifact id.
    restList(
      (id, cursor) =>
        `/api/v1/search?q=${id}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  ),
  // Data and storage
  rest(
    "data GET list",
    "data.read",
    [`GET ${ARTS}/data/:col`],
    read((id) => `${A(id)}/data/c`, 200),
  ),
  rest(
    "data GET doc",
    "data.read",
    [`GET ${ARTS}/data/:col/:doc`],
    read((id) => `${A(id)}/data/c/d`, 200),
  ),
  rest(
    "data count",
    "data.read",
    [`GET ${ARTS}/data-count/:col`],
    read((id) => `${A(id)}/data-count/c`, 200),
  ),
  rest(
    "data query",
    "data.read",
    [`POST ${ARTS}/data/:col/query`],
    exact(
      "POST",
      (id) => `${A(id)}/data/c/query`,
      () => ({ body: {} }),
      status(200),
    ),
  ),
  ...(["PUT", "PATCH", "DELETE"] as const).map((m) =>
    rest(
      `data ${m}`,
      "data.write",
      [`${m} ${ARTS}/data/:col/:doc`],
      exact(
        m,
        (id) => `${A(id)}/data/c/${BAD}`,
        () => (m === "DELETE" ? {} : { body: {} }),
        badRequest,
      ),
    ),
  ),
  rest(
    "data reset",
    "data.reset",
    [`PUT ${ARTS}/data`],
    csrf("PUT", (id) => `${A(id)}/data`),
  ),
  rest(
    "storage list",
    "storage",
    [`GET ${ARTS}/storage`],
    read((id) => `${A(id)}/storage`, 200),
  ),
  ...(["GET", "PUT", "DELETE"] as const).map((m) =>
    rest(
      `storage ${m}`,
      "storage",
      [`${m} ${ARTS}/storage/:key`],
      exact(
        m,
        (id) => `${A(id)}/storage/${BAD}`,
        () => (m === "PUT" ? { body: {} } : {}),
        badRequest,
      ),
    ),
  ),
  rest(
    "anon id",
    "anonId",
    [`GET ${ARTS}/anon-id`],
    read((id) => `${A(id)}/anon-id`, 200),
  ),
  // Content
  rest(
    "content mint",
    "content.mint",
    [`GET ${ARTS}/content-url`],
    read((id) => `${A(id)}/content-url`, 200),
  ),
  {
    name: "content /c/ frame",
    action: "content.mint",
    via: "rest",
    routes: ["content:GET /*"],
    probe: frame,
  },
  {
    name: "content /c/?dl=1",
    action: "view",
    via: "mcp",
    routes: ["content:GET /*", "tool:get_artifact"],
    probe: download,
  },
  {
    name: "content /p/",
    action: "public.link",
    via: "content",
    routes: ["content:GET /*"],
    probe: publicLink,
  },
  // Sockets: the upgrade check runs after every access check (426 = allowed).
  rest(
    "ws subscribe",
    "subscribe",
    [`GET ${ARTS}/data-subscribe`],
    read((id) => `${A(id)}/data-subscribe?collection=c`, 426),
  ),
  rest(
    "ws events",
    "events",
    [`GET ${ARTS}/events`],
    read((id) => `${A(id)}/events`, 426),
  ),
  // MCP (all 18 tools)
  mcp(
    "get_artifact",
    "view",
    tool("get_artifact", (id) => ({ id })),
  ),
  mcp(
    "list_artifacts",
    "list",
    toolList("list_artifacts", () => ({ scope: "all" })),
  ),
  mcp(
    "search_artifacts",
    "list",
    toolList("search_artifacts", (id) => ({ q: id })),
  ),
  mcp(
    "list_versions",
    "versions",
    tool("list_versions", (id) => ({ id })),
  ),
  mcp(
    "restore_version",
    "restore",
    tool("restore_version", (id) => ({ id, version: 1 })),
    "data",
  ),
  mcp(
    "share_artifact",
    "share",
    tool(
      "share_artifact",
      (id, cred) => {
        if (!cred.email)
          throw new Unexpected("share_artifact needs cred.email");
        return { id, email: cred.email, role: "viewer" };
      },
      // Sharing with oneself fails after the owner check: nothing written.
      (o) => o.isError && /Cannot share with yourself/.test(o.text),
    ),
  ),
  mcp(
    "unshare_artifact",
    "unshare",
    tool("unshare_artifact", (id) => ({ id, email: PROBE_SHARE_EMAIL })),
    "access",
  ),
  mcp(
    "set_visibility",
    "visibility",
    tool("set_visibility", (id) => ({ id, visibility: "private" })),
    "access",
  ),
  mcp(
    "delete_artifact",
    "delete",
    tool("delete_artifact", (id) => ({ id })),
    "access",
  ),
  mcp("artifact_data_get", "data.read", data("get", { docId: "d" })),
  mcp("artifact_data_list", "data.read", data("list")),
  mcp("artifact_data_query", "data.read", data("query", { query: {} })),
  mcp(
    "artifact_data_set",
    "data.write",
    data("set", { docId: "probe", data: { p: 1 } }),
    "data",
  ),
  mcp(
    "artifact_data_update",
    "data.write",
    data("update", { docId: "probe", patch: { p: 2 } }),
    "data",
  ),
  mcp(
    "artifact_data_delete",
    "data.write",
    data("delete", { docId: "probe-none" }),
    "data",
  ),
  mcp(
    "publish_artifact",
    "publish",
    tool(
      "publish_artifact",
      (id) => ({ id, ...PUBLISH_BODY(SOME_ID) }),
      (o) => o.isError && /^use_move\b/.test(o.text),
    ),
  ),
  mcp(
    "create_upload",
    "upload",
    tool("create_upload", (id) => ({
      artifactId: id,
      path: "probe.txt",
      size: 1,
      contentType: "text/plain",
    })),
    "data",
  ),
  // Not artifact-scoped (the caller's publishable spaces).
  mcp(
    "list_spaces",
    "reach",
    tool("list_spaces", () => ({})),
  ),
];

/**
 * Artifact-scoped ROUTE_POLICY and TOOL_POLICY entries that no surface
 * lists (P5 asserts this is empty, as the matrix does).
 */
export function uncovered(
  surfaces: readonly Surface[],
  routePolicy: Readonly<Record<string, object>>,
  toolPolicy: Readonly<Record<string, object>>,
): string[] {
  const have = new Set(surfaces.flatMap((s) => s.routes));
  return [
    ...Object.entries(routePolicy)
      .filter(([k, p]) => "artifact" in p && !have.has(k))
      .map(([k]) => k),
    ...Object.keys(toolPolicy)
      .map((t) => `tool:${t}`)
      .filter((k) => !have.has(k)),
  ];
}
