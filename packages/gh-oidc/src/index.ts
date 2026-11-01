// GitHub Actions OIDC verification (design v7 4.4), shared by the
// Provisioning API (staging red-line principal) and inventory (6.3). RS256
// only, `kid` from GitHub's JWKS (Cache API, 10 min; an unknown `kid`
// refetches at most once per 60 s per isolate; a fetch error fails closed),
// exp/nbf/iat with 60 s skew, `exp - iat <= 600`, and every pin below. No
// dependencies: WebCrypto only.

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
/** Fixed by 4.4 for every caller, so no caller can loosen them. */
export const GITHUB_OIDC_REF = "refs/heads/main";
export const GITHUB_OIDC_EVENT_NAMES = [
  "schedule",
  "workflow_dispatch",
] as const;

/** The one GitHub environment 4.4 admits; OIDC_ENVIRONMENT must equal it. */
export const GITHUB_OIDC_ENVIRONMENT = "redline-staging";

/** The OIDC_* vars every caller (provisioning 4.4, inventory 6.3) sets. */
export type OidcEnv = {
  OIDC_AUDIENCE?: string;
  OIDC_REPOSITORY?: string;
  OIDC_REPOSITORY_ID?: string;
  /** Comma-separated `job_workflow_ref` values. */
  OIDC_JOB_WORKFLOW_REFS?: string;
  OIDC_ENVIRONMENT?: string;
};

/**
 * The pins from a Worker's OIDC_* vars, or null (fail closed) when any is
 * missing or empty, or OIDC_ENVIRONMENT is not GITHUB_OIDC_ENVIRONMENT, so a
 * config edit can drop OIDC but never widen it.
 */
export function pinsFromEnv(env: OidcEnv): Pins | null {
  const refs = (env.OIDC_JOB_WORKFLOW_REFS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const { OIDC_AUDIENCE, OIDC_REPOSITORY, OIDC_REPOSITORY_ID } = env;
  if (
    !OIDC_AUDIENCE ||
    !OIDC_REPOSITORY ||
    !OIDC_REPOSITORY_ID ||
    env.OIDC_ENVIRONMENT !== GITHUB_OIDC_ENVIRONMENT ||
    refs.length === 0
  )
    return null;
  return {
    audience: OIDC_AUDIENCE,
    repository: OIDC_REPOSITORY,
    repositoryId: OIDC_REPOSITORY_ID,
    jobWorkflowRefs: refs,
    environment: GITHUB_OIDC_ENVIRONMENT,
  };
}

/** What a caller pins; every field must match the token exactly. */
export type Pins = {
  /** `aud` (OIDC_AUDIENCE). */
  audience: string;
  /** `repository` (OIDC_REPOSITORY), `owner/name`. */
  repository: string;
  /** `repository_id` (OIDC_REPOSITORY_ID), survives a rename. */
  repositoryId: string;
  /** `job_workflow_ref` must be one of these (OIDC_JOB_WORKFLOW_REFS). */
  jobWorkflowRefs: readonly string[];
  /** `environment` (OIDC_ENVIRONMENT), `redline-staging`. */
  environment: string;
};

/**
 * The verified claims; `iss`, `ref`, `event_name` and `runner_environment`
 * are the library constants above.
 */
export type Claims = {
  iss: typeof GITHUB_OIDC_ISSUER;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  repository: string;
  repository_id: string;
  ref: typeof GITHUB_OIDC_REF;
  job_workflow_ref: string;
  environment: string;
  event_name: (typeof GITHUB_OIDC_EVENT_NAMES)[number];
  runner_environment: "github-hosted";
};

/** Any failure; callers answer 401 and never echo `code` to the client. */
export class OidcError extends Error {
  constructor(readonly code: string) {
    super(`oidc: ${code}`);
    this.name = "OidcError";
  }
}

const SKEW_S = 60;
const MAX_LIFETIME_S = 600;
const JWKS_TTL_MS = 10 * 60_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;

type Jwk = JsonWebKey & { kid: string };

/**
 * The per-isolate key set: fresh for 10 minutes; an unknown `kid` forces a
 * network refetch at most once per 60 s.
 */
export class JwksCache {
  keys: Jwk[] = [];
  fetchedAt = Number.NEGATIVE_INFINITY;
  lastForcedAt = Number.NEGATIVE_INFINITY;
  readonly imported = new Map<string, Promise<CryptoKey>>();
}
const isolateJwks = new JwksCache();

/** Test seams; production callers pass nothing. */
export type VerifyOptions = {
  fetch?: typeof fetch;
  /** Epoch ms. */
  now?: () => number;
  jwks?: JwksCache;
  /** The Cache API store; null skips it. Default the named cache `oa-gh-oidc`. */
  cache?: Cache | null;
};

/**
 * The Cache API copy lives in a named cache under a private `.invalid` key,
 * never `caches.default` under GitHub's URL (a zone-wide entry any Worker or
 * a fetch through the zone could fill). Its fetch time rides with it, so a
 * fresh isolate keeps the 10-minute bound from the original fetch.
 */
export const JWKS_CACHE_NAME = "oa-gh-oidc";
export const JWKS_CACHE_KEY = "https://jwks.gh-oidc.invalid/github-actions";
const FETCHED_AT = "x-oa-fetched-at";

const defaultCache = async (): Promise<Cache | null> => {
  const c = (globalThis as { caches?: CacheStorage }).caches;
  if (!c?.open) return null;
  return c.open(JWKS_CACHE_NAME).catch(() => null);
};

const b64uBytes = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new OidcError("malformed");
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64uJson = (s: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64uBytes(s)));
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {}
  throw new OidcError("malformed");
};

