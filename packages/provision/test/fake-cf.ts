// An in-memory Cloudflare for the provisioner tests: the REST routes cf.ts
// calls, plus a dispatch emulation (Host -> HOSTS KV -> user Worker) that
// answers /healthz and a minimal /mcp, and R2's S3 endpoint for the releases
// bucket (SigV4 checked, conditionals enforced). Nothing here talks to the
// network.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AwsV4Signer } from "aws4fetch";

const API = "https://api.cloudflare.com/client/v4";
/** provision's poll of one install's revoke state (PlatformDb.revokeState). */
const REVOKE_POLL_SQL_PREFIX =
  "SELECT directory_revoke, directory_revoke_attempts, directory_revoked_at, directory_revoke_requested_at FROM installs WHERE id";

export interface LogEntry {
  method: string;
  path: string;
  status: number;
}

export interface FakeScript {
  ns: string | null;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: upload metadata is arbitrary JSON
  metadata: any;
  modules: Map<string, { type: string; bytes: Uint8Array }>;
  secrets: Map<string, string>;
  migrationTag: string | null;
  hasAssets: boolean;
  subdomain?: { enabled: boolean; previews_enabled: boolean };
  uploads: number;
}

type Fault = {
  when: (method: string, path: string) => boolean;
  status: number;
  message: string;
  times: number;
  skip: number;
};

