import { b64urlDecode, b64urlEncode } from "../util/crypto.js";
import { utf8Decoder } from "../util/text.js";

// A minimal WebAuthn verifier for passkey-confirmed picks (#2263), on
// WebCrypto only (it runs on Workers). It accepts attestation "none" (the
// registration asks for none and never trusts the statement), ES256 and
// RS256 keys, and always requires user verification (UV). Nothing here reads
// the database: the caller supplies the expected challenge, origin and rpId.

export class PasskeyError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "PasskeyError";
  }
}

const fail = (reason: string): never => {
  throw new PasskeyError(reason);
};

/** COSE algorithm ids this verifier supports. */
export const ALG_ES256 = -7;
export const ALG_RS256 = -257;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// ---- CBOR (RFC 8949), the subset attestation objects and COSE keys use ----

type Cbor =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | Cbor[]
  | Map<Cbor, Cbor>;

const MAX_DEPTH = 6;
const MAX_ITEMS = 64;

function decodeItem(
  b: Uint8Array,
  at: number,
  depth: number,
): { v: Cbor; next: number } {
  if (depth > MAX_DEPTH || at >= b.length) return fail("cbor");
  const head = b[at] as number;
  const major = head >> 5;
  const info = head & 31;
  let pos = at + 1;
  let n = info;
  if (info === 24) {
    if (pos + 1 > b.length) return fail("cbor");
    n = b[pos] as number;
    pos += 1;
  } else if (info === 25) {
    if (pos + 2 > b.length) return fail("cbor");
    n = ((b[pos] as number) << 8) | (b[pos + 1] as number);
    pos += 2;
  } else if (info === 26) {
    if (pos + 4 > b.length) return fail("cbor");
    n = new DataView(b.buffer, b.byteOffset + pos, 4).getUint32(0);
    pos += 4;
  } else if (info >= 27 && major !== 7) return fail("cbor");
  if (major === 0) return { v: n, next: pos };
  if (major === 1) return { v: -1 - n, next: pos };
  if (major === 2 || major === 3) {
    if (pos + n > b.length) return fail("cbor");
    const raw = b.slice(pos, pos + n);
    return {
      v: major === 2 ? raw : utf8Decoder.decode(raw),
      next: pos + n,
    };
  }
  if (major === 4) {
    if (n > MAX_ITEMS) return fail("cbor");
    const out: Cbor[] = [];
    for (let i = 0; i < n; i++) {
      const r = decodeItem(b, pos, depth + 1);
      out.push(r.v);
      pos = r.next;
    }
    return { v: out, next: pos };
  }
  if (major === 5) {
    if (n > MAX_ITEMS) return fail("cbor");
    const m = new Map<Cbor, Cbor>();
    for (let i = 0; i < n; i++) {
      const k = decodeItem(b, pos, depth + 1);
      const v = decodeItem(b, k.next, depth + 1);
      m.set(k.v, v.v);
      pos = v.next;
    }
    return { v: m, next: pos };
  }
  if (major === 7) {
    if (info === 20) return { v: false, next: pos };
    if (info === 21) return { v: true, next: pos };
    if (info === 22 || info === 23) return { v: null, next: pos };
  }
  return fail("cbor");
}

/** Decodes one CBOR item at `at`; returns it and where it ended. */
export const decodeCbor = (b: Uint8Array, at = 0) => decodeItem(b, at, 0);

// ---- helpers ----

const sha256 = async (d: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", d));

const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
};

const bytes = (s: unknown): Uint8Array<ArrayBuffer> =>
  typeof s === "string" ? (b64urlDecode(s) ?? fail("encoding")) : fail("field");

/** A new random challenge: 32 bytes, base64url. */
export const newChallenge = (): string =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

type AuthData = {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  /** The credential's COSE key, as the authenticator encoded it. */
  coseKey?: Uint8Array;
};

function parseAuthData(a: Uint8Array): AuthData {
  if (a.length < 37) return fail("authdata");
  const flags = a[32] as number;
  const signCount = new DataView(a.buffer, a.byteOffset + 33, 4).getUint32(0);
  const out: AuthData = {
    rpIdHash: a.slice(0, 32),
    flags,
    signCount,
  };
  if (flags & FLAG_AT) {
    if (a.length < 55) return fail("authdata");
    const len = ((a[53] as number) << 8) | (a[54] as number);
    if (len < 1 || len > 1023 || a.length < 55 + len) return fail("authdata");
    out.credentialId = a.slice(55, 55 + len);
    const key = decodeItem(a, 55 + len, 0);
    out.coseKey = a.slice(55 + len, key.next);
  }
  return out;
}

type Expected = { challenge: string; origin: string; rpId: string };

async function checkClientData(
  raw: Uint8Array,
  type: "webauthn.create" | "webauthn.get",
  want: Expected,
): Promise<void> {
  let cd: unknown;
  try {
    cd = JSON.parse(utf8Decoder.decode(raw));
  } catch {
    return fail("client_data");
  }
  if (typeof cd !== "object" || cd === null) return fail("client_data");
  const c = cd as Record<string, unknown>;
  if (c.type !== type) return fail("type");
  if (typeof c.challenge !== "string" || c.challenge !== want.challenge)
    return fail("challenge");
  if (c.origin !== want.origin) return fail("origin");
  if (c.crossOrigin === true) return fail("cross_origin");
}

