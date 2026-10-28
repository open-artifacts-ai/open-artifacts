// P3 T16: every artifact surface, as a probe that answers allow or deny for
// one caller on one artifact. Exported for P5 (tenant A credentials against
// tenant B ids) and run by scripts/authz-probe.ts against a live instance.
//
// Read-only by construction unless `mutates` is set:
// - Every cookie write sends X-OA-Request: 1, as the same-site app does, so
//   it runs past the CSRF check into readOnlyCap and the route's own rules
//   (#839). CSRF_WRITES below checks, per write route, that the same cookie
//   write without the header is still 403 csrf.
// - Writes send a request that fails after the route's last access rule
//   (an invalid data name or body, a non-WebP thumbnail, spaceId on an
//   existing artifact, a share with oneself, a move to the space it is in,
//   a transfer to no one), so nothing is written.
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
  /**
   * The matrix's real mode (Surface.real): the targets real writes need.
   * Absent: every probe asks in its refusal mode.
   */
  real?: ArtifactReal;
};

/** What the artifact surfaces' real writes need besides the artifact. */
export type ArtifactReal = {
  /** An active member who may take a transferred artifact. */
  successorId: string;
  /** A shared space every allowed mover may publish to (the move target). */
  moveSpaceId: string;
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
  /**
   * The matrix's real mode (#839): a real write, allowed only on the
   * route's documented success; run on a per-cell copy of the artifact
   * (`realCopy` "noThumbnail": a copy with no thumbnail yet). `probe` stays
   * the refusal mode (a request answered after the access rules that
   * writes nothing) for the probe script and the cross-install suite.
   */
  real?: Surface["probe"];
  realCopy?: "noThumbnail";
};

/** `s` with a real-mode probe (Surface.real). */
const withReal = (
  s: Surface,
  real: Surface["probe"],
  realCopy?: Surface["realCopy"],
): Surface => ({
  ...s,
  real: COOKIE_PROBES.has(s.probe) ? byCookie(real) : real,
  ...(realCopy ? { realCopy } : {}),
});

/** The real-mode targets, or a failure: a real probe without them. */
const realOf = (io: ProbeIO | undefined): ArtifactReal => {
  if (!io?.real) throw new Unexpected("a real probe needs io.real");
  return io.real;
};

/** A response the probe can't classify: a failure, never a verdict. */
export class Unexpected extends Error {}

const ARTS = "/api/v1/artifacts/:id";
const A = (id: string) => `/api/v1/artifacts/${id}`;
/** A data or storage name the schema refuses ('.' is not allowed). */
const BAD = "bad.name";
/** The address the unshare probes remove (the matrix seeds it). */
export const PROBE_SHARE_EMAIL = "authz-probe@example.invalid";

const doFetch = (io: ProbeIO | undefined, req: Request) =>
  (io?.fetch ?? fetch)(req);

type Init = {
  method?: string;
  body?: unknown;
  /** Raw body with this Content-Type instead of JSON. */
  raw?: { type: string; data: string };
};

