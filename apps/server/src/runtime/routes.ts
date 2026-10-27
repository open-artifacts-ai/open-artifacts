import {
  ANON_ID_HEADER,
  DataNameSchema,
  DataQuerySchema,
  dataDocTooLargeMessage,
  dataLimits,
  dataResetLimit,
  dataResetTooLargeMessage,
  isId,
  METHOD_CAPABILITY,
  planOf,
  RUNTIME_PARAMS,
  type RuntimeMethod,
  StorageKeyNameSchema,
  type Visibility,
} from "@oa/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  accessLevel,
  authorize,
  type Caller,
  caller,
  canCtx,
  dataWriteRefusal,
  requireAccess,
} from "../auth/authz.js";
import { can, capsOf, namedEvents, type PolicyAction } from "../auth/policy.js";
import { cappedJson, readCapped } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import type { AppType } from "../routes/index.js";
import { type AnonId, resolveAnonId } from "./anon-id.js";
import {
  ACTOR_HEADER,
  AUTHZ_AT_HEADER,
  EVENTS_NAMED_HEADER,
  EVENTS_VERSION_HEADER,
  publicActor,
  runtimeCall,
  runtimeStub,
} from "./do.js";

// Literals so Hono infers params; must equal R.data* / R.storage* in @oa/shared.
const ART = "/api/v1/artifacts/:id";
const DATA = `${ART}/data`;
const COL = `${ART}/data/:col`;
const QUERY = `${COL}/query`;
const DOC = `${COL}/:doc`;
const SUBSCRIBE = `${ART}/data-subscribe`;
const EVENTS = `${ART}/events`;
const COUNT = `${ART}/data-count/:col`;
const ANON_ID = `${ART}/anon-id`;
const STORAGE = `${ART}/storage`;
const KEY = `${STORAGE}/:key`;

/**
 * Raw write bodies (doc, patch, {value}) are measured as sent, whitespace
 * included: the DO checks the raw bytes against the instance's data-doc limit
 * without re-serializing (which would cost CPU). So the cap here is the limit
 * itself: over it, 413 with the plan message from Content-Length, before the
 * body is read.
 */
const readDocBody = (c: C): Promise<Uint8Array> => {
  const { plan, docBytes } = dataLimits(c.env);
  return readCapped(c, docBytes, dataDocTooLargeMessage(plan, docBytes));
};
const MAX_QUERY_BODY = 64 * 1024;
/** CF-Connecting-IP: IPv4 or IPv6 text form. */
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

type C = Context<AppEnv>;
/** `authzAt`: when the access check ran (ms), for the presence check on sockets. */
type Gate = {
  artifactId: string;
  actor: string;
  anon: AnonId | null;
  authzAt: number;
};

/**
 * When this request's authorization began: stamped by the policy gate before
 * the session read, so a revocation written after any access read has
 * revokedAt >= authzAt and a socket it raced is refused (presence).
 */
function authzAtOf(c: C): number {
  const t = c.get("authzAt");
  // No fallback: a later stamp could miss a revocation that raced the read.
  if (t === undefined) throw new Error("authzAt not stamped (enforcePolicy)");
  return t;
}

export { capsOf };

function name(v: string | undefined, what: string): string {
  const r = DataNameSchema.safeParse(v);
  if (!r.success) throw new ApiError("bad_request", `Invalid ${what}`);
  return r.data;
}

/**
 * Rate-limit identity for an anonymous IP: IPv4 as is; IPv6 as its /64
 * ("2001:db8:1:2::/64"), since one host can rotate through a whole /64.
 * Null when `ip` is not an address.
 */
