// Stripe webhook signatures without the Stripe SDK. Stripe signs
// `${t}.${raw body}` with HMAC-SHA256 under the endpoint's signing secret
// (whsec_...) and sends `Stripe-Signature: t=<unix s>,v1=<hex>[,v1=...]`
// (v0 and other schemes are ignored). We accept when any v1 matches and t is
// within the tolerance of now, either way. The comparison is
// crypto.subtle.verify (constant time); a malformed v1 never matches.

/** Stripe's default tolerance: 5 minutes. */
export const STRIPE_TOLERANCE_S = 300;

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

const enc = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/;

function hexBytes(h: string): Uint8Array<ArrayBuffer> | null {
  if (!HEX.test(h)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The header's timestamp and v1 signatures, or null when malformed. */
export function parseSignatureHeader(
  header: string,
): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (!/^\d{1,12}$/.test(v) || t !== null) return null;
      t = Number(v);
    } else if (k === "v1") v1.push(v);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/**
 * Checks `Stripe-Signature` over the raw body text (exactly as received,
 * before any parsing). `nowMs` is the caller's clock.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceS = STRIPE_TOLERANCE_S,
): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(nowMs / 1000) - parsed.t) > toleranceS)
    return { ok: false, reason: "stale" };
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = enc.encode(`${parsed.t}.${rawBody}`);
  let match = false;
  // Every candidate is checked (no early exit on the first match).
  for (const h of parsed.v1) {
    const sig = hexBytes(h);
    if (sig && (await crypto.subtle.verify("HMAC", key, sig, data)))
      match = true;
  }
  return match
    ? { ok: true, timestamp: parsed.t }
    : { ok: false, reason: "mismatch" };
}

/** Test helper and Stripe CLI equivalent: the header for `rawBody` at `t` (seconds). */
export async function signStripePayload(
  rawBody: string,
  secret: string,
  t: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)),
  );
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}
