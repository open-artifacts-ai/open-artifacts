import type { Env } from "./env.js";

// Keyed hashes for audit and counters (design v7 4.9: no raw IPs, no raw
// emails outside sessions and agent_tokens): HMAC-SHA256(ADMIN_SESSION_KEY,
// value) truncated to 16 bytes, hex. One copy, so audit(), refuse() and the
// D1 counters agree on every value.

const keys = new Map<string, Promise<CryptoKey>>();
const keyOf = (secret: string) => {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keys.set(secret, k);
  }
  return k;
};

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmac16(
  env: Pick<Env, "ADMIN_SESSION_KEY">,
  value: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await keyOf(env.ADMIN_SESSION_KEY),
    new TextEncoder().encode(value),
  );
  return hex(sig.slice(0, 16));
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
