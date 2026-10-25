// Cloudflare REST client for the hosted provisioner. Typed calls only; every
// script call picks its route from the caller's `target` (decision 1), never
// from an install id. Errors carry method, route, status and Cloudflare's own
// error text, never a request body, header or token.
import { createHash } from "node:crypto";
import type { UploadMetadata } from "./metadata.js";
import { assertAssetPath } from "./release.js";

const API = "https://api.cloudflare.com/client/v4";
const TRIES = 3;

export type Target = { kind: "account" } | { kind: "namespace"; ns: string };

export class CfError extends Error {
  override name = "CfError";
  constructor(
    readonly method: string,
    readonly route: string,
    readonly status: number,
    /** Cloudflare's error codes and messages (never the request body). */
    readonly cfMessage: string,
  ) {
    super(
      `Cloudflare ${method} ${route}: HTTP ${status}${cfMessage ? ` (${cfMessage})` : ""}`,
    );
  }
}

export interface Module {
  name: string;
  type: "esm" | "wasm";
  bytes: Uint8Array;
}

export interface D1Result {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface TokenInfo {
  status?: string;
  not_before?: string;
  expires_on?: string;
}

export interface R2ObjectInfo {
  key: string;
  size: number;
  etag: string;
}

/** An R2 write condition: create-only, or replace exactly this etag. */
export type R2PutCondition = { ifNoneMatch: "*" } | { ifMatch: string };

export interface TurnstileWidget {
  sitekey: string;
  name: string;
  domains: string[];
  mode?: string;
  /** Only on a single-widget GET; never printed. */
  secret?: string;
}

export interface Cf {
  readonly accountId: string;
  tokenVerify(): Promise<TokenInfo>;
  /** GET /accounts/{id}/workers/scripts?per_page=1 (proves Workers Scripts Read). */
  scriptsRead(): Promise<void>;
  d1Create(name: string): Promise<string>;
  d1Get(name: string): Promise<string | null>;
  d1Query(id: string, sql: string, params?: unknown[]): Promise<D1Result[]>;
  /** REST batch: the statements run as one transaction (all or none). */
  d1Batch(
    id: string,
    stmts: { sql: string; params?: unknown[] }[],
  ): Promise<D1Result[]>;
  d1Delete(id: string): Promise<void>;
  /** The name of the D1 with this id (null when there is none); delete checks it. */
  d1NameOf(id: string): Promise<string | null>;
  r2Create(name: string): Promise<void>;
  r2Exists(name: string): Promise<boolean>;
  r2Delete(name: string): Promise<void>;
  kvCreate(title: string): Promise<string>;
  kvFind(title: string): Promise<string | null>;
  kvDelete(id: string): Promise<void>;
  /** The title of the KV namespace with this id (null when there is none). */
  kvTitleOf(id: string): Promise<string | null>;
  kvPut(id: string, key: string, value: string): Promise<void>;
  kvGet(id: string, key: string): Promise<string | null>;
  kvDeleteKey(id: string, key: string): Promise<void>;
  scriptExists(t: Target, script: string): Promise<boolean>;
  scriptUpload(
    t: Target,
    script: string,
    metadata: UploadMetadata,
    modules: Module[],
  ): Promise<void>;
  scriptDelete(t: Target, script: string): Promise<void>;
  secretPut(
    t: Target,
    script: string,
    name: string,
    text: string,
  ): Promise<void>;
  secretList(t: Target, script: string): Promise<string[]>;
  scriptSubdomain(
    t: Target,
    script: string,
    body: { enabled: boolean; previews_enabled: boolean },
  ): Promise<void>;
  /**
   * Upload session on the target's route, buckets on the account route;
   * returns the completion jwt. Paths are relative; a dotfile, dot-directory
   * or other unsafe path is refused before any call.
   */
  assetsUpload(
    t: Target,
    script: string,
    files: readonly { path: string; bytes: Uint8Array }[],
  ): Promise<{ jwt: string }>;
  /** GET a Turnstile widget by sitekey (read-only); null when there is none. */
  turnstileWidget(sitekey: string): Promise<TurnstileWidget | null>;
  /** Every Turnstile widget on the account (no secrets), paginated. */
  turnstileList(): Promise<TurnstileWidget[]>;
  /** POST a widget (turnstile-init only); returns its sitekey and secret. */
  turnstileCreate(w: {
    name: string;
    domains: string[];
    mode: "managed";
  }): Promise<{ sitekey: string; secret: string }>;
  /**
   * R2 objects in an env's releases bucket (platformNames(env).releases),
   * account-scoped REST routes only. null when the object does not exist.
   */
  r2ObjectGet(
    bucket: string,
    key: string,
    opts?: { maxBytes?: number },
  ): Promise<{ bytes: Uint8Array; etag: string } | null>;
  /** Deletes a probe/<32 hex> key only (probeR2Conditionals); any other key is refused. */
  r2ObjectDelete(bucket: string, key: string): Promise<void>;
  r2ObjectHead(
    bucket: string,
    key: string,
  ): Promise<{ size: number; etag: string } | null>;
  /**
   * A conditional PUT; a failed condition is a CfError with status 412. A
   * 412 on a retry is accepted only when the object holds exactly `bytes`.
   */
  r2ObjectPut(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    cond: R2PutCondition,
  ): Promise<void>;
  /** One page of keys under `prefix`; pass `cursor` back for the next page. */
  r2ObjectList(
    bucket: string,
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: R2ObjectInfo[]; cursor?: string; truncated: boolean }>;
  /** The first page of keys in an install's own bucket (oa-<s|p>-<install id>); delete empties it. */
  r2InstallKeys(bucket: string): Promise<string[]>;
  /** Deletes one object from an install's own bucket; any other bucket is refused. */
  r2InstallDeleteObject(bucket: string, key: string): Promise<void>;
}

/** The only keys r2ObjectDelete may delete: probeR2Conditionals' throwaway keys. */
const PROBE_KEY = /^probe\/[0-9a-f]{32}$/;

/** The only buckets the R2 object calls touch: the releases bucket of an env. */
const RELEASES_BUCKET = /^oa-[sp]-releases$/;

/** An install's own bucket (names(id).r2): the only bucket delete may empty. */
const INSTALL_BUCKET = /^oa-[sp]-i[a-z0-9]{11}$/;
const installBucket = (bucket: string) => {
  if (typeof bucket !== "string" || !INSTALL_BUCKET.test(bucket))
    throw new Error(
      `install object calls are for an install's own bucket only, not ${JSON.stringify(bucket).slice(0, 60)}`,
    );
  return bucket;
};

/** Manifest hash: the first 32 hex characters of SHA-256 (64 is rejected). */
export function assetHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

const seg = (s: string) => encodeURIComponent(s);

function scriptBase(t: Target, script: string): string {
  if (t.kind === "account") return `/workers/scripts/${seg(script)}`;
  if (t.kind === "namespace" && typeof t.ns === "string" && t.ns !== "")
    return `/workers/dispatch/namespaces/${seg(t.ns)}/scripts/${seg(script)}`;
  throw new Error("invalid script target");
}

function describeErrors(body: unknown): string {
  const errs = (body as { errors?: { code?: unknown; message?: unknown }[] })
    ?.errors;
  if (!Array.isArray(errs)) return "";
  return errs
    .map((e) => `${e?.code ?? ""} ${String(e?.message ?? "")}`.trim())
    .join("; ")
    .slice(0, 300);
}

type CallInit = {
  body?: BodyInit;
  json?: unknown;
  auth?: string;
  headers?: Record<string, string>;
  /** Keep the raw body bytes (R2 objects are not JSON). */
  binary?: boolean;
  /** With binary: abort (no retry) once the body exceeds this many bytes. */
  maxBytes?: number;
};

/** The body, refused as soon as it passes `max` bytes (content-length or streamed). */
async function readCapped(
  res: Response,
  max: number,
  route: string,
): Promise<Uint8Array> {
  const over = () =>
    new Error(
      `R2 object ${route}: the body is over its size limit (${max} bytes)`,
    );
  const len = res.headers.get("content-length");
  if (len !== null && Number(len) > max) throw over();
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw over();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function cfClient(o: {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Cf {
  if (!/^[0-9a-f]{32}$/.test(o.accountId))
    throw new Error("accountId must be 32 hex characters");
  const f = o.fetch ?? fetch;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const acct = `/accounts/${o.accountId}`;

  /** One call, 3 tries on 429/5xx/network; errors show the route without its query. */
  async function call(
    method: string,
    path: string,
    init: CallInit = {},
    ok: number[] = [],
  ): Promise<{
    status: number;
    body: unknown;
    text: string;
    bytes?: Uint8Array;
    headers: Headers;
    /** 0 for the first try; a later value means an earlier try was lost. */
    attempt: number;
  }> {
    const route = path.split("?")[0] as string;
    const headers: Record<string, string> = {
      ...init.headers,
      authorization: `Bearer ${init.auth ?? o.token}`,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    let last: CfError | undefined;
    for (let i = 0; i < TRIES; i++) {
      if (i > 0) await sleep(500 * 2 ** (i - 1));
      let res: Response;
      try {
        res = await f(`${API}${path}`, { method, headers, body });
      } catch (e) {
        last = new CfError(method, route, 0, `network: ${(e as Error).name}`);
        continue;
      }
      const bytes =
        init.binary && res.ok
          ? init.maxBytes !== undefined
            ? await readCapped(res, init.maxBytes, route)
            : new Uint8Array(await res.arrayBuffer())
          : undefined;
      const text = bytes ? "" : await res.text();
      let parsed: unknown;
      try {
        parsed = bytes ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (res.ok || ok.includes(res.status))
        return {
          status: res.status,
          body: parsed,
          text,
          bytes,
          headers: res.headers,
          attempt: i,
        };
      last = new CfError(method, route, res.status, describeErrors(parsed));
      if (res.status !== 429 && res.status < 500) throw last;
    }
    throw last as CfError;
  }
  const result = async <T>(
    method: string,
    path: string,
    init?: CallInit,
  ): Promise<T> =>
    ((await call(method, path, init)).body as { result: T })?.result;
  const exists = async (path: string) =>
    (await call("GET", path, {}, [404])).status !== 404;
  const kvPath = (id: string, key: string) =>
    `${acct}/storage/kv/namespaces/${seg(id)}/values/${seg(key)}`;
  const r2Path = (bucket: string, key: string) => {
    if (!RELEASES_BUCKET.test(bucket))
      throw new Error(
        `R2 object calls are for an env's releases bucket only, not ${JSON.stringify(bucket).slice(0, 60)}`,
      );
    if (typeof key !== "string" || key === "" || key.length > 1024)
      throw new Error("invalid R2 object key");
    return `${acct}/r2/buckets/${seg(bucket)}/objects/${seg(key)}`;
  };
  const etagOf = (h: Headers) =>
    (h.get("etag") ?? "").replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

  return {
    accountId: o.accountId,
    tokenVerify: () => result<TokenInfo>("GET", "/user/tokens/verify"),
    async scriptsRead() {
      await call("GET", `${acct}/workers/scripts?per_page=1`);
    },

    async d1Create(name) {
      const r = await result<{ uuid: string }>("POST", `${acct}/d1/database`, {
        json: { name },
      });
      return r.uuid;
    },
    async d1Get(name) {
      // The name filter is a substring match: page until found or exhausted.
      const per = 100;
      for (let page = 1; page <= 100; page++) {
        const { body } = await call(
          "GET",
          `${acct}/d1/database?name=${seg(name)}&per_page=${per}&page=${page}`,
        );
        const b = body as {
          result?: { uuid: string; name: string }[];
          result_info?: { total_pages?: number };
        };
        const r = b?.result ?? [];
        const hit = r.find((d) => d.name === name);
        if (hit) return hit.uuid;
        // Trust total_pages when Cloudflare sends it (a page may be clamped
        // or short mid-list); only without it does a short page end the list.
        const pages = b?.result_info?.total_pages;
        if (typeof pages === "number" && Number.isFinite(pages)) {
          if (page >= pages) return null;
        } else if (r.length < per) return null;
      }
      throw new Error("D1 database listing did not end after 100 pages");
    },
    d1Query: (id, sql, params = []) =>
      result<D1Result[]>("POST", `${acct}/d1/database/${seg(id)}/query`, {
        json: { sql, params },
      }),
    d1Batch: (id, stmts) =>
      result<D1Result[]>("POST", `${acct}/d1/database/${seg(id)}/query`, {
        json: {
          batch: stmts.map((q) => ({ sql: q.sql, params: q.params ?? [] })),
        },
      }),
    async d1Delete(id) {
      await call("DELETE", `${acct}/d1/database/${seg(id)}`);
    },
    async d1NameOf(id) {
      const r = await call("GET", `${acct}/d1/database/${seg(id)}`, {}, [404]);
      if (r.status === 404) return null;
      const name = (r.body as { result?: { name?: unknown } })?.result?.name;
      return typeof name === "string" ? name : null;
    },

    async r2Create(name) {
      await call("POST", `${acct}/r2/buckets`, { json: { name } });
    },
    r2Exists: (name) => exists(`${acct}/r2/buckets/${seg(name)}`),
    async r2Delete(name) {
      await call("DELETE", `${acct}/r2/buckets/${seg(name)}`);
    },

    async kvCreate(title) {
      const r = await result<{ id: string }>(
        "POST",
        `${acct}/storage/kv/namespaces`,
        { json: { title } },
      );
      return r.id;
    },
    async kvFind(title) {
      for (let page = 1; page <= 50; page++) {
        const r = await result<{ id: string; title: string }[]>(
          "GET",
          `${acct}/storage/kv/namespaces?per_page=100&page=${page}`,
        );
        const hit = r.find((n) => n.title === title);
        if (hit) return hit.id;
        if (r.length < 100) return null;
      }
      throw new Error("KV namespace listing did not end after 50 pages");
    },
    async kvDelete(id) {
      await call("DELETE", `${acct}/storage/kv/namespaces/${seg(id)}`);
    },
    async kvTitleOf(id) {
      const r = await call(
        "GET",
        `${acct}/storage/kv/namespaces/${seg(id)}`,
        {},
        [404],
      );
      if (r.status === 404) return null;
      const t = (r.body as { result?: { title?: unknown } })?.result?.title;
      return typeof t === "string" ? t : null;
    },
    async kvPut(id, key, value) {
      await call("PUT", kvPath(id, key), { body: value });
    },
    async kvGet(id, key) {
      const r = await call("GET", kvPath(id, key), {}, [404]);
      if (r.status !== 404) return r.text;
      // Only "key not found" (10009) is a miss; a missing namespace is an error.
      const codes = (
        (r.body as { errors?: { code?: unknown }[] })?.errors ?? []
      ).map((e) => e?.code);
      if (codes.includes(10009)) return null;
      throw new CfError(
        "GET",
        `${acct}/storage/kv/namespaces/${seg(id)}/values`,
        404,
        describeErrors(r.body),
      );
    },
    async kvDeleteKey(id, key) {
      await call("DELETE", kvPath(id, key));
    },

    scriptExists: (t, script) =>
      exists(`${acct}${scriptBase(t, script)}/settings`),
    async scriptUpload(t, script, metadata, modules) {
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      for (const m of modules)
        form.append(
          m.name,
          new Blob([m.bytes as BlobPart], {
            type:
              m.type === "wasm"
                ? "application/wasm"
                : "application/javascript+module",
          }),
          m.name,
        );
      await call("PUT", `${acct}${scriptBase(t, script)}`, { body: form });
    },
    async scriptDelete(t, script) {
      await call("DELETE", `${acct}${scriptBase(t, script)}`);
    },
    async secretPut(t, script, name, text) {
      await call("PUT", `${acct}${scriptBase(t, script)}/secrets`, {
        json: { name, text, type: "secret_text" },
      });
    },
    async secretList(t, script) {
      const r = await result<{ name: string }[]>(
        "GET",
        `${acct}${scriptBase(t, script)}/secrets`,
      );
      return r.map((s) => s.name);
    },
    async scriptSubdomain(t, script, body) {
      await call("POST", `${acct}${scriptBase(t, script)}/subdomain`, {
        json: body,
      });
    },
    async assetsUpload(t, script, list) {
      const files = new Map<string, Uint8Array>();
      const manifest: Record<string, { hash: string; size: number }> = {};
      for (const f of list) {
        assertAssetPath(f?.path);
        const key = `/${f.path}`;
        if (Object.hasOwn(manifest, key))
          throw new Error(`asset path ${f.path} appears twice`);
        const bytes = f.bytes;
        const hash = assetHash(bytes);
        manifest[key] = { hash, size: bytes.byteLength };
        files.set(hash, bytes);
      }
      const sess = await result<{ jwt: string; buckets?: string[][] }>(
        "POST",
        `${acct}${scriptBase(t, script)}/assets-upload-session`,
        { json: { manifest } },
      );
      const buckets = sess.buckets ?? [];
      // Nothing new to upload: the session jwt is the completion token.
      if (buckets.length === 0) return { jwt: sess.jwt };
      let jwt = sess.jwt;
      const route = `${acct}/workers/assets/upload`;
      for (const [i, bucket] of buckets.entries()) {
        const form = new FormData();
        for (const h of bucket) {
          const bytes = files.get(h);
          if (!bytes)
            throw new Error("assets session asked for an unknown file");
          form.append(h, Buffer.from(bytes).toString("base64"));
        }
        // Always the account route, even for a namespace script.
        const r = await call(
          "POST",
          `${route}?base64=true`,
          { body: form, auth: jwt },
          [201, 202],
        );
        const next = (r.body as { result?: { jwt?: string } })?.result?.jwt;
        const last = i === buckets.length - 1;
        if (last && (r.status !== 201 || !next))
          throw new CfError(
            "POST",
            route,
            r.status,
            "no completion token on the last bucket",
          );
        if (next) jwt = next;
      }
      return { jwt };
    },
    async r2ObjectGet(bucket, key, opts) {
      const r = await call(
        "GET",
        r2Path(bucket, key),
        { binary: true, maxBytes: opts?.maxBytes },
        [404],
      );
      if (r.status === 404) return null;
      return { bytes: r.bytes ?? new Uint8Array(), etag: etagOf(r.headers) };
    },
    async r2ObjectDelete(bucket, key) {
      // R-N1: only probeR2Conditionals' throwaway keys; a release object or
      // floor.json is never deleted through this client.
      if (typeof key !== "string" || !PROBE_KEY.test(key))
        throw new Error(
          "r2ObjectDelete only deletes the R2 probe's throwaway keys (probe/<32 hex>)",
        );
      await call("DELETE", r2Path(bucket, key), {}, [404]);
    },
    async r2ObjectHead(bucket, key) {
      const r = await call("HEAD", r2Path(bucket, key), {}, [404]);
      if (r.status === 404) return null;
      const size = Number(r.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0)
        throw new CfError("HEAD", r2Path(bucket, key), r.status, "no size");
      return { size, etag: etagOf(r.headers) };
    },
    async r2ObjectPut(bucket, key, bytes, cond) {
      const headers: Record<string, string> =
        "ifNoneMatch" in cond && cond.ifNoneMatch === "*"
          ? { "if-none-match": "*" }
          : "ifMatch" in cond &&
              typeof cond.ifMatch === "string" &&
              cond.ifMatch !== ""
            ? { "if-match": `"${cond.ifMatch}"` }
            : (() => {
                throw new Error("an R2 put needs If-None-Match: * or If-Match");
              })();
      const path = r2Path(bucket, key);
      const r = await call(
        "PUT",
        path,
        {
          body: bytes as BodyInit,
          headers: { ...headers, "content-type": "application/octet-stream" },
        },
        [412],
      );
      if (r.status !== 412) return;
      // M2: a 412 on a retry may be our own lost write. Accept it only when
      // the object now holds exactly these bytes; a first-try 412 never is.
      if (r.attempt > 0) {
        const cur = await call(
          "GET",
          path,
          { binary: true, maxBytes: bytes.length },
          [404],
        ).catch(() => null);
        if (
          cur?.status === 200 &&
          cur.bytes &&
          Buffer.from(cur.bytes).equals(Buffer.from(bytes))
        )
          return;
      }
      throw new CfError(
        "PUT",
        path.split("?")[0] as string,
        412,
        "precondition failed",
      );
    },
    async r2ObjectList(bucket, prefix, cursor) {
      if (!RELEASES_BUCKET.test(bucket))
        throw new Error(
          `R2 object calls are for an env's releases bucket only, not ${JSON.stringify(bucket).slice(0, 60)}`,
        );
      const q = `prefix=${seg(prefix)}&per_page=1000${cursor ? `&cursor=${seg(cursor)}` : ""}`;
      const { body } = await call(
        "GET",
        `${acct}/r2/buckets/${seg(bucket)}/objects?${q}`,
      );
      const b = body as {
        result?: { key?: unknown; size?: unknown; etag?: unknown }[];
        result_info?: { cursor?: unknown; is_truncated?: unknown };
      };
      const objects = (b?.result ?? []).map((x) => {
        if (
          typeof x?.key !== "string" ||
          !Number.isSafeInteger(x.size) ||
          (x.size as number) < 0
        )
          throw new Error("R2 listing has a malformed entry");
        return {
          key: x.key,
          size: x.size as number,
          etag: String(x.etag ?? ""),
        };
      });
      const info = b?.result_info ?? {};
      const next =
        typeof info.cursor === "string" && info.cursor !== ""
          ? info.cursor
          : undefined;
      const truncated =
        info.is_truncated === true || info.is_truncated === "true";
      if (truncated && !next)
        throw new Error("R2 listing is truncated but has no cursor");
      return { objects, cursor: next, truncated };
    },
    async r2InstallKeys(bucket) {
      const { body } = await call(
        "GET",
        `${acct}/r2/buckets/${seg(installBucket(bucket))}/objects?per_page=1000`,
      );
      return ((body as { result?: { key?: unknown }[] })?.result ?? []).map(
        (x) => {
          if (typeof x?.key !== "string" || x.key === "")
            throw new Error("R2 listing has a malformed entry");
          return x.key;
        },
      );
    },
    async r2InstallDeleteObject(bucket, key) {
      if (typeof key !== "string" || key === "" || key.length > 1024)
        throw new Error("invalid R2 object key");
      await call(
        "DELETE",
        `${acct}/r2/buckets/${seg(installBucket(bucket))}/objects/${seg(key)}`,
        {},
        [404],
      );
    },
    async turnstileWidget(sitekey) {
      const r = await call(
        "GET",
        `${acct}/challenges/widgets/${seg(sitekey)}`,
        {},
        [404],
      );
      if (r.status === 404) return null;
      return ((r.body as { result?: TurnstileWidget })?.result ??
        null) as TurnstileWidget | null;
    },
    async turnstileList() {
      const out: TurnstileWidget[] = [];
      for (let page = 1; page <= 50; page++) {
        const { body } = await call(
          "GET",
          `${acct}/challenges/widgets?per_page=50&page=${page}`,
        );
        const b = body as {
          result?: TurnstileWidget[];
          result_info?: { total_pages?: unknown };
        };
        for (const w of b?.result ?? []) {
          if (typeof w?.sitekey !== "string" || typeof w?.name !== "string")
            throw new Error("Turnstile listing has a malformed entry");
          out.push({
            sitekey: w.sitekey,
            name: w.name,
            domains: Array.isArray(w.domains) ? w.domains.map(String) : [],
            ...(typeof w.mode === "string" ? { mode: w.mode } : {}),
          });
        }
        const pages = Number(b?.result_info?.total_pages ?? 1);
        if (!Number.isFinite(pages) || page >= pages) return out;
      }
      throw new Error("Turnstile listing did not end");
    },
    async turnstileCreate(w) {
      const { body } = await call("POST", `${acct}/challenges/widgets`, {
        json: { name: w.name, domains: w.domains, mode: w.mode },
      });
      const r = (body as { result?: { sitekey?: unknown; secret?: unknown } })
        ?.result;
      if (typeof r?.sitekey !== "string" || typeof r?.secret !== "string")
        throw new Error("Turnstile create returned no sitekey or secret");
      return { sitekey: r.sitekey, secret: r.secret };
    },
  };
}
