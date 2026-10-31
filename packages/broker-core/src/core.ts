// What both hosted brokers share (P2 sign-in broker, P3 directory broker):
// responses, outcome-only logging, the HMAC-signed broker state, the
// fail-closed rate limits, and the install assertion check. Each broker keeps
// its own Env, keys and routes; nothing here holds a secret.
import { ipKeyOf, keyId, verifyRequest } from "@oa/auth-core";
import { GATE_INSTALL_HEADER } from "./gate-header.js";
import type { RegistryEntry } from "./registry.js";

const enc = new TextEncoder();

export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64 = (s: string): string | null => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};

export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
export const notFound = () => json({ error: "not_found" }, 404);
export const refused = () => json({ error: "unauthorized" }, 401);
/**
 * Refusals AFTER the install's signature and registered key verified. Still
 * 401, but the caller learns its key works, and why it was refused: `stale`
 * (the assertion's ts is outside the skew: the install's clock or signing path
 * is off) or `bad_flow` (the flow, grant or code doesn't bind). Only a holder
 * of the install's signing key can get here, so neither tells an outsider
 * anything; every refusal before verification (size, body, unknown install,
 * bad signature) stays `refused()` ("unauthorized"). broker-check (#730)
 * counts ok only on `bad_flow`.
 */
export const staleAssertion = () => json({ error: "stale" }, 401);
export const badFlow = () => json({ error: "bad_flow" }, 401);

export type Log = (route: string, outcome: string) => void;
/** One line per outcome; never a code, verifier, token, email or key. */
export const logger =
  (evt: string): Log =>
  (route, outcome) =>
    console.log(JSON.stringify({ evt, route, outcome }));

export async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Constant-time byte equality. */
export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export const s256 = async (v: string) =>
  b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v))));

/**
 * The broker state: install, the install's client state, a flow hash `h`
 * and a short expiry. `domain`, when given, is MACed in front of the payload
 * ("<domain>." + payload), so a state minted for one purpose never verifies
 * for another; the sign-in broker passes none (its P2 format, unchanged).
 */
export type BrokerState = { i: string; s: string; h: string; exp: number };

const macInput = (domain: string | undefined, p: string) =>
  domain ? `${domain}.${p}` : p;

export async function signState(
  key: string,
  st: BrokerState,
  domain?: string,
): Promise<string> {
  const p = b64(enc.encode(JSON.stringify(st)));
  return `${p}.${b64(await hmac(key, macInput(domain, p)))}`;
}

export async function readState(
  key: string,
  v: string,
  now: number,
  domain?: string,
): Promise<BrokerState | null> {
  const st = await verifyState(key, v, domain);
  return st && st.exp > now ? st : null;
}

/**
 * A state this broker signed, whether or not it has expired: MAC and shape
 * only. Only for telling an authentic late return from a forgery; every
 * flow step uses readState.
 */
export async function verifyState(
  key: string,
  v: string,
  domain?: string,
): Promise<BrokerState | null> {
  const [p, sig, extra] = v.split(".");
  if (!p || !sig || extra !== undefined) return null;
  const want = await hmac(key, macInput(domain, p));
  const got = unb64(sig);
  if (
    got === null ||
    !same(
      want,
      Uint8Array.from(got, (c) => c.charCodeAt(0)),
    )
  )
    return null;
  try {
    const raw = unb64(p);
    const st = raw ? (JSON.parse(raw) as BrokerState) : null;
    if (
      !st ||
      typeof st.i !== "string" ||
      typeof st.s !== "string" ||
      typeof st.h !== "string"
    )
      return null;
    return typeof st.exp === "number" ? st : null;
  } catch {
    return null;
  }
}

/** The fixed public origin, or null when the var is missing or not https. */
export function fixedOrigin(raw: string | undefined): string | null {
  try {
    const u = new URL(raw ?? "");
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export { GATE_INSTALL_HEADER };

const GATE_INSTALL = /^i[a-z0-9]{11}$/;

/**
 * The "per-IP" bucket key. Cloudflare sets cf-connecting-ip on every request
 * from the internet (a client's own value is overwritten), so a request
 * without it came over a service binding, i.e. through BrokerGate. Gate
 * traffic is charged per install (`gate:<id>`), so one install's sign-ins
 * never share a bucket with every other hosted install. The gate header is
 * ignored whenever cf-connecting-ip is present, so a public caller can't pick
 * its bucket.
 */
export function rateKeyOf(req: Request): string {
  const ip = req.headers.get("cf-connecting-ip")?.trim();
  // IPv6 by its /64 (ipKey, design v7 4.7): one subscriber holds the /64.
  if (ip) return `ip:${ipKeyOf(ip)}`;
  const gate = req.headers.get(GATE_INSTALL_HEADER)?.trim() ?? "";
  return GATE_INSTALL.test(gate) ? `gate:${gate}` : "ip:unknown";
}

export type Limits = { ip?: RateLimit; install?: RateLimit };

/**
 * Charges the per-IP bucket before any Google or registry work. A missing
 * binding (either one) fails closed (503) rather than unlimited.
 */
export async function ipLimited(
  rl: Limits,
  req: Request,
  log: Log,
): Promise<Response | null> {
  if (!rl.ip || !rl.install)
    return log("rate_limit", "unbound"), json({ error: "unavailable" }, 503);
  if (!(await rl.ip.limit({ key: rateKeyOf(req) })).success)
    return log("rate_limit", "ip"), json({ error: "rate_limited" }, 429);
  return null;
}

/**
 * Charges the per-install bucket only once the request is tied to a real
 * install (or authenticated as it): junk requests naming install B must not
 * drain B's bucket. `scope` gives a route its own bucket within the binding
 * (key `<scope>:install:<id>`), so an unauthenticated route can't drain an
 * authenticated one; without it the key is `install:<id>` (the sign-in
 * broker's, unchanged).
 */
export async function installLimited(
  rl: Limits,
  install: string,
  log: Log,
  scope?: string,
): Promise<Response | null> {
  if (!rl.install)
    return log("rate_limit", "unbound"), json({ error: "unavailable" }, 503);
  const key = `${scope ? `${scope}:` : ""}install:${install}`;
  if (!(await rl.install.limit({ key })).success)
    return log("rate_limit", "install"), json({ error: "rate_limited" }, 429);
  return null;
}

/** Install assertions are refused outside this window (ms). */
export const ASSERTION_SKEW_MS = 60_000;
/** The largest signed body either broker reads. */
export const MAX_BODY = 4096;

/**
 * The install assertion: `kid` is one of this install's keys AND derives
 * from its public key, and `sig` is its Ed25519 signature over the
 * path-bound transcript (requestTranscript), so a signature for one route or
 * key id never verifies on another.
 */
export async function verifyAssertion(
  entry: RegistryEntry,
  path: string,
  kid: string,
  body: string,
  sig: string,
): Promise<boolean> {
  let x: string | null = null;
  for (const k of entry.keys)
    if (k.kid === kid && (await keyId(k.x)) === kid) x = k.x;
  return x !== null && (await verifyRequest(x, path, kid, body, sig));
}
