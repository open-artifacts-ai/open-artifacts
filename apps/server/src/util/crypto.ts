const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function getKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    k.catch(() => keys.delete(secret));
    keys.set(secret, k);
  }
  return k;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns null on malformed input. */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function hmacSign(key: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await getKey(key),
    enc.encode(data),
  );
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time via crypto.subtle.verify. */
export async function hmacVerify(
  key: string,
  data: string,
  sig: string,
): Promise<boolean> {
  const raw = b64urlDecode(sig);
  if (!raw || b64urlEncode(raw) !== sig) return false;
  return crypto.subtle.verify("HMAC", await getKey(key), raw, enc.encode(data));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Bearer key compare: SHA-256 both sides, then a constant-time loop over the
 * fixed-length digests, so neither the length nor a prefix leaks.
 */
export async function sameKey(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= (u[i] as number) ^ (v[i] as number);
  return d === 0;
}