export function ipKey(ip: string): string | null {
  if (IPV4_RE.test(ip))
    return ip.split(".").every((o) => Number(o) <= 255) ? ip : null;
  if (!IP_RE.test(ip) || !ip.includes(":")) return null;
  let s = ip.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = (v4[2] as string).split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = o;
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The anonymous socket actor key (R.events and data subscribe, for the DO's
 * per-actor caps and RL_ANON): IPv4 as is; IPv6 as its /56
 * ("2001:db8:1:200::/56"), since one subscriber typically holds a /56 of
 * /64s, so a per-actor socket cap can't be multiplied by 256.
 */
export function anonIpKey(ip: string): string | null {
  const k = ipKey(ip);
  if (!k?.endsWith("::/64")) return k;
  const g = k.slice(0, -5).split(":");
  const g3 = Number.parseInt(g[3] ?? "0", 16) & 0xff00;
  return `${g.slice(0, 3).join(":")}:${g3.toString(16)}::/56`;
}

/**
 * Applies RL_ANON to `key`. Fails closed (503) when the binding is missing
 * outside ENVIRONMENT=dev (the test pool and local dev have none).
 */
async function anonLimit(c: C, key: string, what: string): Promise<void> {
  const rl = c.env.RL_ANON;
  if (!rl) {
    if (c.env.ENVIRONMENT === "dev") return;
    throw new HTTPException(503, { message: "rate limiter unavailable" });
  }
  if (!(await rl.limit({ key })).success)
    throw new ApiError(
      "rate_limited",
      `Too many ${what}; try again in a minute`,
    );
}

/**
 * Access (404 for no access, never 403), then the declared capability
 * (403 capability_denied: access is already proven), then the caller's actor:
 * - storage: signed-in only (401), actor "u:{id}" (the storage owner).
 * - data writes: signed-in "u:{id}"; anonymous only with dataWriters
 *   "viewers", after RL_ANON "ip:{key}" (429; 503 if unbound outside dev),
 *   as "ip:{key}|{short}" (ipKey: IPv4, or the IPv6 /64). A write refused by
 *   dataWriters "editors" is 403 data_editors_only, signed in or not (#681).
 * - subscribe: signed-in "u:{id}"; anonymous "ip:{key}" after RL_ANON
 *   "sub:ip:{key}" (anonIpKey: IPv4, or the IPv6 /56).
 * - data reads: anyone with view access (actor unused).
 * - anonId: anonymous writes, and "anonId" (GET anon-id, after RL_ANON
 *   "anonid:ip:{key}" when it mints; a valid current token skips the limit),
 *   on an artifact with dataWriters "viewers" only: the
 *   ANON_ID_HEADER token is verified, or a new one minted (returned by
 *   `withAnon`). `short` is per artifact; a write stores updatedBy
 *   "anon:{short}", and the DO still rate limits by "ip:{key}". Reads never
 *   touch it; signed-in callers and other artifacts never get one.
 */
/** gate() kinds as policy actions (1:1). Signed-in callers never get an anonId. */
const GATE_ACTION = {
  read: "data.read",
  write: "data.write",
  storage: "storage",
  subscribe: "subscribe",
  anonId: "anonId",
} as const satisfies Record<string, PolicyAction>;

async function gate(
  c: C,
  method: RuntimeMethod,
  kind: "read" | "write" | "storage" | "subscribe" | "anonId",
): Promise<Gate> {
  const artifactId = c.req.param("id") ?? "";
  if (!isId(artifactId)) throw new ApiError("not_found", "Not found");
  // Embed mode (X-OA-Embed: 1) is downgrade-only: the call runs anonymously
  // whatever cookie or token came with it (#295 does this app-wide).
  const who: Caller =
    c.req.header("x-oa-embed") === "1" ? { kind: "anonymous" } : caller(c);
  const authzAt = authzAtOf(c);
  const r = await accessLevel(c.env, who, artifactId);
  if (!r) throw new ApiError("not_found", "Not found");
  const a = r.artifact;
  // Each gate kind is one policy action; checked after the anonymous 401s
  // below so their messages keep their order.
  const ctx = canCtx(who, a);
  const allowed = () => can(r.level, GATE_ACTION[kind], ctx);
  /** A refused data write: data_editors_only when "editors" caused it, else 404. */
  const refused = () =>
    (kind === "write" ? dataWriteRefusal(r.level, ctx, a) : null) ??
    new ApiError("not_found", "Not found");
  const cap = METHOD_CAPABILITY[method];
  if (!capsOf(a.capabilities)[cap])
    throw new ApiError(
      "capability_denied",
      `This artifact did not declare the "${cap}" capability`,
    );
  if (who.kind === "user") {
    // Signed-in callers asking for an anonId get the route's own 401 below.
    if (kind !== "anonId" && !allowed()) throw refused();
    return { artifactId, actor: `u:${who.user.id}`, anon: null, authzAt };
  }
  if (kind === "read") return { artifactId, actor: "", anon: null, authzAt };
  if (kind === "storage")
    throw new ApiError("unauthorized", "Sign in to save changes");
  if (kind === "anonId" && ctx.dataWriters !== "viewers")
    throw new ApiError("unauthorized", "No anonymous id here");
  if (!allowed()) throw refused();
  const anonId = async (): Promise<AnonId> => {
    const r = await resolveAnonId(
      c.env,
      artifactId,
      c.req.header(ANON_ID_HEADER),
      true,
    );
    if (!r) throw new Error("anonId not minted");
    return r;
  };
  const ip = c.req.header("cf-connecting-ip") ?? "";
  const key = kind === "subscribe" ? anonIpKey(ip) : ipKey(ip);
  if (!key)
    throw new ApiError("rate_limited", "Anonymous access is unavailable");
  if (kind === "subscribe") {
    await anonLimit(c, `sub:ip:${key}`, "subscriptions");
    return { artifactId, actor: `ip:${key}`, anon: null, authzAt };
  }
  if (kind === "anonId") {
    // A valid, current token only reads back this artifact's short id (an
    // HMAC check), so reloads never spend the per-IP budget. Minting a new id
    // (none, forged, v1 or expired) stays limited.
    const held = await resolveAnonId(
      c.env,
      artifactId,
      c.req.header(ANON_ID_HEADER),
      false,
    );
    if (held) return { artifactId, actor: "", anon: held, authzAt };
    await anonLimit(c, `anonid:ip:${key}`, "requests");
    return { artifactId, actor: "", anon: await anonId(), authzAt };
  }
  await anonLimit(c, `ip:${key}`, "writes");
  const anon = await anonId();
  return { artifactId, actor: `ip:${key}|${anon.short}`, anon, authzAt };
}

/** `res` carrying a newly minted anonId token, if the gate minted one. */
function withAnon(g: Gate, res: Response): Response {
  if (!g.anon?.issued) return res;
  const out = new Response(res.body, res);
  out.headers.set(ANON_ID_HEADER, g.anon.issued);
  out.headers.set("cache-control", "no-store");
  return out;
}

const enc = new TextEncoder();
const toBuffer = (b: Uint8Array): ArrayBuffer =>
  b.byteOffset === 0 && b.buffer.byteLength === b.byteLength
    ? (b.buffer as ArrayBuffer)
    : (b.slice().buffer as ArrayBuffer);
/** The raw request body, capped while streaming; never decoded or parsed here. */
const rawBody = async (c: C): Promise<ArrayBuffer> =>
  toBuffer(await readDocBody(c));
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
const jsonText = (text: string) =>
  new Response(text, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });

