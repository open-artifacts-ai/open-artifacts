import type { Env } from "../env.js";
import { b64url, hmacB64, sameString } from "./crypto.js";

// The sign-in flow cookie (design v7 4.3 step 1): `__Host-oa-admin-flow` =
// base64url(payload) "." HMAC-SHA256(ADMIN_SESSION_KEY, "flow\n" + payload),
// 10 minutes, SameSite=Lax (the broker's redirect back is a cross-site
// top-level GET).

export const FLOW_COOKIE = "__Host-oa-admin-flow";
export const FLOW_TTL_MS = 10 * 60_000;

export type Flow = {
  state: string;
  nonce: string;
  verifier: string;
  return: string;
  reauth: boolean;
  exp: number;
};

const enc = new TextEncoder();
const dec = (s: string) => {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};

const mac = (env: Env, payload: string) =>
  hmacB64(env.ADMIN_SESSION_KEY, `flow\n${payload}`);

/** The cookie value for `f`. */
export async function writeFlow(env: Env, f: Flow): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(f)));
  return `${payload}.${await mac(env, payload)}`;
}

/** The flow, or null when the MAC, the shape or the expiry fails. */
export async function readFlow(
  env: Env,
  value: string | null,
  now: number,
): Promise<Flow | null> {
  const [payload, sig, extra] = (value ?? "").split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!sameString(sig, await mac(env, payload))) return null;
  let f: Flow;
  try {
    f = JSON.parse(dec(payload) ?? "") as Flow;
  } catch {
    return null;
  }
  if (
    typeof f?.state !== "string" ||
    typeof f.nonce !== "string" ||
    typeof f.verifier !== "string" ||
    typeof f.return !== "string" ||
    typeof f.reauth !== "boolean" ||
    typeof f.exp !== "number" ||
    f.exp < now
  )
    return null;
  return f;
}

export const flowCookie = (value: string) =>
  `${FLOW_COOKIE}=${value}; Max-Age=${FLOW_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
export const clearFlowCookie = () =>
  `${FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
