// #2512 S5: Web Push, with no dependency. The payload is encrypted as
// RFC 8291 (aes128gcm, RFC 8188) to the browser's key and the request is
// authorised with a VAPID JWT (RFC 8292, ES256), all through WebCrypto.
// The VAPID key pair is derived per instance from SESSION_SECRET (#3024,
// auth/keys.ts); the legacy VAPID_* env values are ignored. Without a
// SESSION_SECRET, push is off. The RFC 8291 payload crypto below is separate.
import { deriveVapidPair } from "../auth/keys.js";
import type { Env } from "../env.js";

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64u = (s: string): Bytes => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Push is on whenever the instance has a SESSION_SECRET (the VAPID pair derives from it). */
export const pushOn = (env: Env): boolean =>
  typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length > 0;

type Vapid = { publicKey: string; signKey: CryptoKey };
// One slot, keyed by the secret it came from: bounded, and a rotated
// SESSION_SECRET misses it even in a warm worker.
let vapidSlot: { secret: string; keys: Promise<Vapid> } | undefined;

/**
 * This instance's VAPID pair, derived from SESSION_SECRET (keys.ts). The
 * private key is a non-extractable signing CryptoKey; only `publicKey`
 * (base64url, 65-byte uncompressed point) is ever shown.
 */
export function vapidKeys(env: Pick<Env, "SESSION_SECRET">): Promise<Vapid> {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length === 0)
    return Promise.reject(new Error("SESSION_SECRET is not set"));
  if (vapidSlot?.secret === secret) return vapidSlot.keys;
  const keys = (async (): Promise<Vapid> => {
    const { publicKey, signKey } = await deriveVapidPair(env);
    return { publicKey: b64u(publicKey), signKey };
  })();
  const slot = { secret, keys };
  vapidSlot = slot;
  keys.catch(() => {
    if (vapidSlot === slot) vapidSlot = undefined;
  });
  return keys;
}

/**
 * Whether a subscription's keys can be encrypted to: p256dh a 65-byte
 * uncompressed P-256 point that is on the curve, auth 16 bytes.
 */
