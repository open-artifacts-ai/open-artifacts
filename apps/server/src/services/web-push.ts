// #2512 S5: Web Push, with no dependency. The payload is encrypted as
// RFC 8291 (aes128gcm, RFC 8188) to the browser's key and the request is
// authorised with a VAPID JWT (RFC 8292, ES256), all through WebCrypto.
// The VAPID key pair is an instance secret (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY:
// base64url, the 65-byte uncompressed point and the 32-byte scalar). This
// code never makes a key: without both, push is off.
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

/** Push is on only when the instance holds a VAPID key pair. */
export const pushOn = (env: Env): boolean =>
  !!env.VAPID_PUBLIC_KEY?.trim() && !!env.VAPID_PRIVATE_KEY?.trim();

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
  const pub = unb64u(env.VAPID_PUBLIC_KEY?.trim() ?? "");
  const d = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (pub.length !== 65 || pub[0] !== 4 || !d) throw new Error("bad VAPID key");
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d,
      x: b64u(pub.slice(1, 33)),
      y: b64u(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const input = `${jwtPart({ typ: "JWT", alg: "ES256" })}.${jwtPart({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: `https://${env.APP_HOST}`,
  })}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(input),
    ),
  );
  return `vapid t=${input}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY?.trim()}`;
}

export type PushResult = "sent" | "gone" | "failed" | "unusable";

/** How long the push service may hold a message for an offline browser. */
const TTL_SECONDS = 4 * 3600;
const SEND_TIMEOUT_MS = 8000;

/**
 * Sends one encrypted message. A 404 or 410 is "gone" (the caller deletes the
 * subscription); any other refusal or error is "failed" (logged by the caller,
 * not retried). Refuses an endpoint that is not a known push service.
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
        urgency: "normal",
        // By kind, so an Updates push can't replace a waiting Needs-you one.
        topic: payload.tag,
      },
      body,
    });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.status >= 200 && r.status < 300 ? "sent" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
