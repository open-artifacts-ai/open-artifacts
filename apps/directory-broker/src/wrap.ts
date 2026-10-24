// Refresh tokens bound to the install (manager ruling, #564). At the code
// exchange the broker never hands out Google's refresh token: it returns
//   v1.<base64url(iv || AES-256-GCM(key, refresh_token, AD))>
// with AD = "oa-dir-refresh-v1|" + installId and a random 96-bit IV. The key
// is HKDF-SHA256 over DIRECTORY_STATE_KEY with its own label, so there is no
// new secret and it can never verify as a state MAC. On refresh, the blob is
// unwrapped with the ASSERTING install's id in the AD: another install's
// blob, a raw Google token or anything tampered with won't open.
import { b64 } from "@oa/broker-core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = "v1";
const IV = 12;
const LABEL = "oa-dir-refresh-wrap-v1";
const ad = (installId: string) => enc.encode(`oa-dir-refresh-v1|${installId}`);

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(),
          info: enc.encode(LABEL),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    k.catch(() => keys.delete(secret));
    keys.set(secret, k);
  }
  return k;
}

const unb64 = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return Uint8Array.from(
      atob(s.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return null;
  }
};

/** Wraps Google's refresh token for `installId` only. */
export async function wrapRefresh(
  secret: string,
  installId: string,
  refreshToken: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad(installId) },
    await keyFor(secret),
    enc.encode(refreshToken),
  );
  const out = new Uint8Array(IV + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), IV);
  return `${VERSION}.${b64(out)}`;
}

/** The refresh token inside `blob`, or null unless it was wrapped for `installId`. */
export async function unwrapRefresh(
  secret: string,
  installId: string,
  blob: string,
): Promise<string | null> {
  const dot = blob.indexOf(".");
  if (dot < 0 || blob.slice(0, dot) !== VERSION) return null;
  const raw = unb64(blob.slice(dot + 1));
  if (!raw || raw.length <= IV) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw.slice(0, IV),
        additionalData: ad(installId),
      },
      await keyFor(secret),
      raw.slice(IV),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
