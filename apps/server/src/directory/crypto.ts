import { authConfig } from "../auth/config.js";
import { directoryKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { b64urlDecode, b64urlEncode } from "../util/crypto.js";

// The directory refresh token at rest (P3 T12). AES-GCM under the key derived
// from DIRECTORY_TOKEN_KEY, a random 96-bit IV per seal, and additional data
// `install_id + ":" + key_version`, so a sealed token copied to another
// install (or read back under another key version) never opens. Format:
// `<version>.<base64url(iv || ciphertext)>`. Nothing here is ever logged.

const enc = new TextEncoder();
const dec = new TextDecoder();
const IV_BYTES = 12;
const VERSION_RE = /^[A-Za-z0-9_-]{1,16}$/;

/** DIRECTORY_TOKEN_KEY_VERSION, default "1". */
export function keyVersion(env: Env): string {
  const v = env.DIRECTORY_TOKEN_KEY_VERSION?.trim() || "1";
  if (!VERSION_RE.test(v))
    throw new Error("DIRECTORY_TOKEN_KEY_VERSION is malformed");
  return v;
}

/** The install half of the AD: INSTALL_ID, else APP_HOST (authConfig.installKey). */
const installOf = (env: Env) => authConfig(env).installKey;

const additionalData = (env: Env, version: string) =>
  enc.encode(`${installOf(env)}:${version}`);

const aesKeys = new Map<string, Promise<CryptoKey>>();
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await directoryKey(env);
  let k = aesKeys.get(raw);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      b64urlDecode(raw) ?? new Uint8Array(),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    k.catch(() => aesKeys.delete(raw));
    aesKeys.set(raw, k);
  }
  return k;
}

/** Seals `token` for this install under the current key version. */
export async function seal(env: Env, token: string): Promise<string> {
  const version = keyVersion(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(env, version) },
    await aesKey(env),
    enc.encode(token),
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), IV_BYTES);
  return `${version}.${b64urlEncode(out)}`;
}

/**
 * Opens a sealed token. Throws on any mismatch: another install, another key
 * version than the current one, a tampered blob, or a missing key.
 */
export async function open(env: Env, sealed: string): Promise<string> {
  const version = keyVersion(env);
  const dot = sealed.indexOf(".");
  const raw = dot > 0 ? b64urlDecode(sealed.slice(dot + 1)) : null;
  if (!raw || raw.length <= IV_BYTES || sealed.slice(0, dot) !== version)
    throw new Error("directory token: unreadable");
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw.slice(0, IV_BYTES),
        additionalData: additionalData(env, version),
      },
      await aesKey(env),
      raw.slice(IV_BYTES),
    );
    return dec.decode(pt);
  } catch {
    throw new Error("directory token: unreadable");
  }
}
