import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// GitHub OIDC JWTs for the red-line job (design v7 4.4, 6.3). The redline job
// alone has `id-token: write`; it mints one JWT per audience into a 0600 file
// in the scanned secrets dir (REDLINE_TARGETS.secretsDir), and the suite reads
// them by path. Each JWT lives at most 600 s (the verifiers' exp - iat cap), so
// a reader asks for a fresh one when it is near expiry: in the job (the
// runner's ACTIONS_ID_TOKEN_REQUEST_* env present) it re-mints into the same
// file; elsewhere it fails, never falling back to a stored key.

/** The audiences (6.3, and the staging API's OIDC_AUDIENCE in apps/provisioning/wrangler.jsonc). */
export const AUDIENCES = {
  provisioning: "https://api.open-artifacts-staging.app",
  stagingInventory: "https://oa-s-inventory",
  prodInventory: "https://oa-p-inventory",
} as const;
export type AudienceKey = keyof typeof AUDIENCES;

/** The file each audience's JWT is written to, under secretsDir. */
export const OIDC_FILES: Readonly<Record<AudienceKey, string>> = {
  provisioning: "REDLINE_PROVISIONING_OIDC",
  stagingInventory: "REDLINE_STG_INVENTORY_OIDC",
  prodInventory: "REDLINE_PROD_INVENTORY_OIDC",
};

/** A reader asks for a new JWT when the current one has less than this left. */
export const REFRESH_MARGIN_S = 90;

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The JWT's claims (no signature check: the API and inventory verify). */
export function jwtClaims(jwt: string): Record<string, unknown> {
  if (!JWT_RE.test(jwt)) throw new Error("OIDC: not a JWT");
  const part = jwt.split(".")[1] ?? "";
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {}
  throw new Error("OIDC: the JWT payload is not a JSON object");
}

export interface MintEnv {
  ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
}

export const canMint = (env: MintEnv): boolean =>
  !!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

/**
 * One JWT for `audience` from the runner's token endpoint. The answer's aud
 * must be exactly `audience`. Errors never carry the token or the JWT.
 */
export async function mintJwt(
  audience: string,
  env: MintEnv,
  f: typeof fetch = fetch,
): Promise<string> {
  if (!canMint(env))
    throw new Error(
      "OIDC: no ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN (the job needs id-token: write)",
    );
  const u = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL as string);
  u.searchParams.set("audience", audience);
  const res = await f(u, {
    headers: {
      authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      accept: "application/json",
    },
    redirect: "manual",
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`OIDC: the token endpoint answered ${res.status}`);
  }
  let value: unknown;
  try {
    value = ((await res.json()) as { value?: unknown }).value;
  } catch {
    throw new Error("OIDC: the token endpoint's answer is not JSON");
  }
  if (typeof value !== "string" || !JWT_RE.test(value))
    throw new Error("OIDC: the token endpoint's answer holds no JWT");
  if (jwtClaims(value).aud !== audience)
    throw new Error("OIDC: the minted JWT has another audience");
  return value;
}

/** Writes `value` to `path` as a 0600 file (a temp file renamed over it). */
export function writeSecretFile(path: string, value: string): void {
  const tmp = join(dirname(path), `.${process.pid}.tmp`);
  writeFileSync(tmp, value, { mode: 0o600, flag: "w" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readJwtFile(path: string, what: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`${what}: file missing`);
  }
  if (!st.isFile()) throw new Error(`${what}: not a regular file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error(`${what}: file mode must be 0600`);
  const v = readFileSync(path, "utf8").trim();
  if (!JWT_RE.test(v)) throw new Error(`${what}: not a JWT`);
  return v;
}

export interface JwtSourceOpts {
  env?: MintEnv;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch (tests pin it). */
  now?: () => number;
  /** Each fresh JWT is handed here first (CI: `::add-mask::`). */
  onMint?: (jwt: string) => void;
}

/**
 * A JWT reader over one file: returns the file's JWT while it has more than
 * REFRESH_MARGIN_S left, else mints a new one into the file (in the job) or
 * throws (anywhere else).
 */
export function jwtSource(
  file: string,
  audience: string,
  opts: JwtSourceOpts = {},
): () => Promise<string> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const what = file.split("/").pop() ?? "OIDC JWT";
  return async () => {
    let jwt: string | undefined;
    try {
      jwt = readJwtFile(file, what);
    } catch (e) {
      if (!canMint(env)) throw e;
    }
    if (jwt) {
      const exp = jwtClaims(jwt).exp;
      if (typeof exp === "number" && exp - now() / 1000 > REFRESH_MARGIN_S)
        return jwt;
      if (!canMint(env)) throw new Error(`${what}: the JWT has expired`);
    }
    const fresh = await mintJwt(audience, env, opts.fetch);
    opts.onMint?.(fresh);
    writeSecretFile(file, fresh);
    return fresh;
  };
}

/** The GitHub log command that masks a value (written to stdout by the job only). */
export const maskLine = (v: string) => `::add-mask::${v}\n`;

/** In the job, every value this process learns is masked in the log first. */
export const mask = (env: Record<string, string | undefined>) =>
  env.GITHUB_ACTIONS === "true"
    ? (v: string) => {
        process.stdout.write(maskLine(v));
      }
    : () => {};