const stub = (c: C, g: Gate) => runtimeStub(c.env, g.artifactId);

export function mountRuntime(app: AppType): void {
  // viewer.anonId() for an anonymous viewer: their per-artifact public id.
  app.get(ANON_ID, async (c) => {
    const g = await gate(c, "viewer.anonId", "anonId");
    if (!g.anon) throw new ApiError("unauthorized", "No anonymous id here");
    return withAnon(g, c.json({ anonId: g.anon.short }));
  });

  app.get(COL, async (c) => {
    const g = await gate(c, "db.list", "read");
    const p = RUNTIME_PARAMS["db.list"].safeParse({
      collection: c.req.param("col"),
      cursor: c.req.query("cursor"),
      limit: intParam(c.req.query("limit")),
    });
    if (!p.success) throw new ApiError("bad_request", "Invalid list request");
    const { collection, cursor, limit: n } = p.data;
    return c.json(
      await runtimeCall(() => stub(c, g).list(collection, cursor, n)),
    );
  });

  // Same gate as the list route (db.list: access, "db" capability, anonymous
  // reads on public artifacts); one indexed COUNT(*) in the DO.
  app.get(COUNT, async (c) => {
    const g = await gate(c, "db.list", "read");
    const col = name(c.req.param("col"), "collection");
    return c.json(await runtimeCall(() => stub(c, g).count(col)));
  });

  // A read, but POST: the query is a JSON body.
  app.post(QUERY, async (c) => {
    const g = await gate(c, "db.query", "read");
    const col = name(c.req.param("col"), "collection");
    const q = await cappedJson(c, DataQuerySchema, MAX_QUERY_BODY);
    return c.json(await runtimeCall(() => stub(c, g).query(col, q)));
  });

  app.get(DOC, async (c) => {
    const g = await gate(c, "db.get", "read");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const d = await runtimeCall(() => stub(c, g).get(col, id));
    if (!d) throw new ApiError("not_found", "Not found");
    return c.json(d);
  });

  app.put(DOC, async (c) => {
    const g = await gate(c, "db.set", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const body = await readDocBody(c);
    const { updatedAt } = await runtimeCall(() =>
      stub(c, g).setRaw(col, id, toBuffer(body), g.actor),
    );
    // The DataDoc, with the (DO-validated) body bytes spliced in unparsed.
    const [head, tail] = JSON.stringify({
      id,
      data: null,
      updatedAt,
      updatedBy: publicActor(g.actor),
    }).split('"data":null');
    return withAnon(
      g,
      new Response(
        concat(enc.encode(`${head}"data":`), body, enc.encode(tail ?? "")),
        { headers: { "content-type": "application/json; charset=UTF-8" } },
      ),
    );
  });

  app.patch(DOC, async (c) => {
    const g = await gate(c, "db.update", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    const body = await rawBody(c);
    return withAnon(
      g,
      jsonText(
        await runtimeCall(() => stub(c, g).updateRaw(col, id, body, g.actor)),
      ),
    );
  });

  app.delete(DOC, async (c) => {
    const g = await gate(c, "db.delete", "write");
    const col = name(c.req.param("col"), "collection");
    const id = name(c.req.param("doc"), "document id");
    await runtimeCall(() => stub(c, g).delete(col, id, g.actor));
    return withAnon(g, c.body(null, 204));
  });

  // Owner-only atomic replace of all data docs (R.dataReset). The body is capped
  // here and forwarded unparsed: the DO parses, validates and replaces in one
  // transaction, so a multi-MB snapshot costs the Worker no JSON CPU.
  app.put(DATA, async (c) => {
    const artifactId = c.req.param("id") ?? "";
    if (!isId(artifactId)) throw new ApiError("not_found", "Not found");
    const who = caller(c);
    const { artifact: a } = await authorize(
      c.env,
      who,
      artifactId,
      "data.reset",
    );
    if (who.kind !== "user") throw new ApiError("not_found", "Not found");
    if (!capsOf(a.capabilities).db)
      throw new ApiError(
        "capability_denied",
        'This artifact did not declare the "db" capability',
      );
    const plan = planOf(c.env.PLAN);
    const body = await readCapped(
      c,
      dataResetLimit(plan),
      dataResetTooLargeMessage(plan),
    );
    const g: Gate = {
      artifactId,
      actor: `u:${who.user.id}`,
      anon: null,
      authzAt: authzAtOf(c),
    };
    return c.json(
      await runtimeCall(() => stub(c, g).replaceRaw(toBuffer(body), g.actor)),
    );
  });

  // WebSocket feed of DataChange frames, served by the artifact's DO.
  app.get(SUBSCRIBE, async (c) => {
    // Browsers always send Origin on WebSocket handshakes: refuse other sites.
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== appOrigin(c.env))
      throw new ApiError("csrf", "Cross-site request");
    const g = await gate(c, "db.subscribe", "subscribe");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.text("Expected WebSocket upgrade", 426);
    const col = name(c.req.query("collection"), "collection");
    const url = `https://runtime.invalid/subscribe?collection=${encodeURIComponent(col)}`;
    return stub(c, g).fetch(url, {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: g.actor,
        [AUTHZ_AT_HEADER]: String(g.authzAt),
      },
    });
  });

  // WebSocket feed of ArtifactEvent frames (live versions), served by the
  // artifact's DO. Read access only: no capability, works for every artifact.
  app.get(EVENTS, async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== appOrigin(c.env))
      throw new ApiError("csrf", "Cross-site request");
    const artifactId = c.req.param("id") ?? "";
    if (!isId(artifactId)) throw new ApiError("not_found", "Not found");
    // Embed mode is downgrade-only (caller() also honours ?embed=1).
    const who: Caller =
      c.req.header("x-oa-embed") === "1" ? { kind: "anonymous" } : caller(c);
    const authzAt = authzAtOf(c);
    const r = await accessLevel(c.env, who, artifactId);
    if (!r) throw new ApiError("not_found", "Not found");
    let actor: string;
    let named = false;
    if (who.kind === "user") {
      actor = `u:${who.user.id}`;
      // Publisher names: team members, and anyone whose access is more than
      // a public link (owner, editor, or a viewer share/team access on a
      // non-public artifact). Guests reading a public link get `{ kind }`.
      named = namedEvents(
        who.user,
        r.level,
        r.artifact.visibility as Visibility,
      );
    } else {
      const key = anonIpKey(c.req.header("cf-connecting-ip") ?? "");
      if (!key)
        throw new ApiError("rate_limited", "Anonymous access is unavailable");
      await anonLimit(c, `ev:ip:${key}`, "connections");
      actor = `ip:${key}`;
    }
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.text("Expected WebSocket upgrade", 426);
    return runtimeStub(c.env, artifactId).fetch(
      "https://runtime.invalid/events",
      {
        headers: {
          Upgrade: "websocket",
          [ACTOR_HEADER]: actor,
          [AUTHZ_AT_HEADER]: String(authzAt),
          [EVENTS_VERSION_HEADER]: String(r.artifact.currentVersion),
          [EVENTS_NAMED_HEADER]: named ? "1" : "0",
        },
      },
    );
  });

  app.get(STORAGE, async (c) => {
    const g = await gate(c, "storage.list", "storage");
    const p = RUNTIME_PARAMS["storage.list"].safeParse({
      cursor: c.req.query("cursor"),
      limit: intParam(c.req.query("limit")),
    });
    if (!p.success) throw new ApiError("bad_request", "Invalid list request");
    const { cursor, limit: n } = p.data;
    return c.json(
      await runtimeCall(() => stub(c, g).storageList(g.actor, cursor, n)),
    );
  });

  app.get(KEY, async (c) => {
    const g = await gate(c, "storage.get", "storage");
    const key = storageKeyOf(c);
    const e = await runtimeCall(() => stub(c, g).storageEntry(g.actor, key));
    if (!e) throw new ApiError("not_found", "Not found");
    return c.json(e);
  });

  app.put(KEY, async (c) => {
    const g = await gate(c, "storage.set", "storage");
    const key = storageKeyOf(c);
    const body = await rawBody(c);
    return jsonText(
      await runtimeCall(() => stub(c, g).storageSetRaw(g.actor, key, body)),
    );
  });

  app.delete(KEY, async (c) => {
    const g = await gate(c, "storage.delete", "storage");
    const key = storageKeyOf(c);
    await runtimeCall(() => stub(c, g).storageDelete(g.actor, key));
    return c.body(null, 204);
  });
}

/** Query-string integer: undefined when absent, NaN (fails the schema) when malformed. */
const intParam = (v: string | undefined): number | undefined =>
  v === undefined ? undefined : /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;

function storageKeyOf(c: C): string {
  const r = StorageKeyNameSchema.safeParse(c.req.param("key"));
  if (!r.success) throw new ApiError("bad_request", "Invalid key");
  return r.data;
}