export async function pushKeysOk(
  p256dh: string,
  auth: string,
): Promise<boolean> {
  try {
    const k = unb64u(p256dh);
    if (k.length !== 65 || k[0] !== 4 || unb64u(auth).length !== 16)
      return false;
    await crypto.subtle.importKey(
      "raw",
      k,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Push services a subscription may name: a stored endpoint is a URL this
 * server will POST to, so only the known services are accepted (SSRF).
 * https, the default port, no credentials, and a host that is one of:
 * fcm.googleapis.com, updates.push.services.mozilla.com, *.push.apple.com,
 * *.notify.windows.com.
 */
export function pushEndpointOk(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password)
    return false;
  const h = u.hostname.toLowerCase();
  return (
    h === "fcm.googleapis.com" ||
    h === "updates.push.services.mozilla.com" ||
    h.endsWith(".push.apple.com") ||
    h.endsWith(".notify.windows.com")
  );
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const hkdf = async (
  secret: Bytes,
  salt: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> => {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
};

/** The record size written in the header (RFC 8188); one record is all we send. */
const RECORD_SIZE = 4096;
/** The most plaintext bytes one record holds (one delimiter byte and a 16-byte tag). */
export const MAX_PLAINTEXT = RECORD_SIZE - 17;

/**
 * RFC 8291 section 3: the aes128gcm body for one message to a browser.
 * `uaPublic` is the subscription's p256dh (65 bytes), `authSecret` its auth
 * (16 bytes). `fixed` pins the sender's key pair and salt for tests only.
 */
export async function encryptPayload(
  uaPublic: Bytes,
  authSecret: Bytes,
  plaintext: Bytes,
  fixed?: { keys: CryptoKeyPair; salt: Bytes },
): Promise<Bytes> {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4)
    throw new Error("bad p256dh");
  if (authSecret.length !== 16) throw new Error("bad auth");
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("payload too large");
  const keys =
    fixed?.keys ??
    ((await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair);
  const salt: Bytes = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      keys.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    shared,
    authSecret,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(
    ikm,
    salt,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // One record, the last: the plaintext, then the 0x02 delimiter.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aes,
      concat(plaintext, Uint8Array.of(2)),
    ),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

const jwtPart = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));

const VAPID_REUSE_MS = 60 * 60_000;
const MAX_VAPID_AUDIENCES = 64;
type CachedHeader = { created: number; value: Promise<string> };
// Rotating SESSION_SECRET yields a new signing key and therefore a fresh cache.
const headersByKey = new WeakMap<CryptoKey, Map<string, CachedHeader>>();

/**
 * The VAPID Authorization header value for a push to `endpoint` (RFC 8292):
 * a JWT valid 12 hours for the push service's origin, signed ES256 with the
 * instance's private key, and the public key.
 */
export async function vapidHeader(
  env: Env,
  endpoint: string,
  now = Date.now(),
): Promise<string> {
  const { publicKey, signKey: key } = await vapidKeys(env);
  const audience = new URL(endpoint).origin;
  const subject = `https://${env.APP_HOST}`;
  const cacheKey = JSON.stringify([audience, subject]);
  let cache = headersByKey.get(key);
  if (!cache) {
    cache = new Map();
    headersByKey.set(key, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached && now >= cached.created && now - cached.created < VAPID_REUSE_MS)
    return cached.value;
  if (!cached && cache.size >= MAX_VAPID_AUDIENCES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const value = signVapidHeader(key, publicKey, audience, subject, now);
  cache.set(cacheKey, { created: now, value });
  try {
    return await value;
  } catch (error) {
    if (cache.get(cacheKey)?.value === value) cache.delete(cacheKey);
    throw error;
  }
}

async function signVapidHeader(
  key: CryptoKey,
  publicKey: string,
  audience: string,
  subject: string,
  now: number,
) {
  const input = `${jwtPart({ typ: "JWT", alg: "ES256" })}.${jwtPart({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(input),
    ),
  );
  return `vapid t=${input}.${b64u(sig)}, k=${publicKey}`;
}

export type PushResult =
  | "sent"
  | "failed"
  | "unusable"
  | { status: number; providerBody: string };

// Providers can echo opaque credentials, registration URLs and recipient data in arbitrary
// fields or plain text. Retain public diagnostic words only, even for malformed/truncated JSON.
const diagnosticWords = new Set(
  (
    "reason error code message status errno detail details " +
    "BadAuthorizationHeader BadJwtToken BadVapidPublicKey BadTtl BadUrgency BadTopic BadPath " +
    "BadRequest BadWebPushRequest BadWebPushTopic DeviceTokenNotForTopic Unregistered " +
    "BadDeviceToken ExpiredProviderToken InvalidProviderToken TooManyProviderTokenUpdates " +
    "TooManyRequests PayloadTooLarge MethodNotAllowed IdleTimeout InternalServerError ServiceUnavailable Shutdown " +
    "InvalidRegistration NotRegistered UNREGISTERED INVALID_ARGUMENT UNAUTHENTICATED PERMISSION_DENIED " +
    "THIRD_PARTY_AUTH_ERROR SENDER_ID_MISMATCH QUOTA_EXCEEDED UNAVAILABLE INTERNAL " +
    "UnauthorizedRegistration Unauthorized Forbidden Gone Not Found invalid expired subscription " +
    "VAPID JWT authorization authentication header public key audience subject token endpoint " +
    "push request payload is has been no longer valid missing mismatch does not match too many requests"
  )
    .toLowerCase()
    .split(/\s+/),
);

async function providerErrorPreview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  // 200 Unicode code points occupy at most 800 UTF-8 bytes.
  const bytes = new Uint8Array(800);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const prefix = value.subarray(0, bytes.length - length);
      bytes.set(prefix, length);
      length += prefix.length;
    }
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => {});
  }
  const prefix = Array.from(new TextDecoder().decode(bytes.subarray(0, length)))
    .slice(0, 200)
    .join("");
  return prefix
    .replace(/[^\s"{}[\],:]+/gu, (word) =>
      diagnosticWords.has(word.toLowerCase()) ? word : "[redacted]",
    )
    .replace(/\s+/gu, " ")
    .slice(0, 200);
}

/** How long the push service may hold a message for an offline browser. */
const TTL_SECONDS = 4 * 3600;
const SEND_TIMEOUT_MS = 8000;

/**
 * Sends one encrypted message. HTTP errors include a redacted provider diagnostic.
 * The caller removes subscriptions with unusable keys or a 404/410 response.
 */
export async function sendPush(
  env: Env,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { tag: string },
  now = Date.now(),
): Promise<PushResult> {
  if (!pushEndpointOk(sub.endpoint)) return "failed";
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await encryptPayload(
      unb64u(sub.p256dh),
      unb64u(sub.auth),
      enc.encode(JSON.stringify(payload)),
    );
  } catch {
    // Keys we can't encrypt to: this subscription can never be sent to.
    return "unusable";
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: {
        authorization: await vapidHeader(env, sub.endpoint, now),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_SECONDS),
        urgency: "high",
        // By kind, so an Updates push can't replace a waiting Needs-you one.
        topic: payload.tag,
      },
      body,
    });
    if (r.ok) return "sent";
    return { status: r.status, providerBody: await providerErrorPreview(r) };
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