/** Split SQL into statements; quotes, comments and trigger bodies stay whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === ";") {
      const trigger = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER/i.test(cur);
      if (trigger && !/\bEND\s*$/i.test(cur)) cur += c;
      else {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
      }
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const formEntries = (f: FormData) => {
  const out: [string, FormDataEntryValue][] = [];
  f.forEach((v, k) => {
    out.push([k, v]);
  });
  return out;
};

const env = (result: unknown, status = 200) =>
  new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result }),
    { status, headers: { "content-type": "application/json" } },
  );
const fail = (status: number, message: string, code = 10000) =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
      messages: [],
      result: null,
    }),
    { status, headers: { "content-type": "application/json" } },
  );

export class FakeCf {
  readonly accountId = "0123456789abcdef0123456789abcdef";
  readonly token: string;
  readonly log: LogEntry[] = [];
  /** Request bodies; NOT printable (secrets are sent to Cloudflare here). */
  readonly raw: { method: string; path: string; body: string }[] = [];
  readonly d1 = new Map<string, { name: string; db: DatabaseSync }>();
  readonly r2 = new Set<string>();
  /** R2 objects by bucket, then key (the releases bucket; T3b). */
  readonly r2Objects = new Map<
    string,
    Map<string, { bytes: Uint8Array; etag: string }>
  >();
  /** Every R2 object call, with its conditional headers and API (REST or S3). */
  readonly r2Log: {
    api: "rest" | "s3";
    method: string;
    bucket: string;
    key: string;
    ifNoneMatch?: string;
    ifMatch?: string;
    status: number;
  }[] = [];
  /** R2 list page size cap. */
  r2PerPage?: number;
  /** Rewrites the bytes a GET serves (the listing keeps the stored size). */
  r2Serve?: (key: string, bytes: Uint8Array) => Uint8Array;
  /** An R2 that ignores If-None-Match / If-Match (M2: the probe must catch it). */
  r2IgnoreConditionals = false;
  /** R2 API tokens (S3 credentials) by Access Key ID: the secret and the buckets it may touch. */
  readonly r2Tokens = new Map<string, { secret: string; buckets: string[] }>();
  /** Every S3 request's Authorization header was a valid SigV4 for its token (else 403). */
  s3SignatureChecks = 0;
  /** The first PUT of each key stores the object, then answers 500 (a lost reply). */
  r2PutLandsThen500 = false;
  private r2Landed = new Set<string>();
  /** Runs after a PUT stored its object (e.g. another writer racing in). */
  r2OnPut?: (key: string) => void;
  readonly kv = new Map<
    string,
    { title: string; values: Map<string, string> }
  >();
  readonly scripts = new Map<string, FakeScript>();
  readonly namespaces = new Set(["oa-staging", "oa-prod"]);
  readonly assetHashes = new Set<string>();
  /** Turnstile widgets by sitekey (read-only for create). */
  readonly turnstile = new Map<
    string,
    {
      sitekey: string;
      name: string;
      domains: string[];
      mode: string;
      secret?: string;
    }
  >();
  /**
   * The scheduler's 2-minute revoke cron, emulated: runs on a D1 right before
   * provision polls an install's revoke state. Default: a pending revoke on
   * a deleting row is done at once. null: never (a stuck scheduler).
   */
  revoker: ((db: DatabaseSync, id: string) => void) | null = (db, id) => {
    db.prepare(
      "UPDATE installs SET directory_revoke = 'done', directory_revoked_at = directory_revoke_requested_at WHERE id = ? AND state = 'deleting' AND directory_revoke = 'pending'",
    ).run(id);
  };
  /** The next N widget creates store the widget, then answer 500 (a lost reply). */
  turnstileCreateLandsThen500 = 0;
  /** Edits a widget as it is created (e.g. Cloudflare normalizing it). */
  onTurnstileCreate?: (w: { domains: string[]; mode: string }) => void;
  /** D1 list knobs: clamp per_page, or omit result_info. */
  d1PerPageCap?: number;
  d1ResultInfo = true;
  private sessions = new Map<
    string,
    {
      buckets: string[][];
      done: number;
      completion: string;
      /** Manifest path per hash, as Cloudflare knows it from the session. */
      paths: Map<string, string>;
    }
  >();
  /** The Content-Type each uploaded asset will be served with, by path. */
  readonly assetTypes = new Map<string, string>();
  private bucketJwts = new Map<string, string>();
  private completions = new Set<string>();
  readonly artifacts = new Map<string, { title: string; content: string }>();
  private faults: Fault[] = [];
  tokenInfo: Record<string, unknown>;
  scriptsReadStatus = 200;
  /** Dispatch emulation: which KV is HOSTS and which namespace scripts live in. */
  dispatch?: { hostsKvId: string; ns: string | null };
  /** Accept any old_tag (a Cloudflare that does not check the DO tag; R-L3). */
  ignoreMigrationTag = false;
  /** /healthz override for a script (e.g. to simulate a slow start). */
  health?: (s: FakeScript) => unknown;

  constructor(o: { token?: string; now?: number } = {}) {
    this.token = o.token ?? `cf-token-${randomBytes(12).toString("hex")}`;
    const now = o.now ?? Date.now();
    this.tokenInfo = {
      id: "tok",
      status: "active",
      not_before: new Date(now - 86_400_000).toISOString(),
      expires_on: new Date(now + 20 * 86_400_000).toISOString(),
    };
  }

  /** Fail the next `times` calls matching `when` (after skipping `skip`). */
  inject(
    when: (method: string, path: string) => boolean,
    o: {
      status?: number;
      message?: string;
      times?: number;
      skip?: number;
    } = {},
  ) {
    this.faults.push({
      when,
      status: o.status ?? 400,
      message: o.message ?? "injected failure",
      times: o.times ?? 1,
      skip: o.skip ?? 0,
    });
  }

  /** Seed a D1 (e.g. the platform DB) with SQL; returns its uuid. */
  seedD1(name: string, sql = ""): string {
    const id = randomUUID();
    const db = new DatabaseSync(":memory:");
    for (const s of splitSql(sql)) db.exec(s);
    this.d1.set(id, { name, db });
    return id;
  }
  seedKv(title: string): string {
    const id = randomBytes(16).toString("hex");
    this.kv.set(id, { title, values: new Map() });
    return id;
  }
  /** Put an R2 object directly (no call logged); a fresh etag each time. */
  r2Seed(bucket: string, key: string, bytes: Uint8Array): void {
    let b = this.r2Objects.get(bucket);
    if (!b) {
      b = new Map();
      this.r2Objects.set(bucket, b);
    }
    b.set(key, { bytes: bytes.slice(), etag: randomBytes(16).toString("hex") });
  }
  /** Mint an R2 API token (Object Read & Write) scoped to `buckets`. */
  r2Token(...buckets: string[]): {
    accessKeyId: string;
    secretAccessKey: string;
  } {
    const accessKeyId = randomBytes(16).toString("hex");
    const secretAccessKey = randomBytes(32).toString("hex");
    this.r2Tokens.set(accessKeyId, { secret: secretAccessKey, buckets });
    return { accessKeyId, secretAccessKey };
  }
  r2Object(bucket: string, key: string) {
    return this.r2Objects.get(bucket)?.get(key);
  }
  kvValues(id: string): Map<string, string> {
    const ns = this.kv.get(id);
    if (!ns) throw new Error(`no kv ${id}`);
    return ns.values;
  }
  script(ns: string | null, name: string): FakeScript | undefined {
    return this.scripts.get(`${ns ?? ""}/${name}`);
  }
  /** Calls that change state (non-GET, and D1 queries that are not SELECT), in order. */
  writes(): string[] {
    return this.log
      .map((e, i) => ({ e, body: this.raw[i]?.body }))
      .filter(
        ({ e, body }) =>
          e.method !== "GET" &&
          e.method !== "HEAD" &&
          !/^[^/]+\.[a-z]+\//.test(e.path) &&
          (!e.path.includes("/query") || this.isWriteQuery(body)),
      )
      .map(({ e }) => `${e.method} ${e.path}`);
  }
  private isWriteQuery(body?: string): boolean {
    if (!body) return false;
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j.batch)) return true;
      const sql = String(j.sql ?? "");
      return !/^\s*SELECT\b/i.test(sql);
    } catch {
      return true;
    }
  }

  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.clone().text();
    const path =
      url.origin === new URL(API).origin
        ? url.pathname.replace(/^\/client\/v4/, "") + url.search
        : `${url.host}${url.pathname}`;
    const res = await this.route(req, url, body).catch((e: Error) =>
      fail(500, `fake error: ${e.message}`),
    );
    this.log.push({ method: req.method, path, status: res.status });
    this.raw.push({ method: req.method, path, body });
    return res;
  };

  private async route(req: Request, url: URL, body: string): Promise<Response> {
    if (url.host === `${this.accountId}.r2.cloudflarestorage.com`)
      return this.s3(req, url);
    if (url.origin !== new URL(API).origin) return this.serve(req, url, body);
    const p = url.pathname.replace(/^\/client\/v4/, "");
    for (const f of this.faults) {
      if (f.times > 0 && f.when(req.method, p)) {
        if (f.skip > 0) {
          f.skip--;
          continue;
        }
        f.times--;
        return fail(f.status, f.message);
      }
    }
    const a = `/accounts/${this.accountId}`;
    if (p === `/accounts/${this.accountId}/workers/assets/upload`)
      return this.assetsUpload(req, url);
    if (req.headers.get("authorization") !== `Bearer ${this.token}`)
      return fail(401, "Authentication error", 10000);
    if (p === "/user/tokens/verify") return env(this.tokenInfo);
    if (!p.startsWith(`${a}/`)) return fail(403, "wrong account");
    const r = p.slice(a.length);
    const json = () => (body ? JSON.parse(body) : {});
    let m: RegExpMatchArray | null;

    if (r === "/workers/scripts" && req.method === "GET")
      return this.scriptsReadStatus === 200
        ? env(
            [...this.scripts.values()]
              .filter((s) => s.ns === null)
              .slice(0, 1)
              .map((s) => ({ id: s.name })),
          )
        : fail(this.scriptsReadStatus, "Authentication error");
    m = r.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (m)
      return this.scriptRoute(
        req,
        null,
        decodeURIComponent(m[1] as string),
        m[2] ?? "",
        body,
      );
    m = r.match(
      /^\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)(\/.*)?$/,
    );
    if (m) {
      const ns = decodeURIComponent(m[1] as string);
      if (!this.namespaces.has(ns)) return fail(404, "namespace not found");
      return this.scriptRoute(
        req,
        ns,
        decodeURIComponent(m[2] as string),
        m[3] ?? "",
        body,
      );
    }

    // D1
    if (r === "/d1/database" && req.method === "POST") {
      const { name } = json();
      if ([...this.d1.values()].some((d) => d.name === name))
        return fail(400, "A database with that name already exists", 7502);
      return env({ uuid: this.seedD1(name), name });
    }
    if (r === "/d1/database" && req.method === "GET") {
      // Cloudflare's name filter is a substring match; pages of per_page.
      const name = url.searchParams.get("name");
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Math.min(
        Number(url.searchParams.get("per_page") ?? 1000),
        this.d1PerPageCap ?? Number.POSITIVE_INFINITY,
      );
      const all = [...this.d1.entries()]
        .filter(([, d]) => name === null || d.name.includes(name))
        .map(([uuid, d]) => ({ uuid, name: d.name }));
      const slice = all.slice((page - 1) * per, page * per);
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: slice,
          ...(this.d1ResultInfo
            ? {
                result_info: {
                  page,
                  per_page: per,
                  count: slice.length,
                  total_count: all.length,
                  total_pages: Math.max(1, Math.ceil(all.length / per)),
                },
              }
            : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Turnstile widgets (create reads; turnstile-init lists and creates)
    if (r === "/challenges/widgets" && req.method === "GET") {
      const q = url.searchParams;
      const per = Number(q.get("per_page") ?? 25);
      const page = Number(q.get("page") ?? 1);
      const all = [...this.turnstile.values()].map(({ secret: _s, ...w }) => w);
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: all.slice((page - 1) * per, page * per),
          result_info: {
            page,
            per_page: per,
            total_pages: Math.max(1, Math.ceil(all.length / per)),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (r === "/challenges/widgets" && req.method === "POST") {
      const { name, domains, mode } = json();
      const sitekey = `0x4AAAAAAA${randomBytes(8).toString("hex")}`;
      const secret = `0x4AAAAAAA-secret-${randomBytes(16).toString("hex")}`;
      const w = { sitekey, name, domains, mode, secret };
      this.onTurnstileCreate?.(w);
      this.turnstile.set(sitekey, w);
      if (this.turnstileCreateLandsThen500 > 0) {
        this.turnstileCreateLandsThen500--;
        return fail(500, "internal error");
      }
      return env({ sitekey, secret, name, domains, mode });
    }
    m = r.match(/^\/challenges\/widgets\/([^/]+)$/);
    if (m && req.method === "GET") {
      const w = this.turnstile.get(decodeURIComponent(m[1] as string));
      if (!w) return fail(404, "widget not found", 10404);
      return env({ ...w, created_on: "2026-10-01T00:00:00Z" });
    }
    m = r.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (m) {
      const d = this.d1.get(m[1] as string);
      if (!d) return fail(404, "database not found", 7404);
      const { sql, params, batch } = json();
      try {
        if (Array.isArray(batch)) {
          // REST batch: one transaction, all or nothing.
          d.db.exec("BEGIN");
          try {
            const out = batch.flatMap(
              (q: { sql: string; params?: unknown[] }) =>
                this.exec(d.db, q.sql, q.params ?? []),
            );
            d.db.exec("COMMIT");
            return env(out);
          } catch (e) {
            d.db.exec("ROLLBACK");
            throw e;
          }
        }
        if (
          typeof sql === "string" &&
          sql.startsWith(REVOKE_POLL_SQL_PREFIX) &&
          this.revoker
        )
          this.revoker(d.db, String((params ?? [])[0]));
        return env(this.exec(d.db, sql, params ?? []));
      } catch (e) {
        return fail(400, `${(e as Error).message}: SQLITE_ERROR`, 7500);
      }
    }
    m = r.match(/^\/d1\/database\/([^/]+)$/);
    if (m) {
      const id = m[1] as string;
      if (!this.d1.has(id)) return fail(404, "database not found", 7404);
      if (req.method === "DELETE") {
        this.d1.delete(id);
        return env(null);
      }
      return env({ uuid: id, name: this.d1.get(id)?.name });
    }

    // R2 objects (account-scoped REST routes)
    m = r.match(/^\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/);
    if (m) {
      const bucket = decodeURIComponent(m[1] as string);
      if (!this.r2.has(bucket))
        return fail(404, "The specified bucket does not exist.", 10006);
      const objs =
        this.r2Objects.get(bucket) ??
        this.r2Objects.set(bucket, new Map()).get(bucket);
      if (!objs) throw new Error("unreachable");
      if (m[2] === undefined) {
        if (req.method !== "GET") return fail(405, "Method Not Allowed");
        const prefix = url.searchParams.get("prefix") ?? "";
        const per = Math.min(
          Number(url.searchParams.get("per_page") ?? 1000),
          this.r2PerPage ?? 1000,
        );
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const all = [...objs.keys()].filter((k) => k.startsWith(prefix)).sort();
        const page = all.slice(start, start + per);
        const truncated = start + per < all.length;
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: page.map((k) => ({
              key: k,
              size: objs.get(k)?.bytes.length,
              etag: objs.get(k)?.etag,
            })),
            result_info: {
              is_truncated: truncated,
              cursor: truncated ? String(start + per) : "",
              per_page: per,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const key = decodeURIComponent(m[2]);
      const cur = objs.get(key);
      const ifNoneMatch = req.headers.get("if-none-match") ?? undefined;
      const ifMatch = req.headers.get("if-match") ?? undefined;
      const log = (status: number) => {
        this.r2Log.push({
          api: "rest",
          method: req.method,
          bucket,
          key,
          ifNoneMatch,
          ifMatch,
          status,
        });
      };
      if (req.method === "PUT") {
        if (
          !this.r2IgnoreConditionals &&
          ((ifNoneMatch === "*" && cur) ||
            (ifMatch !== undefined &&
              cur?.etag !== ifMatch.replace(/^"(.*)"$/, "$1")))
        ) {
          log(412);
          return fail(412, "PreconditionFailed", 10031);
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const etag = randomBytes(16).toString("hex");
        objs.set(key, { bytes, etag });
        this.r2OnPut?.(key);
        if (this.r2PutLandsThen500 && !this.r2Landed.has(`${bucket}/${key}`)) {
          this.r2Landed.add(`${bucket}/${key}`);
          log(500);
          return fail(500, "internal error (the write landed)");
        }
        log(200);
        return env({ key, size: bytes.length, etag });
      }
      if (req.method === "DELETE") {
        objs.delete(key);
        log(200);
        return env(null);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (!cur) {
          log(404);
          return fail(404, "The specified key does not exist.", 10007);
        }
        log(200);
        const bytes = this.r2Serve?.(key, cur.bytes) ?? cur.bytes;
        return new Response(
          req.method === "HEAD" ? null : (bytes as BodyInit),
          {
            status: 200,
            headers: {
              etag: `"${cur.etag}"`,
              "content-length": String(cur.bytes.length),
            },
          },
        );
      }
      return fail(405, "Method Not Allowed");
    }

    // R2
    if (r === "/r2/buckets" && req.method === "POST") {
      const { name } = json();
      if (this.r2.has(name))
        return fail(
          409,
          "The bucket you tried to create already exists",
          10004,
        );
      this.r2.add(name);
      return env({ name });
    }
    m = r.match(/^\/r2\/buckets\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1] as string);
      if (!this.r2.has(name))
        return fail(404, "The specified bucket does not exist.", 10006);
      if (req.method === "DELETE") {
        // Cloudflare refuses to delete a bucket that still holds objects.
        if ((this.r2Objects.get(name)?.size ?? 0) > 0)
          return fail(
            409,
            "The bucket you tried to delete is not empty.",
            10008,
          );
        this.r2.delete(name);
        this.r2Objects.delete(name);
      }
      return env({ name });
    }

    // KV
    if (r === "/storage/kv/namespaces" && req.method === "POST") {
      const { title } = json();
      if ([...this.kv.values()].some((n) => n.title === title))
        return fail(
          400,
          "a namespace with this account ID and title already exists",
          10014,
        );
      const id = this.seedKv(title);
      return env({ id, title });
    }
    if (r === "/storage/kv/namespaces" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per_page") ?? 20);
      const all = [...this.kv.entries()].map(([id, n]) => ({
        id,
        title: n.title,
      }));
      return env(all.slice((page - 1) * per, page * per));
    }
    m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/);
    if (m) {
      const ns = this.kv.get(m[1] as string);
      if (!ns) return fail(404, "namespace not found", 10013);
      const key = decodeURIComponent(m[2] as string);
      if (req.method === "PUT") {
        ns.values.set(key, body);
        return env(null);
      }
      if (req.method === "DELETE") {
        ns.values.delete(key);
        return env(null);
      }
      const v = ns.values.get(key);
      return v === undefined
        ? fail(404, "key not found", 10009)
        : new Response(v, { status: 200 });
    }
    m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)$/);
    if (m && req.method === "GET") {
      const ns = this.kv.get(m[1] as string);
      if (!ns) return fail(404, "namespace not found", 10013);
      return env({ id: m[1], title: ns.title });
    }
    if (m && req.method === "DELETE") {
      if (!this.kv.delete(m[1] as string))
        return fail(404, "namespace not found", 10013);
      return env(null);
    }
    return fail(404, `fake: no route ${req.method} ${r}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: D1 params are arbitrary JSON
  private exec(db: DatabaseSync, sql: string, params: any[]) {
    const stmts = splitSql(sql);
    return stmts.map((s) => {
      const st = db.prepare(s);
      const total = () =>
        Number(
          (db.prepare("SELECT total_changes() AS c").get() as { c: number }).c,
        );
      const before = total();
      const rows = st.all(...(stmts.length === 1 ? params : []));
      // Real D1 counts rows a trigger writes too (measured on staging: a
      // one-row UPDATE of installs reports 2, from installs_row_version), so
      // the fake reports total_changes(), not SQLite's changes().
      const changes = total() - before;
      return {
        results: rows,
        success: true,
        meta: { changes: /^\s*SELECT/i.test(s) ? 0 : changes },
      };
    });
  }

  private async scriptRoute(
    req: Request,
    ns: string | null,
    name: string,
    sub: string,
    body: string,
  ): Promise<Response> {
    const key = `${ns ?? ""}/${name}`;
    const s = this.scripts.get(key);
    if (sub === "" && req.method === "PUT") return this.upload(req, ns, name);
    if (sub === "" && req.method === "DELETE") {
      if (!s)
        return fail(404, "This Worker does not exist on your account.", 10007);
      this.scripts.delete(key);
      return env(null);
    }
    if (sub === "/assets-upload-session" && req.method === "POST") {
      const { manifest } = JSON.parse(body) as {
        manifest: Record<string, { hash: string; size: number }>;
      };
      for (const v of Object.values(manifest))
        if (!/^[0-9a-f]{32}$/.test(v.hash))
          return fail(
            400,
            `file hash size of ${v.hash.length} is too large`,
            10201,
          );
      const missing = [
        ...new Set(Object.values(manifest).map((v) => v.hash)),
      ].filter((h) => !this.assetHashes.has(h));
      const completion = `jwt-done-${randomBytes(8).toString("hex")}`;
      const jwt = `jwt-sess-${randomBytes(8).toString("hex")}`;
      if (missing.length === 0) {
        this.completions.add(jwt);
        return env({ jwt, buckets: [] });
      }
      const buckets = missing.map((h) => [h]);
      const paths = new Map(
        Object.entries(manifest).map(([p, v]) => [v.hash, p] as const),
      );
      this.sessions.set(jwt, { buckets, done: 0, completion, paths });
      return env({ jwt, buckets });
    }
    if (!s)
      return fail(404, "This Worker does not exist on your account.", 10007);
    if (sub === "/settings" && req.method === "GET")
      return env({ bindings: [], migration_tag: null });
    if (sub === "/secrets" && req.method === "GET")
      return env(
        [...s.secrets.keys()].map((n) => ({ name: n, type: "secret_text" })),
      );
    if (sub === "/secrets" && req.method === "PUT") {
      const { name: n, text, type } = JSON.parse(body);
      if (type !== "secret_text") return fail(400, "bad secret type");
      s.secrets.set(n, text);
      return env({ name: n, type });
    }
    if (sub === "/subdomain" && req.method === "POST") {
      if (ns !== null) return fail(405, "Method Not Allowed", 10405);
      s.subdomain = JSON.parse(body);
      return env(s.subdomain);
    }
    return fail(404, `fake: no script route ${req.method} ${sub}`);
  }

  private async upload(
    req: Request,
    ns: string | null,
    name: string,
  ): Promise<Response> {
    const form = await req.formData();
    const metaPart = form.get("metadata");
    if (typeof metaPart !== "string" && !(metaPart instanceof Blob))
      return fail(400, "missing metadata");
    const meta = JSON.parse(
      typeof metaPart === "string" ? metaPart : await metaPart.text(),
    );
    const key = `${ns ?? ""}/${name}`;
    const prev = this.scripts.get(key);
    const modules = new Map<string, { type: string; bytes: Uint8Array }>();
    for (const [k, v] of formEntries(form)) {
      if (k === "metadata") continue;
      if (!(v instanceof Blob)) return fail(400, `module ${k} is not a file`);
      modules.set(k, {
        type: v.type,
        bytes: new Uint8Array(await v.arrayBuffer()),
      });
    }
    if (!modules.has(meta.main_module)) return fail(400, "main module missing");
    // Durable Object migrations (spike-verified behaviour).
    let tag = prev?.migrationTag ?? null;
    if (meta.migrations) {
      const sent = meta.migrations.old_tag ?? "";
      if (sent !== (tag ?? "") && !this.ignoreMigrationTag)
        return fail(
          412,
          `Actor migration tag precondition failed, got tag '${sent}' when expected tag is '${tag ?? ""}'`,
          10079,
        );
      tag = meta.migrations.new_tag;
    }
    let hasAssets = prev?.hasAssets ?? false;
    if (meta.assets?.jwt !== undefined) {
      if (!this.completions.has(meta.assets.jwt))
        return fail(400, "invalid assets jwt");
      this.completions.delete(meta.assets.jwt);
      hasAssets = true;
    } else if (meta.keep_assets !== true || !prev?.hasAssets)
      return fail(400, "assets missing");
    const keep: string[] = meta.keep_bindings ?? [];
    const secrets =
      keep.includes("secret_text") && prev
        ? new Map(prev.secrets)
        : new Map<string, string>();
    for (const b of meta.bindings ?? [])
      if (b.type === "secret_text") secrets.set(b.name, b.text);
    this.scripts.set(key, {
      ns,
      name,
      metadata: meta,
      modules,
      secrets,
      migrationTag: tag,
      hasAssets,
      subdomain: prev?.subdomain,
      uploads: (prev?.uploads ?? 0) + 1,
    });
    return env({ id: name });
  }

  private async assetsUpload(req: Request, url: URL): Promise<Response> {
    if (url.searchParams.get("base64") !== "true")
      return fail(400, "base64=true required");
    const auth =
      req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const sessJwt = this.sessions.has(auth) ? auth : this.bucketJwts.get(auth);
    const s = sessJwt ? this.sessions.get(sessJwt) : undefined;
    if (!s || !sessJwt) return fail(401, "invalid assets session");
    const form = await req.formData();
    for (const [hash, v] of formEntries(form)) {
      // Cloudflare serves each asset with its part's Content-Type, so an
      // untyped part (a plain string field) would be served with none.
      if (typeof v === "string" || !v.type)
        return fail(400, "each part needs its Content-Type");
      const b64 = await v.text();
      const path = s.paths.get(hash);
      if (!path) return fail(400, "part not in the session manifest");
      const ext = path.includes(".") ? (path.split(".").pop() as string) : "";
      const h = createHash("sha256")
        .update(b64 + ext)
        .digest("hex")
        .slice(0, 32);
      if (h !== hash) return fail(400, "hash mismatch");
      this.assetHashes.add(hash);
      this.assetTypes.set(path, v.type);
    }
    s.done++;
    if (s.done < s.buckets.length) {
      const next = `jwt-b-${randomBytes(6).toString("hex")}`;
      this.bucketJwts.set(next, sessJwt);
      return env({ jwt: next }, 202);
    }
    this.completions.add(s.completion);
    return env({ jwt: s.completion }, 201);
  }

  // ----- dispatch emulation (Task 6's job in production) -----

  private findScript(host: string): FakeScript | undefined {
    if (!this.dispatch) return undefined;
    const id = this.kv.get(this.dispatch.hostsKvId)?.values.get(host);
    if (!id) return undefined;
    return [...this.scripts.values()].find(
      (s) => s.ns === this.dispatch?.ns && s.name.endsWith(id),
    );
  }

  private plain(s: FakeScript, name: string): string | undefined {
    return s.metadata.bindings.find(
      (b: { type: string; name: string }) =>
        b.type === "plain_text" && b.name === name,
    )?.text;
  }

  /** R2's S3 API on <account>.r2.cloudflarestorage.com: SigV4 (region auto) and conditional PutObject. */
  private async s3(req: Request, url: URL): Promise<Response> {
    const xml = (status: number, code: string, headers: HeadersInit = {}) =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
        { status, headers: { "content-type": "application/xml", ...headers } },
      );
    const m = url.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (!m) return xml(400, "InvalidRequest");
    const bucket = decodeURIComponent(m[1] as string);
    const key = m[2]
      ?.split("/")
      .map((x) => decodeURIComponent(x))
      .join("/") as string;
    for (const f of this.faults) {
      if (f.times > 0 && f.when(req.method, `/r2s3/${bucket}/${key}`)) {
        if (f.skip > 0) {
          f.skip--;
          continue;
        }
        f.times--;
        return xml(f.status, "InjectedFailure");
      }
    }
    // SigV4: recompute the signature with the token's secret and compare.
    const auth = req.headers.get("authorization") ?? "";
    const cred =
      /Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request/.exec(auth);
    const tok = cred ? this.r2Tokens.get(cred[1] as string) : undefined;
    if (!cred || !tok || cred[3] !== "auto" || cred[4] !== "s3")
      return xml(403, "InvalidAccessKeyId");
    const bytes = new Uint8Array(await req.clone().arrayBuffer());
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    const want = await new AwsV4Signer({
      method: req.method,
      url: req.url,
      headers,
      accessKeyId: cred[1] as string,
      secretAccessKey: tok.secret,
      service: "s3",
      region: "auto",
      datetime: req.headers.get("x-amz-date") ?? "",
    }).authHeader();
    if (want !== auth) return xml(403, "SignatureDoesNotMatch");
    if (
      req.headers.get("x-amz-content-sha256") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      return xml(400, "XAmzContentSHA256Mismatch");
    this.s3SignatureChecks++;
    if (!tok.buckets.includes(bucket)) return xml(403, "AccessDenied");
    if (!this.r2.has(bucket)) return xml(404, "NoSuchBucket");
    const objs =
      this.r2Objects.get(bucket) ??
      this.r2Objects.set(bucket, new Map()).get(bucket);
    if (!objs) throw new Error("unreachable");
    const cur = objs.get(key);
    const ifNoneMatch = req.headers.get("if-none-match") ?? undefined;
    const ifMatch = req.headers.get("if-match") ?? undefined;
    const log = (status: number) => {
      this.r2Log.push({
        api: "s3",
        method: req.method,
        bucket,
        key,
        ifNoneMatch,
        ifMatch,
        status,
      });
    };
    if (req.method === "PUT") {
      if (
        !this.r2IgnoreConditionals &&
        ((ifNoneMatch === "*" && cur) ||
          (ifMatch !== undefined &&
            cur?.etag !== ifMatch.replace(/^"(.*)"$/, "$1")))
      ) {
        log(412);
        return xml(412, "PreconditionFailed");
      }
      const etag = randomBytes(16).toString("hex");
      objs.set(key, { bytes, etag });
      this.r2OnPut?.(key);
      if (this.r2PutLandsThen500 && !this.r2Landed.has(`${bucket}/${key}`)) {
        this.r2Landed.add(`${bucket}/${key}`);
        log(500);
        return xml(500, "InternalError");
      }
      log(200);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${etag}"` },
      });
    }
    if (req.method === "DELETE") {
      objs.delete(key);
      log(204);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (!cur) {
        log(404);
        return req.method === "HEAD"
          ? new Response(null, { status: 404 })
          : xml(404, "NoSuchKey");
      }
      log(200);
      const out = this.r2Serve?.(key, cur.bytes) ?? cur.bytes;
      return new Response(req.method === "HEAD" ? null : (out as BodyInit), {
        status: 200,
        headers: {
          etag: `"${cur.etag}"`,
          "content-length": String(cur.bytes.length),
        },
      });
    }
    return xml(405, "MethodNotAllowed");
  }

  private async serve(req: Request, url: URL, body: string): Promise<Response> {
    const s = this.findScript(url.hostname);
    if (!s) return new Response("Not found", { status: 404 });
    if (url.pathname === "/healthz") {
      const custom = this.health?.(s);
      if (custom instanceof Response) return custom;
      const version = (s.metadata.tags as string[])
        .find((t) => /^v\d/.test(t))
        ?.slice(1);
      return Response.json(
        custom ?? { ok: true, plan: this.plain(s, "PLAN"), version },
      );
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const auth =
        req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const dbId = s.metadata.bindings.find(
        (b: { type: string }) => b.type === "d1",
      )?.id;
      const db = this.d1.get(dbId)?.db;
      const hash = createHash("sha256").update(auth).digest("hex");
      const ok =
        db
          ?.prepare(
            "SELECT 1 FROM tokens WHERE token_hash = ? AND revoked_at IS NULL",
          )
          .get(hash) !== undefined;
      if (!ok) return new Response("unauthorized", { status: 401 });
      const msg = JSON.parse(body);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize")
        return reply({ protocolVersion: "2025-06-18", capabilities: {} });
      if (msg.method === "tools/list")
        return reply({
          tools: [
            { name: "publish_artifact" },
            { name: "get_artifact" },
            { name: "list_artifacts" },
          ],
        });
      if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params;
        if (name === "publish_artifact") {
          const id = `art${this.artifacts.size + 1}`;
          this.artifacts.set(id, { title: args.title, content: args.content });
          return reply({
            content: [{ type: "text", text: id }],
            structuredContent: { id, visibility: "private" },
          });
        }
        if (name === "list_artifacts")
          return reply({
            content: [{ type: "text", text: String(this.artifacts.size) }],
            structuredContent: {
              items: [...this.artifacts.keys()].map((id) => ({ id })),
            },
          });
        if (name === "get_artifact") {
          const a = this.artifacts.get(args.id);
          if (!a)
            return reply({
              isError: true,
              content: [{ type: "text", text: "not_found" }],
            });
          return reply({
            content: [{ type: "text", text: a.content }],
            structuredContent: {
              id: args.id,
              title: a.title,
              visibility: "private",
              content: a.content,
            },
          });
        }
      }
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "no method" },
      });
    }
    return new Response("Not found", { status: 404 });
  }
}