/** One app request as `cred`: the cookie when there is one, else the token. */
async function send(
  io: ProbeIO | undefined,
  base: string,
  path: string,
  cred: Cred,
  init: Init = {},
): Promise<{ status: number; code: string; message: string; body: string }> {
  // X-OA-Request on every request, as the app sends it: a cookie write
  // without it stops at the CSRF check (CSRF_WRITES probes that on its own).
  const headers: Record<string, string> = { "x-oa-request": "1" };
  if (cred.cookie) headers.cookie = cred.cookie;
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
type Answer = { status: number; code: string; message?: string; body: string };
function classify(
  what: string,
  r: Answer,
  allow: (r: Answer) => boolean,
): Verdict {
  // Rate limited: says nothing about access. Fail loudly, never a verdict.
  if (r.status === 429)
    throw new Unexpected(
      `${what}: inconclusive (429 ${r.code || "rate_limited"})`,
    );
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
 * Probes sent by session cookie only (a token alone can't run them): the
 * cross-install suite runs them as its session variant only.
 */
const COOKIE_PROBES = new WeakSet<object>();
const byCookie = (probe: Surface["probe"]): Surface["probe"] => {
  const p: Surface["probe"] = (base, cred, id, io) => {
    if (!cred.cookie && cred.token)
      throw new Unexpected("this write probe needs a session cookie");
    return probe(base, cred, id, io);
  };
  COOKIE_PROBES.add(p);
  return p;
};
/** True for a cookie probe: it needs a session cookie (a token alone can't run it). */
export const needsCookie = (s: Pick<Surface, "probe">): boolean =>
  COOKIE_PROBES.has(s.probe);

/** A write whose request fails validation once access is proven. */
const exact =
  (
    method: string,
    path: (id: string) => string,
    init: (id: string, cred: Cred) => Init,
    allow: (r: Answer) => boolean,
    deny: (r: Answer) => boolean = () => false,
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
/** #681: a data write refused by dataWriters "editors". */
const editorsOnly = (r: { status: number; code: string }) =>
  r.status === 403 && r.code === "data_editors_only";

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

/** /mcp refusing the token (or a host that doesn't serve it). */
const DENY_MCP = new Set([401, 403, 404]);

/** Allowed when `allow(out)`; refused for a refused token or not_found. */
const tool =
  (
    name: string,
    args: (id: string, cred: Cred) => Record<string, unknown>,
    allow: (o: ToolOut) => boolean = (o) => !o.isError,
    /** A tool error that is a refusal too (e.g. the sharing check). */
    deny: (o: ToolOut) => boolean = () => false,
  ) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) => {
    if (!cred.token) return "deny" as const;
    const o = await callTool(io, base, cred, name, args(id, cred));
    if (DENY_MCP.has(o.http)) return "deny" as const;
    if (o.http === 200 && allow(o)) return "allow" as const;
    if (o.http === 200 && o.isError && deny(o)) return "deny" as const;
    // 404, or the contract's 403 for a create by a capped caller.
    if (
      o.http === 200 &&
      o.isError &&
      /^(not_found|space_forbidden|data_editors_only)\b/.test(o.text)
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
      if (DENY_MCP.has(o.http)) return "deny";
      if (o.isError) throw new Unexpected(`${name}: ${o.text.slice(0, 200)}`);
      return o.structured as {
        items: { id: string }[];
        nextCursor: string | null;
      };
    }, id);

const data = (name: string, extra: Record<string, unknown> = {}) =>
  tool(`artifact_data_${name}`, (id) => ({ id, collection: "c", ...extra }));

// --------------------------------------------------------------- content

/** A WebSocket upgrade as the caller: allowed when it opens (101). */
const socket =
  (path: (id: string) => string) =>
  async (base: string, cred: Cred, id: string, io?: ProbeIO) => {
    const headers: Record<string, string> = { upgrade: "websocket" };
    if (cred.cookie) headers.cookie = cred.cookie;
    else if (cred.token) headers.authorization = `Bearer ${cred.token}`;
    const r = await doFetch(io, new Request(`${base}${path(id)}`, { headers }));
    // workerd's client end (Node's WebSocket type has no accept()).
    const ws = (
      r as Response & {
        webSocket?: { accept(): void; close(c: number, why: string): void };
      }
    ).webSocket;
    if (ws) {
      ws.accept();
      ws.close(1000, "probe");
    }
    const text = r.status === 101 ? "" : await r.text();
    let code = "";
    try {
      code =
        (JSON.parse(text) as { error?: { code: string } }).error?.code ?? "";
    } catch {}
    return classify(
      path(id),
      { status: r.status, code, body: text },
      status(101),
    );
  };

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
  if (DENY_MCP.has(o.http)) return "deny";
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
/** A minimal body that passes the server's WebP check (RIFF....WEBP). */
const WEBP = "RIFF\u0004\u0000\u0000\u0000WEBP";

/**
 * POST move to the space the artifact is already in: past the move rule it
 * changes nothing (200, or 400 space_personal for a personal space). The space comes from
 * the summary; one the caller can't read is a placeholder (refused anyway).
 */
async function moveInPlace(
  base: string,
  cred: Cred,
  id: string,
  io?: ProbeIO,
): Promise<Verdict> {
  const g = await send(io, base, A(id), cred);
  const spaceId =
    g.status === 200
      ? ((JSON.parse(g.body) as { space?: { id?: string } }).space?.id ??
        SOME_ID)
      : SOME_ID;
  const r = await send(io, base, `${A(id)}/move`, cred, {
    method: "POST",
    body: { spaceId },
  });
  // A personal artifact's own space is not a move target: 400
  // space_personal, also answered only past the move rule.
  return classify(
    `POST ${A(id)}/move`,
    r,
    (x) =>
      x.status === 200 || (x.status === 400 && x.code === "space_personal"),
  );
}

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
  withReal(
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
    exact(
      "POST",
      (id) => `${A(id)}/versions`,
      () => ({ body: { format: "html", content: "<p>probe</p>" } }),
      status(201),
    ),
  ),
  rest(
    "rest restore_version",
    "restore",
    [`POST ${ARTS}/versions/:v/restore`],
    // A new version: written when allowed.
    byCookie(
      exact(
        "POST",
        (id) => `${A(id)}/versions/1/restore`,
        () => ({}),
        status(201),
      ),
    ),
    "data",
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
    // Past the access rule, a non-pdf version's text is ignored (204).
    byCookie(
      exact(
        "PUT",
        (id) => `${A(id)}/versions/1/text`,
        () => ({ raw: { type: "text/plain", data: "probe" } }),
        status(204),
      ),
    ),
  ),
  rest(
    "rest thumbnail GET",
    "thumbnail.read",
    [`GET ${ARTS}/thumbnail`],
    read((id) => `${A(id)}/thumbnail`, 200),
  ),
  withReal(
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
    // On a copy with no thumbnail yet: a viewer's first one, or an editor's.
    exact(
      "PUT",
      (id) => `${A(id)}/thumbnail`,
      () => ({ raw: { type: "image/webp", data: WEBP } }),
      status(204),
    ),
    "noThumbnail",
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
  withReal(
    rest(
      "rest share (put)",
      "share",
      [`PUT ${ARTS}/shares`],
      // A share with oneself fails after the owner check: nothing written.
      // Without an address (anonymous) the body is invalid: never an allow.
      byCookie(
        exact(
          "PUT",
          (id) => `${A(id)}/shares`,
          (_id, cred) => ({
            body: { email: cred.email ?? "not an address", role: "viewer" },
          }),
          (r) =>
            r.status === 400 &&
            /Cannot share with yourself/.test(r.message ?? ""),
        ),
      ),
    ),
    // On the copy: the probe address, now an editor (200).
    exact(
      "PUT",
      (id) => `${A(id)}/shares`,
      () => ({ body: { email: PROBE_SHARE_EMAIL, role: "editor" } }),
      status(200),
    ),
  ),
  rest(
    "rest unshare",
    "unshare",
    [`DELETE ${ARTS}/shares/:email`],
    byCookie(
      exact(
        "DELETE",
        (id) => `${A(id)}/shares/${encodeURIComponent(PROBE_SHARE_EMAIL)}`,
        () => ({}),
        status(204),
      ),
    ),
    "access",
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
        r.status === 400 &&
        /only the owner can change sharing/.test(r.message ?? ""),
    ),
    "access",
  ),
  rest(
    "rest delete",
    "delete",
    [`DELETE ${ARTS}`],
    byCookie(exact("DELETE", A, () => ({}), status(204))),
    "access",
  ),
  rest(
    "rest undelete",
    "undelete",
    [`POST ${ARTS}/undelete`],
    byCookie(
      exact(
        "POST",
        (id) => `${A(id)}/undelete`,
        () => ({}),
        status(200),
      ),
    ),
    "access",
  ),
  withReal(
    rest("rest move", "move", [`POST ${ARTS}/move`], byCookie(moveInPlace)),
    // The copy moves into the real move target (200).
    (base, cred, id, io) =>
      exact(
        "POST",
        (x) => `${A(x)}/move`,
        () => ({ body: { spaceId: realOf(io).moveSpaceId } }),
        status(200),
      )(base, cred, id, io),
  ),
  withReal(
    rest(
      "rest transfer",
      "transfer",
      [`POST ${ARTS}/transfer`],
      // No such successor: refused after the owner check, nothing written.
      byCookie(
        exact(
          "POST",
          (id) => `${A(id)}/transfer`,
          () => ({ body: { userId: SOME_ID } }),
          (r) => r.status === 400 && r.code === "invalid_successor",
        ),
      ),
    ),
    // The copy goes to an active member (200).
    (base, cred, id, io) =>
      exact(
        "POST",
        (x) => `${A(x)}/transfer`,
        () => ({ body: { userId: realOf(io).successorId } }),
        status(200),
      )(base, cred, id, io),
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
  // P4 item 9: the trash lists exactly what the caller may restore.
  rest(
    "rest trash",
    "trash",
    ["GET /api/v1/trash"],
    restList(
      (_id, cursor) =>
        `/api/v1/trash?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
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
    withReal(
      rest(
        `data ${m}`,
        "data.write",
        [`${m} ${ARTS}/data/:col/:doc`],
        exact(
          m,
          (id) => `${A(id)}/data/c/${BAD}`,
          () => (m === "DELETE" ? {} : { body: {} }),
          badRequest,
          editorsOnly,
        ),
      ),
      // A real doc on the copy: set and update upsert (200); deleting one
      // that isn't there is a 204 too.
      exact(
        m,
        (id) => `${A(id)}/data/c/probe`,
        () => (m === "DELETE" ? {} : { body: { p: 1 } }),
        status(m === "DELETE" ? 204 : 200),
        editorsOnly,
      ),
    ),
  ),
  withReal(
    rest(
      "data reset",
      "data.reset",
      [`PUT ${ARTS}/data`],
      // A body the data store refuses after the owner check: nothing replaced.
      byCookie(
        exact(
          "PUT",
          (id) => `${A(id)}/data`,
          () => ({ raw: { type: "application/json", data: "not json" } }),
          badRequest,
        ),
      ),
    ),
    // The copy's data replaced by one doc (200).
    exact(
      "PUT",
      (id) => `${A(id)}/data`,
      () => ({
        raw: {
          type: "application/json",
          data: JSON.stringify({ collections: { c: { d: { v: 1 } } } }),
        },
      }),
      status(200),
    ),
  ),
  rest(
    "storage list",
    "storage",
    [`GET ${ARTS}/storage`],
    read((id) => `${A(id)}/storage`, 200),
  ),
  ...(["GET", "PUT", "DELETE"] as const).map((m) =>
    withReal(
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
      // The caller's own key on the copy: set (200), read back after a set
      // (200), deleted (204).
      async (base, cred, id, io) => {
        if (m === "GET") {
          const put = await send(io, base, `${A(id)}/storage/probe`, cred, {
            method: "PUT",
            body: { value: 1 },
          });
          if (DENY.has(put.status)) return "deny";
        }
        return exact(
          m,
          (x) => `${A(x)}/storage/probe`,
          () => (m === "PUT" ? { body: { value: 1 } } : {}),
          status(m === "DELETE" ? 204 : 200),
        )(base, cred, id, io);
      },
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
  // Sockets: the upgrade check runs after every access check (426 = allowed
  // in refusal mode); real mode opens the socket (101) and closes it.
  withReal(
    rest(
      "ws subscribe",
      "subscribe",
      [`GET ${ARTS}/data-subscribe`],
      read((id) => `${A(id)}/data-subscribe?collection=c`, 426),
    ),
    socket((id) => `${A(id)}/data-subscribe?collection=c`),
  ),
  withReal(
    rest(
      "ws events",
      "events",
      [`GET ${ARTS}/events`],
      read((id) => `${A(id)}/events`, 426),
    ),
    socket((id) => `${A(id)}/events`),
  ),
  // MCP (all 19 tools)
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
  withReal(
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
    // On the copy: the probe address, now an editor.
    tool("share_artifact", (id) => ({
      id,
      email: PROBE_SHARE_EMAIL,
      role: "editor",
    })),
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
  mcp(
    "undelete_artifact",
    "undelete",
    tool("undelete_artifact", (id) => ({ id })),
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
  withReal(
    mcp(
      "publish_artifact",
      "publish",
      tool(
        "publish_artifact",
        (id) => ({ id, ...PUBLISH_BODY(SOME_ID) }),
        (o) => o.isError && /^use_move\b/.test(o.text),
      ),
    ),
    // A new version of the copy.
    tool("publish_artifact", (id) => ({
      id,
      format: "html",
      content: "<p>probe</p>",
    })),
  ),
  // #681 D: id and only settings: the PATCH path, owner or manager.
  {
    ...mcp(
      "publish_artifact",
      "visibility",
      tool(
        "publish_artifact",
        (id) => ({ id, visibility: "private" }),
        undefined,
        (o) => /only the owner can change sharing/.test(o.text),
      ),
      "access",
    ),
    name: "mcp publish_artifact (settings only)",
  },
  // #681 D: id and only a description: editor+, as PATCH title/description.
  {
    ...mcp(
      "publish_artifact",
      "publish",
      tool("publish_artifact", (id) => ({ id, description: "probe" })),
      "data",
    ),
    name: "mcp publish_artifact (settings only, description)",
  },
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

// ------------------------------------------------- non-artifact routes

/** The ids the instance routes need (a shared space, a member, a departed one). */
export type OrgTarget = {
  spaceId: string;
  memberId: string;
  departedId: string;
  /**
   * A member of `spaceId` the space write probes may name without changing
   * anything (the matrix: one only an Every space mapping puts there).
   * Absent: `memberId`.
   */
  spaceMemberId?: string;
  /** A group mapped to `spaceId` (viewer). Absent: an unknown group. */
  groupId?: string;
  /**
   * The matrix's per-cell throwaways: present, every write probe writes for
   * real and only a success counts as allowed (see ORG_WRITES).
   */
  real?: Partial<OrgReal>;
};

/** Per-cell throwaways for the real write probes (ORG_WRITES `needs`). */
export type OrgReal = {
  /** An active member the probe may change, restrict or remove. */
  memberId: string;
  /** An active member with a Google link the probe may reset. */
  linkedId: string;
  /** An active member restricted by hand (the probe lifts it). */
  restrictedId: string;
  /** A directory group nothing maps or restricts. */
  groupId: string;
  /** A restricted group (the probe lifts it). */
  restrictedGroupId: string;
  /** A group mapped to every space (the probe removes the mapping). */
  orgMappingGroupId: string;
  /**
   * An empty copy of S: its members, a viewer and a manager mapping
   * (SpaceTarget.groups), so a delete answers 204.
   */
  spaceId: string;
  /** The copy's editor (S's) and the group its viewer mapping maps. */
  spaceEditorId: string;
  spaceGroupId: string;
  /** The caller's own live token and OAuth grant. */
  tokenId: string;
  grantId: string;
  /** An address nobody holds (an invite). */
  email: string;
  /** An active member who may take a departed member's artifacts. */
  successorId: string;
};

/**
 * How a route is guarded: an org action, or any signed-in caller (`space`:
 * the service then requires a member of the space, or its manager, or an
 * org admin).
 */
export type OrgRule =
  | { org: string }
  | { user: true; space?: "member" | "manager" | "admin" };

export type OrgSurface = {
  route: string;
  rule: OrgRule;
  /** Writes even as a read probe (the probe script skips it). */
  mutates?: "data";
  /**
   * A write with no refusal-after-access request (see ORG_WRITES): only the
   * matrix's real mode shows its allow. "no-directory": the refusal works
   * only on an install without a directory.
   */
  realOnly?: true | "no-directory";
  /**
   * Allowed, it changes the whole instance (the directory connection): the
   * matrix runs its allowed callers last, on their own.
   */
  instance?: true;
  /** The per-cell throwaways its real write needs. */
  needs?: readonly (keyof OrgReal)[];
  probe(base: string, cred: Cred, t: OrgTarget, io?: ProbeIO): Promise<Verdict>;
};

const fill = (path: string, t: OrgTarget) =>
  path
    .replace(/^\/api\/v1\/spaces\/:id/, `/api/v1/spaces/${t.spaceId}`)
    .replace(/\/members\/:id\/transfer$/, `/members/${t.departedId}/transfer`)
    .replace(":id", t.memberId)
    .replace(":userId", t.memberId)
    .replace(":groupId", "probe-group")
    .replace(":grantId", "probe-grant")
    // An unknown query key: 400 past the guard, before any Google call.
    .replace(/\/directory\/groups$/, "/directory/groups?probe=1");

/** One request: a path and an optional JSON body. */
type Req = { path: string; body?: unknown };
type Ctx = {
  t: OrgTarget;
  /** The caller's own user id (GET R.me), or a placeholder for no one. */
  self: () => Promise<string>;
};

/**
 * An instance write probe's two modes (X-OA-Request on in both, so every
 * request runs through the CSRF check, readOnlyCap and the route's rules):
 * - refuse (redline's cross-install suite, scripts/authz-probe.ts): a
 *   request answered only after the route's last access rule that writes
 *   nothing (an invalid body, the caller themself as a target the route
 *   refuses, a no-op). Absent: none exists on every install (realOnly).
 * - real (the matrix, OrgTarget.real): a real write on per-cell throwaways;
 *   allowed only on the route's documented success (2xx) or a named
 *   business conflict.
 */
type OrgWrite = {
  refuse?: {
    req: (c: Ctx) => Promise<Req>;
    allow: (r: Answer) => boolean;
    /** Only an install without a directory answers past the rules. */
    noDirectory?: true;
  };
  real: {
    needs?: readonly (keyof OrgReal)[];
    req: (r: OrgReal, c: Ctx) => Promise<Req> | Req;
    allow: (r: Answer) => boolean;
  };
  instance?: true;
};

const code =
  (...c: string[]) =>
  (r: Answer) =>
    c.includes(r.code);
const ok =
  (...s: number[]) =>
  (r: Answer) =>
    s.includes(r.status);
const either =
  (...f: ((r: Answer) => boolean)[]) =>
  (r: Answer) =>
    f.some((g) => g(r));

/** Refused by the body's validation, after every access rule. */
const invalid = (): NonNullable<OrgWrite["refuse"]> => ({
  req: async () => ({ path: "", body: { probe: 1 } }),
  allow: badRequest,
});

/** The caller's own user id (GET R.me), or a placeholder for no one. */
async function selfId(
  io: ProbeIO | undefined,
  base: string,
  cred: Cred,
): Promise<string> {
  const r = await send(io, base, "/api/v1/me", cred);
  if (r.status !== 200) return SOME_ID;
  return (JSON.parse(r.body) as { user: { id: string } }).user.id;
}

const MEMBERS = "/api/v1/members";
const SPACES = "/api/v1/spaces";
const DIR = "/api/v1/directory";
const syncOff = code("directory_sync_off");

/** Every instance write route's two requests (ORG's non-GET routes). */
export const ORG_WRITES: Readonly<Record<string, OrgWrite>> = {
  "PATCH /api/v1/me": {
    refuse: invalid(),
    real: {
      req: () => ({ path: "", body: { displayName: "Probe" } }),
      allow: ok(200),
    },
  },
  "POST /api/v1/members": {
    refuse: invalid(),
    real: {
      needs: ["email"],
      req: (r) => ({ path: "", body: { email: r.email, role: "member" } }),
      allow: ok(201),
    },
  },
  "PATCH /api/v1/members/:id": {
    refuse: invalid(),
    real: {
      needs: ["memberId"],
      req: (r) => ({
        path: `${MEMBERS}/${r.memberId}`,
        body: { role: "member" },
      }),
      allow: ok(200),
    },
  },
  // Refuse: the caller themself (the owner can't be removed, 400; an admin
  // is the owner's to manage, 403 owner_only).
  "DELETE /api/v1/members/:id": {
    refuse: {
      req: async (c) => ({ path: `${MEMBERS}/${await c.self()}` }),
      allow: code("owner_only", "bad_request"),
    },
    real: {
      needs: ["memberId"],
      req: (r) => ({ path: `${MEMBERS}/${r.memberId}` }),
      allow: ok(204),
    },
  },
  "POST /api/v1/members/:id/transfer": {
    refuse: invalid(),
    // The departed member owns nothing: a transfer of no artifacts.
    real: {
      needs: ["successorId"],
      req: (r, c) => ({
        path: `${MEMBERS}/${c.t.departedId}/transfer`,
        body: { to: { kind: "user", userId: r.successorId } },
      }),
      allow: ok(200),
    },
  },
  // Refuse would be the caller themself, but the owner's own link is never
  // resettable (404, like no access): real only.
  "DELETE /api/v1/members/:id/identities/google": {
    real: {
      needs: ["linkedId"],
      req: (r) => ({ path: `${MEMBERS}/${r.linkedId}/identities/google` }),
      allow: ok(204),
    },
  },
  // Refuse: the caller themself (an owner or admin can't be restricted).
  "PUT /api/v1/members/:id/restricted": {
    refuse: {
      req: async (c) => ({ path: `${MEMBERS}/${await c.self()}/restricted` }),
      allow: code("restrict_admin"),
    },
    real: {
      needs: ["memberId"],
      req: (r) => ({ path: `${MEMBERS}/${r.memberId}/restricted` }),
      allow: ok(200),
    },
  },
  // Refuse: the caller themself, never restricted: nothing changes (200).
  "DELETE /api/v1/members/:id/restricted": {
    refuse: {
      req: async (c) => ({ path: `${MEMBERS}/${await c.self()}/restricted` }),
      allow: ok(200),
    },
    real: {
      needs: ["restrictedId"],
      req: (r) => ({ path: `${MEMBERS}/${r.restrictedId}/restricted` }),
      allow: ok(200),
    },
  },
  "PATCH /api/v1/settings": {
    refuse: invalid(),
    // An empty patch: settings.manage, then nothing to change.
    real: { req: () => ({ path: "", body: {} }), allow: ok(200) },
  },
  "POST /api/v1/spaces": {
    refuse: invalid(),
    real: {
      req: () => ({
        path: "",
        body: { name: `probe ${newProbeId()}`, addMe: false },
      }),
      allow: ok(201),
    },
  },
  // Refuse: an empty patch on S (the manager rule, then nothing to write).
  "PATCH /api/v1/spaces/:id": {
    refuse: { req: async () => ({ path: "", body: {} }), allow: ok(200) },
    real: {
      needs: ["spaceId"],
      req: (r) => ({ path: `${SPACES}/${r.spaceId}`, body: { name: "probe" } }),
      allow: ok(200),
    },
  },
  // Real only: a refusal-mode DELETE would aim at a live space and rely on
  // it holding artifacts. Real: the empty copy goes (204); red-line deletes
  // its own throwaway space (ORG_FRESH there).
  "DELETE /api/v1/spaces/:id": {
    real: {
      needs: ["spaceId"],
      req: (r) => ({ path: `${SPACES}/${r.spaceId}` }),
      allow: ok(204),
    },
  },
  "POST /api/v1/spaces/:id/members/self": {
    refuse: invalid(),
    real: {
      needs: ["spaceId"],
      req: (r) => ({
        path: `${SPACES}/${r.spaceId}/members/self`,
        body: { role: "viewer" },
      }),
      allow: ok(201),
    },
  },
  // Refuse: spaceMemberId, in the space only by an Every space mapping
  // (editor), as viewer: 409 managed_by_org_mapping after the manager rule,
  // nothing written. Without one it refuses to send (never a write on a
  // live space); red-line runs it on its own throwaway space (ORG_FRESH).
  "PUT /api/v1/spaces/:id/members/:userId": {
    refuse: {
      req: async (c) => {
        if (!c.t.spaceMemberId)
          throw new Unexpected("this refusal needs spaceMemberId");
        return {
          path: `${SPACES}/${c.t.spaceId}/members/${c.t.spaceMemberId}`,
          body: { role: "viewer" },
        };
      },
      allow: code("managed_by_org_mapping"),
    },
    real: {
      needs: ["spaceId", "memberId"],
      req: (r) => ({
        path: `${SPACES}/${r.spaceId}/members/${r.memberId}`,
        body: { role: "viewer" },
      }),
      allow: ok(200),
    },
  },
  // Real only: past the manager rule, a member is removed or a non-member
  // is a plain 404 (an Every space member's 409 exists only with a directory).
  "DELETE /api/v1/spaces/:id/members/:userId": {
    real: {
      needs: ["spaceId", "spaceEditorId"],
      req: (r) => ({
        // The copy's members are S's: its editor.
        path: `${SPACES}/${r.spaceId}/members/${r.spaceEditorId}`,
      }),
      allow: ok(204),
    },
  },
  // Refuse: the mapping S already has, at its role (no change, 200); 409
  // directory_sync_off without a directory.
  "PUT /api/v1/spaces/:id/mappings/:groupId": {
    refuse: {
      req: async (c) => ({
        path: `${SPACES}/${c.t.spaceId}/mappings/${c.t.groupId ?? "probe-group"}`,
        body: { role: "viewer" },
      }),
      allow: either(ok(200), syncOff),
    },
    real: {
      needs: ["spaceId", "groupId"],
      req: (r) => ({
        path: `${SPACES}/${r.spaceId}/mappings/${r.groupId}`,
        body: { role: "viewer" },
      }),
      allow: ok(200),
    },
  },
  // No refusal after the manager rule: a group S doesn't map is a plain 404.
  "DELETE /api/v1/spaces/:id/mappings/:groupId": {
    real: {
      needs: ["spaceId", "spaceGroupId"],
      req: (r) => ({
        path: `${SPACES}/${r.spaceId}/mappings/${r.spaceGroupId}`,
      }),
      allow: ok(204),
    },
  },
  "PUT /api/v1/directory/org-mappings/:groupId": {
    refuse: invalid(),
    real: {
      needs: ["groupId"],
      req: (r) => ({
        path: `${DIR}/org-mappings/${r.groupId}`,
        body: { role: "viewer" },
      }),
      allow: ok(200),
    },
  },
  // Refuse: 409 directory_sync_off, only without a directory (the matrix's
  // world has one: its probe-script check skips it).
  "DELETE /api/v1/directory/org-mappings/:groupId": {
    refuse: {
      req: async () => ({ path: `${DIR}/org-mappings/probe-group` }),
      allow: syncOff,
      noDirectory: true,
    },
    real: {
      needs: ["orgMappingGroupId"],
      req: (r) => ({ path: `${DIR}/org-mappings/${r.orgMappingGroupId}` }),
      allow: ok(204),
    },
  },
  "PUT /api/v1/directory/restricted-groups/:groupId": {
    refuse: {
      req: async () => ({ path: `${DIR}/restricted-groups/probe-group` }),
      allow: syncOff,
      noDirectory: true,
    },
    real: {
      needs: ["groupId"],
      req: (r) => ({ path: `${DIR}/restricted-groups/${r.groupId}` }),
      allow: ok(200),
    },
  },
  // In any mode, no row is a plain 404: real only.
  "DELETE /api/v1/directory/restricted-groups/:groupId": {
    real: {
      needs: ["restrictedGroupId"],
      req: (r) => ({ path: `${DIR}/restricted-groups/${r.restrictedGroupId}` }),
      allow: ok(204),
    },
  },
  // The matrix seeds an expired consent: 409 conflict (it expired), the
  // documented answer past the owner check. A live one would need a Google
  // grant to swap in.
  "POST /api/v1/directory/confirm": {
    real: { req: () => ({ path: "" }), allow: code("conflict") },
    instance: true,
  },
  // The matrix seeds a live consent: cancelled (204).
  "POST /api/v1/directory/cancel": {
    real: { req: () => ({ path: "" }), allow: ok(204) },
    instance: true,
  },
  "POST /api/v1/directory/sync": {
    real: { req: () => ({ path: "" }), allow: ok(202) },
    instance: true,
  },
  // No held sweep (one needs a Google read): 409 conflict, the documented
  // answer past the owner check, in both modes.
  "POST /api/v1/directory/held/:groupId/confirm": {
    refuse: {
      req: async () => ({ path: `${DIR}/held/probe-group/confirm` }),
      allow: either(code("conflict"), syncOff),
    },
    real: {
      req: () => ({ path: `${DIR}/held/probe-group/confirm` }),
      allow: code("conflict"),
    },
  },
  "POST /api/v1/directory/disconnect": {
    real: { req: () => ({ path: "" }), allow: ok(200) },
    instance: true,
  },
  "DELETE /api/v1/directory": {
    real: { req: () => ({ path: "" }), allow: ok(204) },
    instance: true,
  },
  "POST /api/v1/admin/broker-check": {
    refuse: { req: async () => ({ path: "" }), allow: ok(200) },
    real: { req: () => ({ path: "" }), allow: ok(200) },
  },
  "POST /api/v1/artifacts": {
    refuse: invalid(),
    real: {
      req: () => ({
        path: "",
        body: { title: "probe", format: "html", content: "<p>probe</p>" },
      }),
      allow: ok(201),
    },
  },
  "POST /api/v1/tokens": {
    refuse: invalid(),
    real: {
      req: () => ({ path: "", body: { label: "probe" } }),
      allow: ok(201),
    },
  },
  "PATCH /api/v1/tokens/:id": {
    refuse: invalid(),
    real: {
      needs: ["tokenId"],
      req: (r) => ({
        path: `/api/v1/tokens/${r.tokenId}`,
        body: { label: "probe" },
      }),
      allow: ok(200),
    },
  },
  // Only the caller's own live token answers past the rules: real only.
  "DELETE /api/v1/tokens/:id": {
    real: {
      needs: ["tokenId"],
      req: (r) => ({ path: `/api/v1/tokens/${r.tokenId}` }),
      allow: ok(204),
    },
  },
  // The grant lookup precedes the body: real only.
  "PATCH /api/v1/oauth-clients/:grantId": {
    real: {
      needs: ["grantId"],
      req: (r) => ({
        path: `/api/v1/oauth-clients/${r.grantId}`,
        body: { label: "probe" },
      }),
      allow: ok(200),
    },
  },
  "DELETE /api/v1/oauth-clients/:grantId": {
    real: {
      needs: ["grantId"],
      req: (r) => ({ path: `/api/v1/oauth-clients/${r.grantId}` }),
      allow: ok(204),
    },
  },
};

/** A short random tag (space names). */
const newProbeId = () => Math.random().toString(36).slice(2, 10);

/**
 * Probes `route` (a ROUTE_POLICY key): reads by status (`ok`: the allowed
 * answers); writes with the session cookie and X-OA-Request, in ORG_WRITES'
 * real mode when the target carries throwaways, else its refuse mode.
 */
function orgProbe(
  route: string,
  okStatus: number[],
  w: OrgWrite | undefined,
): OrgSurface["probe"] {
  const [method = "GET", path = ""] = route.split(" ");
  return async (base, cred, t, io) => {
    const p = fill(path, t);
    if (method === "GET") {
      const r = await send(io, base, p, cred);
      // A 409 is allowed only as member_active (past the transfer guard).
      return classify(route, r, (x) =>
        x.status === 409
          ? okStatus.includes(409) && x.code === "member_active"
          : status(...okStatus)(x),
      );
    }
    if (!w) throw new Unexpected(`${route}: no ORG_WRITES entry`);
    if (!cred.cookie && cred.token)
      throw new Unexpected("this write probe needs a session cookie");
    const c: Ctx = { t, self: () => selfId(io, base, cred) };
    let req: Req;
    let allow: (r: Answer) => boolean;
    if (t.real) {
      for (const k of w.real.needs ?? [])
        if (t.real[k] === undefined)
          throw new Unexpected(`${route}: the real probe needs ${k}`);
      req = await w.real.req(t.real as OrgReal, c);
      allow = w.real.allow;
    } else if (w.refuse) {
      req = await w.refuse.req(c);
      allow = w.refuse.allow;
    } else {
      // Real only: a refusal is still a verdict, an allow can't be shown.
      req = { path: p };
      allow = () => false;
    }
    const r = await send(io, base, req.path || p, cred, {
      method,
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    // A create by a capped caller: the contract's 403, a refusal.
    if (r.status === 403 && r.code === "space_forbidden") return "deny";
    if (!t.real && !w.refuse && !DENY.has(r.status))
      throw new Unexpected(`${route}: real only (no throwaways): ${r.status}`);
    return classify(route, r, allow);
  };
}

const U = { user: true } as const;
const org = (action: string) => ({ org: action });
/** The space service's rule (SPACE_SURFACES' "manager" and "admin"). */
const MANAGER = { user: true, space: "manager" } as const;
const ADMIN = { user: true, space: "admin" } as const;
const ORG: [string, OrgRule, number[]?, "data"?][] = [
  ["GET /api/v1/me", U, [200]],
  ["PATCH /api/v1/me", U],
  ["GET /api/v1/members", org("members.manage"), [200]],
  ["POST /api/v1/members", org("members.manage")],
  ["PATCH /api/v1/members/:id", org("members.manage")],
  ["DELETE /api/v1/members/:id", org("members.manage")],
  // 409 member_active is past the guard: redline's target is an active member.
  ["GET /api/v1/members/:id/transfer", org("transfer.departed"), [200, 409]],
  ["POST /api/v1/members/:id/transfer", org("transfer.departed")],
  ["DELETE /api/v1/members/:id/identities/google", org("members.manage")],
  ["PUT /api/v1/members/:id/restricted", org("restricted.member")],
  ["DELETE /api/v1/members/:id/restricted", org("restricted.member")],
  ["GET /api/v1/settings", org("settings.read"), [200]],
  ["PATCH /api/v1/settings", org("settings.manage")],
  ["GET /api/v1/spaces", U, [200]],
  ["POST /api/v1/spaces", org("space.create")],
  ["GET /api/v1/spaces/:id", { user: true, space: "member" }, [200]],
  // #839: the gate admits any signed-in caller; the space service decides.
  ["PATCH /api/v1/spaces/:id", MANAGER],
  ["DELETE /api/v1/spaces/:id", ADMIN],
  ["GET /api/v1/spaces/:id/members", { user: true, space: "member" }, [200]],
  ["POST /api/v1/spaces/:id/members/self", org("space.adminSelfAdd")],
  [
    "GET /api/v1/spaces/:id/candidates",
    { user: true, space: "manager" },
    [200],
  ],
  ["PUT /api/v1/spaces/:id/members/:userId", MANAGER],
  ["DELETE /api/v1/spaces/:id/members/:userId", MANAGER],
  ["GET /api/v1/spaces/:id/mappings", { user: true, space: "manager" }, [200]],
  ["PUT /api/v1/spaces/:id/mappings/:groupId", MANAGER],
  ["DELETE /api/v1/spaces/:id/mappings/:groupId", MANAGER],
  ["GET /api/v1/directory/org-mappings", org("org.mappings"), [200]],
  ["PUT /api/v1/directory/org-mappings/:groupId", org("org.mappings")],
  ["DELETE /api/v1/directory/org-mappings/:groupId", org("org.mappings")],
  ["GET /api/v1/directory/restricted-groups", org("restricted.groups"), [200]],
  [
    "PUT /api/v1/directory/restricted-groups/:groupId",
    org("restricted.groups"),
  ],
  [
    "DELETE /api/v1/directory/restricted-groups/:groupId",
    org("restricted.groups"),
  ],
  ["GET /api/v1/directory", org("members.manage"), [200]],
  // Starts a consent (a state cookie) and redirects.
  ["GET /api/v1/directory/connect", org("directory.manage"), [302], "data"],
  // A refusal redirects with ?error= and writes an audit row.
  ["GET /api/v1/directory/callback", U, [302], "data"],
  ["POST /api/v1/directory/confirm", org("directory.manage")],
  ["POST /api/v1/directory/cancel", org("directory.manage")],
  ["GET /api/v1/directory/groups", org("org.mappings"), [400]],
  ["POST /api/v1/directory/sync", org("directory.manage")],
  ["POST /api/v1/directory/held/:groupId/confirm", org("directory.manage")],
  ["POST /api/v1/directory/disconnect", org("directory.disconnect")],
  ["DELETE /api/v1/directory", org("directory.disconnect")],
  ["POST /api/v1/admin/broker-check", org("broker.check")],
  ["POST /api/v1/artifacts", org("artifact.create")],
  ["GET /api/v1/tokens", U, [200]],
  ["POST /api/v1/tokens", org("tokens.create")],
  ["PATCH /api/v1/tokens/:id", U],
  ["DELETE /api/v1/tokens/:id", U],
  ["GET /api/v1/usage", org("usage.read"), [200]],
  ["GET /api/v1/audit", org("audit.read"), [200]],
  ["GET /api/v1/audit/export", org("audit.read"), [200]],
  ["GET /api/v1/oauth-clients", U, [200]],
  ["PATCH /api/v1/oauth-clients/:grantId", U],
  ["DELETE /api/v1/oauth-clients/:grantId", U],
];

/** Every instance route (an org or user policy) not reached through an artifact. */
export const ORG_SURFACES: readonly OrgSurface[] = ORG.map(
  ([route, rule, okStatus = [], mutates]) => {
    const w = ORG_WRITES[route];
    return {
      route,
      rule,
      ...(mutates ? { mutates } : {}),
      ...(w && !w.refuse
        ? { realOnly: true as const }
        : w?.refuse?.noDirectory
          ? { realOnly: "no-directory" as const }
          : {}),
      ...(w?.instance ? { instance: true as const } : {}),
      ...(w?.real.needs ? { needs: w.real.needs } : {}),
      probe: orgProbe(route, okStatus, w),
    };
  },
);

/**
 * Routes no caller is scoped on (public or URL-signed policies): listed so
 * a new route must be classified here, in SURFACES or in ORG_SURFACES.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /healthz",
  "GET /robots.txt",
  "GET /skill.md",
  "GET /upgrade.md",
  "ALL /healthz",
  "ALL /robots.txt",
  "ALL /skill.md",
  "ALL /upgrade.md",
  "GET /auth/providers",
  "GET /auth/login",
  "GET /auth/callback",
  "GET /auth/login/google",
  "GET /auth/callback/google",
  "POST /auth/code/request",
  "POST /auth/code/verify",
  "POST /auth/logout",
  "GET /auth/dev-login",
  "ALL /__test/*",
  "PUT /api/v1/uploads/:uploadId",
  "GET /oauth/authorize",
  "POST /oauth/authorize",
  "GET /a/:id",
  "GET /a/:id/full",
  "GET /a/:id/v/:v",
  "GET /*",
  "HEAD /*",
];

/** ROUTE_POLICY keys that none of SURFACES, ORG_SURFACES or PUBLIC_ROUTES lists. */
export function unlisted(
  routePolicy: Readonly<Record<string, object>>,
): string[] {
  const have = new Set([
    ...SURFACES.flatMap((s) => s.routes),
    ...ORG_SURFACES.map((s) => s.route),
    ...PUBLIC_ROUTES,
  ]);
  return Object.keys(routePolicy).filter((k) => !have.has(k));
}

/** Content-host routes nobody is scoped on (robots, the render bundles). */
export const CONTENT_PUBLIC: readonly string[] = [
  "GET /robots.txt",
  "ALL /robots.txt",
  "GET /_oa/*",
];

/** CONTENT_POLICY (or content route) keys neither probed nor CONTENT_PUBLIC. */
export function contentUnlisted(keys: readonly string[]): string[] {
  const probed = new Set(
    SURFACES.flatMap((s) => s.routes)
      .filter((r) => r.startsWith("content:"))
      .map((r) => r.slice("content:".length)),
  );
  return keys.filter((k) => !probed.has(k) && !CONTENT_PUBLIC.includes(k));
}

// ---------------------------------------- space writes (the service rules)

/** Who the space service lets through (after the gate's `{ user }`). */
export type SpaceRule =
  /** An uncapped org owner or admin. */
  | "admin"
  /** An org admin, or the space's uncapped manager. */
  | "manager"
  /** Nobody: the personal-space rule (400 space_personal, or 404). */
  | "none";

/** Ids the space probes need; `cloneId` is a throwaway copy of the space. */
export type SpaceTarget = {
  spaceId: string;
  personalSpaceId: string;
  /** A plain member, the space's editor and its manager. */
  memberId: string;
  editorId: string;
  managerId: string;
  /** Directory groups: mapped viewer and manager on the clone, and a free one. */
  groups: { viewer: string; manager: string; free: string };
  cloneId?: string;
};

export type SpaceSurface = {
  name: string;
  route: string;
  rule: SpaceRule;
  /** "access": runs on `cloneId` (the probe script skips it). */
  mutates?: "access";
  probe(
    base: string,
    cred: Cred,
    t: SpaceTarget,
    io?: ProbeIO,
  ): Promise<Verdict>;
};

/**
 * Allowed: any 2xx, or a 409 the service answers after its access rule
 * (space_not_empty, sync off or frozen). Refused: 401/404, the contract's
 * 403 space_forbidden (a manager past their ceiling), 400 space_personal.
 */
function spaceVerdict(what: string, r: Answer): Verdict {
  if ((r.status >= 200 && r.status < 300) || r.status === 409) return "allow";
  if (r.status === 403 && r.code === "space_forbidden") return "deny";
  if (r.status === 400 && r.code === "space_personal") return "deny";
  return classify(what, r, () => false);
}

const spaceProbe =
  (
    method: string,
    path: (t: SpaceTarget, space: string) => string,
    body: unknown,
    on: "space" | "clone" | "personal",
  ): SpaceSurface["probe"] =>
  async (base, cred, t, io) => {
    const space =
      on === "personal"
        ? t.personalSpaceId
        : on === "clone"
          ? t.cloneId
          : t.spaceId;
    if (!space) throw new Unexpected("this probe needs a space clone");
    const p = path(t, space);
    const r = await send(io, base, p, cred, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    return spaceVerdict(`${method} ${p}`, r);
  };

const SP = "/api/v1/spaces";
const sp = (
  name: string,
  route: string,
  rule: SpaceRule,
  method: string,
  path: (t: SpaceTarget, space: string) => string,
  body: unknown,
  on: "space" | "clone" | "personal",
): SpaceSurface => ({
  name,
  route,
  rule,
  ...(on === "clone" ? { mutates: "access" as const } : {}),
  probe: spaceProbe(method, path, body, on),
});
const at = (_t: SpaceTarget, s: string) => `${SP}/${s}`;
const memberAt =
  (who: "memberId" | "editorId" | "managerId") => (t: SpaceTarget, s: string) =>
    `${SP}/${s}/members/${t[who]}`;
const mappingAt =
  (g: "viewer" | "manager" | "free") => (t: SpaceTarget, s: string) =>
    `${SP}/${s}/mappings/${t.groups[g]}`;

/** The rules behind `{ user }` on the space write routes. */
export const SPACE_SURFACES: readonly SpaceSurface[] = [
  // An empty patch: the manager check, then nothing to write.
  sp("patch {} (S)", `PATCH ${SP}/:id`, "manager", "PATCH", at, {}, "space"),
  sp(
    "patch name",
    `PATCH ${SP}/:id`,
    "manager",
    "PATCH",
    at,
    { name: "x" },
    "clone",
  ),
  // Past a manager's ceiling (SPACE_MANAGER_FIELDS): admins only.
  sp(
    "patch allMembersRole",
    `PATCH ${SP}/:id`,
    "admin",
    "PATCH",
    at,
    { allMembersRole: "viewer" },
    "clone",
  ),
  sp(
    "patch {} (personal)",
    `PATCH ${SP}/:id`,
    "none",
    "PATCH",
    at,
    {},
    "personal",
  ),
  // S holds artifacts: an allowed delete answers 409 space_not_empty.
  sp(
    "delete (S)",
    `DELETE ${SP}/:id`,
    "admin",
    "DELETE",
    at,
    undefined,
    "space",
  ),
  sp(
    "delete (personal)",
    `DELETE ${SP}/:id`,
    "none",
    "DELETE",
    at,
    undefined,
    "personal",
  ),
  sp(
    "member put viewer",
    `PUT ${SP}/:id/members/:userId`,
    "manager",
    "PUT",
    memberAt("memberId"),
    { role: "viewer" },
    "clone",
  ),
  sp(
    "member put manager (ceiling)",
    `PUT ${SP}/:id/members/:userId`,
    "admin",
    "PUT",
    memberAt("memberId"),
    { role: "manager" },
    "clone",
  ),
  sp(
    "member put on a peer manager",
    `PUT ${SP}/:id/members/:userId`,
    "admin",
    "PUT",
    memberAt("managerId"),
    { role: "viewer" },
    "clone",
  ),
  sp(
    "member put (personal)",
    `PUT ${SP}/:id/members/:userId`,
    "none",
    "PUT",
    memberAt("memberId"),
    { role: "viewer" },
    "personal",
  ),
  sp(
    "member delete editor",
    `DELETE ${SP}/:id/members/:userId`,
    "manager",
    "DELETE",
    memberAt("editorId"),
    undefined,
    "clone",
  ),
  sp(
    "member delete a peer manager",
    `DELETE ${SP}/:id/members/:userId`,
    "admin",
    "DELETE",
    memberAt("managerId"),
    undefined,
    "clone",
  ),
  sp(
    "member delete (personal)",
    `DELETE ${SP}/:id/members/:userId`,
    "none",
    "DELETE",
    memberAt("memberId"),
    undefined,
    "personal",
  ),
  sp(
    "mapping put viewer",
    `PUT ${SP}/:id/mappings/:groupId`,
    "manager",
    "PUT",
    mappingAt("free"),
    { role: "viewer" },
    "clone",
  ),
  sp(
    "mapping put manager (ceiling)",
    `PUT ${SP}/:id/mappings/:groupId`,
    "admin",
    "PUT",
    mappingAt("free"),
    { role: "manager" },
    "clone",
  ),
  sp(
    "mapping put (personal)",
    `PUT ${SP}/:id/mappings/:groupId`,
    "none",
    "PUT",
    mappingAt("free"),
    { role: "viewer" },
    "personal",
  ),
  sp(
    "mapping delete viewer",
    `DELETE ${SP}/:id/mappings/:groupId`,
    "manager",
    "DELETE",
    mappingAt("viewer"),
    undefined,
    "clone",
  ),
  sp(
    "mapping delete a manager mapping",
    `DELETE ${SP}/:id/mappings/:groupId`,
    "admin",
    "DELETE",
    mappingAt("manager"),
    undefined,
    "clone",
  ),
  sp(
    "mapping delete (personal)",
    `DELETE ${SP}/:id/mappings/:groupId`,
    "none",
    "DELETE",
    mappingAt("viewer"),
    undefined,
    "personal",
  ),
];