function parseJwks(body: unknown): Jwk[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new OidcError("jwks");
  return keys.filter(
    (k): k is Jwk =>
      !!k &&
      typeof k === "object" &&
      typeof k.kid === "string" &&
      k.kty === "RSA" &&
      typeof k.n === "string" &&
      typeof k.e === "string",
  );
}

async function loadJwks(
  o: Required<VerifyOptions>,
  force: boolean,
): Promise<void> {
  const j = o.jwks;
  let res: Response | undefined;
  let fetchedAt = o.now();
  if (!force && o.cache) {
    res = await o.cache.match(JWKS_CACHE_KEY).catch(() => undefined);
    const at = Number(res?.headers.get(FETCHED_AT) ?? Number.NaN);
    // A copy with no fetch time, from the future, or past 10 min is a miss.
    if (
      res &&
      Number.isSafeInteger(at) &&
      at <= fetchedAt &&
      fetchedAt - at < JWKS_TTL_MS
    )
      fetchedAt = at;
    else res = undefined;
  }
  if (!res) {
    try {
      res = await o.fetch(GITHUB_OIDC_JWKS_URL);
    } catch {
      throw new OidcError("jwks");
    }
    if (!res.ok) throw new OidcError("jwks");
    const text = await res.text().catch(() => {
      throw new OidcError("jwks");
    });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OidcError("jwks");
    }
    j.keys = parseJwks(body);
    if (o.cache)
      await o.cache
        .put(
          JWKS_CACHE_KEY,
          new Response(text, {
            headers: {
              "content-type": "application/json",
              "cache-control": `max-age=${JWKS_TTL_MS / 1000}`,
              [FETCHED_AT]: String(fetchedAt),
            },
          }),
        )
        .catch(() => {});
  } else {
    j.keys = parseJwks(await res.json().catch(() => null));
  }
  j.fetchedAt = fetchedAt;
  j.imported.clear();
}

async function keyFor(
  kid: string,
  o: Required<VerifyOptions>,
): Promise<CryptoKey> {
  const j = o.jwks;
  const now = o.now();
  if (now - j.fetchedAt >= JWKS_TTL_MS) await loadJwks(o, false);
  let jwk = j.keys.find((k) => k.kid === kid);
  if (!jwk && o.now() - j.lastForcedAt >= UNKNOWN_KID_REFETCH_MS) {
    j.lastForcedAt = o.now();
    await loadJwks(o, true);
    jwk = j.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new OidcError("kid");
  let k = j.imported.get(kid);
  if (!k) {
    const { kty, n, e } = jwk;
    k = crypto.subtle.importKey(
      "jwk",
      { kty, n, e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    j.imported.set(kid, k);
  }
  return k.catch(() => {
    j.imported.delete(kid);
    throw new OidcError("jwks");
  });
}

const str = (c: Record<string, unknown>, k: string, code = k): string => {
  const v = c[k];
  if (typeof v !== "string") throw new OidcError(code);
  return v;
};
const num = (c: Record<string, unknown>, k: string): number => {
  const v = c[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new OidcError(k);
  return v;
};
const pin = (c: Record<string, unknown>, k: string, want: string) => {
  if (str(c, k) !== want) throw new OidcError(k);
};

/** Verifies a GitHub Actions OIDC JWT against `pins`; rejects with OidcError. */
export async function verify(
  jwt: string,
  pins: Pins,
  opts: VerifyOptions = {},
): Promise<Claims> {
  const o: Required<VerifyOptions> = {
    fetch: opts.fetch ?? ((u, i) => fetch(u, i)),
    now: opts.now ?? Date.now,
    jwks: opts.jwks ?? isolateJwks,
    cache: opts.cache === undefined ? await defaultCache() : opts.cache,
  };
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => p === ""))
    throw new OidcError("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = b64uJson(h);
  const claims = b64uJson(p);
  const sig = b64uBytes(s);
  if (header.alg !== "RS256") throw new OidcError("alg");
  if (typeof header.kid !== "string" || header.kid === "")
    throw new OidcError("kid");

  const key = await keyFor(header.kid, o);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new OidcError("signature");

  pin(claims, "iss", GITHUB_OIDC_ISSUER);
  pin(claims, "aud", pins.audience);
  pin(claims, "repository_id", pins.repositoryId);
  pin(claims, "repository", pins.repository);
  // Present, not pinned (4.4): a custom sub template must not lock out a caller.
  str(claims, "sub");
  pin(claims, "ref", GITHUB_OIDC_REF);
  if (!pins.jobWorkflowRefs.includes(str(claims, "job_workflow_ref")))
    throw new OidcError("job_workflow_ref");
  pin(claims, "environment", pins.environment);
  if (
    !(GITHUB_OIDC_EVENT_NAMES as readonly string[]).includes(
      str(claims, "event_name"),
    )
  )
    throw new OidcError("event_name");
  pin(claims, "runner_environment", "github-hosted");

  const now = o.now() / 1000;
  const exp = num(claims, "exp");
  const nbf = num(claims, "nbf");
  const iat = num(claims, "iat");
  if (now > exp + SKEW_S) throw new OidcError("exp");
  if (nbf > now + SKEW_S) throw new OidcError("nbf");
  if (iat > now + SKEW_S) throw new OidcError("iat");
  if (exp - iat > MAX_LIFETIME_S) throw new OidcError("lifetime");
  return claims as Claims;
}
