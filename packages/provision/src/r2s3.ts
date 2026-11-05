// The env's releases bucket (oa-<p>-releases) over R2's S3 API (H-S3).
// Cloudflare documents atomic conditional PutObject (If-None-Match, If-Match)
// only on the S3 endpoint; the api.cloudflare.com object routes ignore
// If-None-Match: *. So every publish write goes here, signed with SigV4
// (aws4fetch, region auto). The credentials are an R2 API token's Access Key
// ID and Secret Access Key, injected by the caller and never read here.
// Errors carry method, bucket, key, status and the S3 error code only: never
// a header, a body or a credential.
import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import { CfError, type R2PutCondition, readCapped } from "./cf.js";
import { assertOwnResource, type Env, platformNames } from "./names.js";

const TRIES = 3;

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The R2 S3 endpoint of an account: https://<accountId>.r2.cloudflarestorage.com. */
export const r2S3Origin = (accountId: string) =>
  `https://${accountId}.r2.cloudflarestorage.com`;

/** The keys the S3 client touches: release objects, the floor, and probe keys. */
const PROBE_KEY = /^probe\/[0-9a-f]{32}$/;
const releaseKey = (key: string) =>
  key.length <= 1024 &&
  key.startsWith("releases/") &&
  key
    .split("/")
    .every((s) => /^[A-Za-z0-9._~@+-]+$/.test(s) && s !== "." && s !== "..");

export interface R2Releases {
  readonly env: Env;
  /** Always platformNames(env).releases. */
  readonly bucket: string;
  /** null when the object does not exist. */
  get(
    key: string,
    opts?: { maxBytes?: number },
  ): Promise<{ bytes: Uint8Array; etag: string } | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  /**
   * A conditional PutObject. A failed condition is a CfError with status 412,
   * on any try: a 412 is never taken as success here (the caller decides).
   */
  put(
    key: string,
    bytes: Uint8Array,
    cond: R2PutCondition,
  ): Promise<{ etag: string }>;
  /** Deletes a probe/<32 hex> key only (probeR2Conditionals); any other key is refused. */
  deleteProbe(key: string): Promise<void>;
}

const sha256Hex = (b: Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
const etagOf = (h: Headers) =>
  (h.get("etag") ?? "").replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
/** The S3 error code (<Code>...</Code>), letters only; the rest of the body is never kept. */
const s3Code = (text: string) =>
  /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text)?.[1] ?? "";

export function r2S3Client(o: {
  accountId: string;
  env: Env;
  credentials: R2Credentials;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): R2Releases {
  if (!/^[0-9a-f]{32}$/.test(o.accountId))
    throw new Error("accountId must be 32 hex characters");
  if (o.env !== "staging" && o.env !== "prod")
    throw new Error("env must be staging or prod");
  const { accessKeyId, secretAccessKey } = o.credentials ?? {};
  for (const v of [accessKeyId, secretAccessKey])
    if (typeof v !== "string" || v === "" || /\s/.test(v))
      throw new Error("the R2 credentials are empty or malformed");
  const env = o.env;
  const bucket = platformNames(env).releases;
  assertOwnResource(bucket, env);
  const origin = r2S3Origin(o.accountId);
  const f = o.fetch ?? fetch;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const pathOf = (key: string) => {
    if (typeof key !== "string" || !(releaseKey(key) || PROBE_KEY.test(key)))
      throw new Error(
        "R2 S3 calls are for release keys (releases/...) and probe keys only",
      );
    return `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  };

  /** One signed call, 3 tries on 429/5xx/network. Statuses in `ok` are returned. */
  async function call(
    method: string,
    key: string,
    init: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      maxBytes?: number;
    },
    ok: number[],
  ): Promise<{ status: number; headers: Headers; bytes?: Uint8Array }> {
    const path = pathOf(key);
    const route = `r2s3:${path}`;
    let last: CfError | undefined;
    for (let i = 0; i < TRIES; i++) {
      if (i > 0) await sleep(500 * 2 ** (i - 1));
      let res: Response;
      try {
        // Signed fresh each try (x-amz-date); the payload hash is signed too.
        const signed = await new AwsV4Signer({
          method,
          url: `${origin}${path}`,
          headers: {
            ...init.headers,
            "x-amz-content-sha256": sha256Hex(init.body ?? new Uint8Array()),
          },
          ...(init.body ? { body: init.body as BodyInit } : {}),
          accessKeyId,
          secretAccessKey,
          service: "s3",
          region: "auto",
        }).sign();
        res = await f(signed.url.toString(), {
          method: signed.method,
          headers: signed.headers,
          ...(init.body ? { body: init.body as BodyInit } : {}),
        });
      } catch (e) {
        last = new CfError(method, route, 0, `network: ${(e as Error).name}`);
        continue;
      }
      if (res.ok && method === "GET") {
        const bytes =
          init.maxBytes !== undefined
            ? await readCapped(res, init.maxBytes, route)
            : new Uint8Array(await res.arrayBuffer());
        return { status: res.status, headers: res.headers, bytes };
      }
      const text = method === "HEAD" ? "" : await res.text().catch(() => "");
      if (res.ok || ok.includes(res.status))
        return { status: res.status, headers: res.headers };
      last = new CfError(method, route, res.status, s3Code(text));
      if (res.status !== 429 && res.status < 500) throw last;
    }
    throw last as CfError;
  }

  return {
    env,
    bucket,
    async get(key, opts) {
      const r = await call("GET", key, { maxBytes: opts?.maxBytes }, [404]);
      if (r.status === 404) return null;
      return { bytes: r.bytes ?? new Uint8Array(), etag: etagOf(r.headers) };
    },
    async head(key) {
      const r = await call("HEAD", key, {}, [404]);
      if (r.status === 404) return null;
      const size = Number(r.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0)
        throw new CfError("HEAD", `r2s3:${pathOf(key)}`, r.status, "no size");
      return { size, etag: etagOf(r.headers) };
    },
    async put(key, bytes, cond) {
      const headers: Record<string, string> =
        cond && "ifNoneMatch" in cond && cond.ifNoneMatch === "*"
          ? { "if-none-match": "*" }
          : cond &&
              "ifMatch" in cond &&
              typeof cond.ifMatch === "string" &&
              /^[^\s"]+$/.test(cond.ifMatch)
            ? { "if-match": `"${cond.ifMatch}"` }
            : (() => {
                throw new Error("an R2 put needs If-None-Match: * or If-Match");
              })();
      if (!(bytes instanceof Uint8Array))
        throw new Error("an R2 put needs bytes");
      const r = await call(
        "PUT",
        key,
        {
          body: bytes,
          headers: { ...headers, "content-type": "application/octet-stream" },
        },
        [],
      );
      return { etag: etagOf(r.headers) };
    },
    async deleteProbe(key) {
      // Only probeR2Conditionals' throwaway keys; a release object or
      // floor.json is never deleted through this client.
      if (typeof key !== "string" || !PROBE_KEY.test(key))
        throw new Error(
          "deleteProbe only deletes the R2 probe's throwaway keys (probe/<32 hex>)",
        );
      await call("DELETE", key, {}, [404]);
    },
  };
}