async function checkAuthData(a: AuthData, want: Expected): Promise<void> {
  const rp = await sha256(new TextEncoder().encode(want.rpId));
  if (!same(a.rpIdHash, rp)) return fail("rp_id");
  if (!(a.flags & FLAG_UP)) return fail("user_presence");
  if (!(a.flags & FLAG_UV)) return fail("user_verification");
}

const asMap = (v: Cbor): Map<Cbor, Cbor> =>
  v instanceof Map ? v : (fail("cose") as never);

/** The WebCrypto key and algorithm for a COSE key; null when unsupported. */
async function importCose(
  cose: Uint8Array,
): Promise<{ key: CryptoKey; alg: number } | null> {
  const m = asMap(decodeCbor(cose).v);
  const alg = m.get(3);
  const kty = m.get(1);
  const b64 = (k: number) => {
    const v = m.get(k);
    return v instanceof Uint8Array ? b64urlEncode(v) : null;
  };
  try {
    if (alg === ALG_ES256 && kty === 2 && m.get(-1) === 1) {
      const x = b64(-2);
      const y = b64(-3);
      if (!x || !y) return null;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x, y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return { key, alg: ALG_ES256 };
    }
    if (alg === ALG_RS256 && kty === 3) {
      const n = b64(-1);
      const e = b64(-2);
      if (!n || !e) return null;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n, e, alg: "RS256" },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return { key, alg: ALG_RS256 };
    }
  } catch {
    return null;
  }
  return null;
}

/** A DER ECDSA signature as the raw r||s (64 bytes) WebCrypto verifies. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let p = 0;
  const len = (): number => {
    let l = der[p++] as number;
    if (l & 0x80) {
      const n = l & 0x7f;
      if (n < 1 || n > 2) return fail("signature");
      l = 0;
      for (let i = 0; i < n; i++) l = (l << 8) | (der[p++] as number);
    }
    return l;
  };
  if (der[p++] !== 0x30) return fail("signature");
  if (len() !== der.length - p) return fail("signature");
  const int = (): Uint8Array => {
    if (der[p++] !== 0x02) return fail("signature");
    const l = len();
    if (l < 1 || p + l > der.length) return fail("signature");
    let v = der.slice(p, p + l);
    p += l;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return fail("signature");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (p !== der.length) return fail("signature");
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

export type Registered = {
  credentialId: string;
  /** The COSE key, base64url. */
  publicKey: string;
  alg: number;
  signCount: number;
};

/** The JSON a browser's `PublicKeyCredential.toJSON()` gives, as far as the checks read it. */
type CredentialJSON = { id?: unknown; rawId?: unknown; response?: unknown };

const responseOf = (cred: unknown): Record<string, unknown> => {
  const r = (cred as CredentialJSON | null)?.response;
  return typeof r === "object" && r !== null
    ? (r as Record<string, unknown>)
    : (fail("response") as never);
};

/** Verifies a registration (attestation) and returns the credential to store. */
export async function verifyRegistration(
  cred: unknown,
  want: Expected,
): Promise<Registered> {
  const c = cred as CredentialJSON;
  const res = responseOf(cred);
  await checkClientData(bytes(res.clientDataJSON), "webauthn.create", want);
  const att = decodeCbor(bytes(res.attestationObject)).v;
  const authBytes = asMap(att).get("authData");
  if (!(authBytes instanceof Uint8Array)) return fail("authdata");
  const a = parseAuthData(authBytes);
  await checkAuthData(a, want);
  if (!a.credentialId || !a.coseKey) return fail("no_credential");
  const id = b64urlEncode(a.credentialId);
  if (c.id !== id || c.rawId !== id) return fail("credential_id");
  const k = await importCose(a.coseKey);
  if (!k) return fail("algorithm");
  return {
    credentialId: id,
    publicKey: b64urlEncode(a.coseKey),
    alg: k.alg,
    signCount: a.signCount,
  };
}

/** The credential id an assertion names (base64url), before it is verified. */
export function assertionCredentialId(cred: unknown): string | null {
  const id = (cred as CredentialJSON | null)?.id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,1400}$/.test(id)
    ? id
    : null;
}

/**
 * Verifies an assertion against a stored key: client data (type, challenge,
 * origin), rpId, UP and UV, the signature, and that the signCount did not
 * regress (both zero is fine: the authenticator keeps no counter). Returns the
 * new signCount to store.
 */
export async function verifyAssertion(
  cred: unknown,
  want: Expected,
  stored: { publicKey: string; signCount: number },
): Promise<{ signCount: number }> {
  const c = cred as CredentialJSON;
  if (c.id !== c.rawId) return fail("credential_id");
  const res = responseOf(cred);
  const clientData = bytes(res.clientDataJSON);
  await checkClientData(clientData, "webauthn.get", want);
  const authBytes = bytes(res.authenticatorData);
  const a = parseAuthData(authBytes);
  await checkAuthData(a, want);
  if ((a.signCount > 0 || stored.signCount > 0) && a.signCount <= stored.signCount)
    return fail("sign_count");
  const k = await importCose(bytes(stored.publicKey));
  if (!k) return fail("algorithm");
  const signed = new Uint8Array(authBytes.length + 32);
  signed.set(authBytes, 0);
  signed.set(await sha256(clientData), authBytes.length);
  const sig = bytes(res.signature);
  let ok = false;
  try {
    ok =
      k.alg === ALG_ES256
        ? await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            k.key,
            derToRaw(sig),
            signed,
          )
        : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.key, sig, signed);
  } catch (e) {
    if (e instanceof PasskeyError) throw e;
    return fail("signature");
  }
  if (!ok) return fail("signature");
  return { signCount: a.signCount };
}
