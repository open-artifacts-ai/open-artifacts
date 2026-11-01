// Small crypto helpers for sign-in, sessions and CSRF (design v7 4.3, 4.5).

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** `n` random bytes, base64url (32 bytes: 43 characters). */
export const randomToken = (n = 32): string =>
  b64url(crypto.getRandomValues(new Uint8Array(n)));

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (s: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));

const keys = new Map<string, Promise<CryptoKey>>();
const hmacKey = (secret: string) => {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    k.catch(() => keys.delete(secret));
    keys.set(secret, k);
  }
  return k;
};

export const hmac = async (secret: string, msg: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(msg)),
  );

/** HMAC-SHA256(secret, msg), base64url. */
export const hmacB64 = async (secret: string, msg: string) =>
  b64url(await hmac(secret, msg));

/**
 * HMAC-SHA256(secret, value) truncated to 16 bytes, hex: the counter keys'
 * form of an email or ipKey (4.7, 4.9: never the raw value).
 */
export const hmac16 = async (secret: string, value: string) =>
  hex((await hmac(secret, value)).slice(0, 16));

/** Constant-time string equality (lengths may leak; contents do not). */
export function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
