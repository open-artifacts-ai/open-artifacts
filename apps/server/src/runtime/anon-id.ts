import { ANON_ID_SHORT_LEN } from "@oa/shared";
import type { Env } from "../env.js";
import { b64urlDecode, b64urlEncode } from "../util/crypto.js";

/**
 * Signed per-browser anonymous id, for anonymous viewers of artifacts with
 * dataWriters "viewers". One global token per browser per app origin:
 * "<id>.<iat>.<sig>", id = base64url(16 random bytes) (22 chars),
 * iat = issued-at in unix seconds, base36,
 * sig = base64url(HMAC-SHA256(k2, "anon:" + id + ":" + iat)) (43 chars), where
 * k2 = HKDF-SHA256(SESSION_SECRET, info "oa/anon-id/v2"). Rotating
 * SESSION_SECRET resets every anonId. The token is never logged.
 *
 * A token older than ANON_TOKEN_MAX_AGE_S, or a legacy v1 token ("<id>.<sig>",
 * sig over "anon:" + id with k1 = info "oa/anon-id/v1"), is accepted once and
 * re-minted with the SAME id, so a browser's labels never change; the expiry
 * bounds how long a leaked token works. An iat more than ANON_TOKEN_SKEW_S in
 * the future is rejected (a fresh id is minted).
 *
 * The public id is per artifact, so one browser can't be linked across
 * artifacts: short = base64url(HMAC-SHA256(k1, "short:" + artifactId + ":" + id))
 * truncated to ANON_ID_SHORT_LEN chars. It stays on k1 so v1 labels survive.
 */
export const ANON_TOKEN_MAX_AGE_S = 30 * 24 * 60 * 60;
export const ANON_TOKEN_SKEW_S = 5 * 60;
const ID = "[A-Za-z0-9_-]{21}[AQgw]";
const SIG = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
const V1_RE = new RegExp(`^(${ID})\\.(${SIG})$`);
const V2_RE = new RegExp(`^(${ID})\\.([1-9a-z][0-9a-z]{0,9})\\.(${SIG})$`);
const enc = new TextEncoder();

type Keys = { v1: CryptoKey; v2: CryptoKey };
const derive = (ikm: CryptoKey, info: string) =>
  crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: enc.encode(info),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );

let derived: { secret: string; key: Promise<Keys> } | null = null;
function anonKeys(env: Pick<Env, "SESSION_SECRET">): Promise<Keys> {
  const s = env.SESSION_SECRET;
  // Same rule as auth/keys.ts: HKDF accepts any length, so a short secret
  // still derives keys (it is warned about there); only empty is an error.
  if (typeof s !== "string" || s.length === 0)
    throw new Error("SESSION_SECRET is not set");
  if (derived?.secret !== s) {
    const key = crypto.subtle
      .importKey("raw", enc.encode(s), "HKDF", false, ["deriveKey"])
      .then(async (ikm) => ({
        v1: await derive(ikm, "oa/anon-id/v1"),
        v2: await derive(ikm, "oa/anon-id/v2"),
      }));
    key.catch(() => {
      if (derived?.key === key) derived = null;
    });
    derived = { secret: s, key };
  }
  return derived.key;
}

const sign = async (key: CryptoKey, data: string) =>
  b64urlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))),
  );

const shortOf = async (key: CryptoKey, artifactId: string, id: string) =>
  (await sign(key, `short:${artifactId}:${id}`)).slice(0, ANON_ID_SHORT_LEN);

export type AnonId = {
  /** The per-artifact public id (updatedBy "anon:<short>", viewer.anonId()). */
  short: string;
  /** Set when a new token was minted; return it to the shell. Never log it. */
  issued: string | null;
};

const verify = async (key: CryptoKey, sigB64: string, data: string) => {
  const sig = b64urlDecode(sigB64);
  return (
    !!sig && (await crypto.subtle.verify("HMAC", key, sig, enc.encode(data)))
  );
};

/**
 * The id `token` carries, and whether it must be re-minted (v1 or expired),
 * or null when it is malformed, forged or issued in the future.
 */
async function verifyToken(
  keys: Keys,
  token: string,
  nowS: number,
): Promise<{ id: string; renew: boolean } | null> {
  const v2 = V2_RE.exec(token);
  if (v2) {
    const [, id = "", iat36 = "", sig = ""] = v2;
    if (!(await verify(keys.v2, sig, `anon:${id}:${iat36}`))) return null;
    const iat = Number.parseInt(iat36, 36);
    if (iat > nowS + ANON_TOKEN_SKEW_S) return null;
    return { id, renew: nowS - iat > ANON_TOKEN_MAX_AGE_S };
  }
  const v1 = V1_RE.exec(token);
  if (v1) {
    const [, id = "", sig = ""] = v1;
    if (await verify(keys.v1, sig, `anon:${id}`)) return { id, renew: true };
  }
  return null;
}

/** A v2 token for `id`, issued at `nowS`. */
export async function issueAnonToken(
  env: Pick<Env, "SESSION_SECRET">,
  id: string,
  nowS: number,
): Promise<string> {
  const iat = Math.floor(nowS).toString(36);
  const { v2 } = await anonKeys(env);
  return `${id}.${iat}.${await sign(v2, `anon:${id}:${iat}`)}`;
}

/**
 * Verifies `token` and returns this artifact's short id for it. A v1 or
 * expired token is re-minted with the same id (only if `mint`). When it is
 * missing, malformed, forged or from the future: mints a fresh id if `mint`,
 * else null.
 */
export async function resolveAnonId(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  token: string | undefined,
  mint: boolean,
  now: number = Date.now(),
): Promise<AnonId | null> {
  if (!token && !mint) return null;
  const keys = await anonKeys(env);
  const nowS = Math.floor(now / 1000);
  const ok = token ? await verifyToken(keys, token, nowS) : null;
  if (ok && !ok.renew)
    return { short: await shortOf(keys.v1, artifactId, ok.id), issued: null };
  if (!mint) return null;
  const id = ok?.id ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return {
    short: await shortOf(keys.v1, artifactId, id),
    issued: await issueAnonToken(env, id, nowS),
  };
}
