// Install-to-broker request signing (hosted Google transport). Each install
// holds an Ed25519 private key (PKCS#8, base64url); the broker's registry
// holds only public keys (raw 32 bytes, base64url) and their key ids.

const b64 = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  },
};

const ED = { name: "Ed25519" } as const;
const enc = new TextEncoder();

function bytesOf(s: string, what: string): Uint8Array<ArrayBuffer> {
  const b = b64.dec(s);
  if (!b) throw new Error(`${what} is not base64url`);
  return b;
}

/** The raw public key (`x`, base64url) of a PKCS#8 Ed25519 private key. */
export async function publicFromPkcs8(pkcs8: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "pkcs8",
    bytesOf(pkcs8, "private key"),
    ED,
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", k)) as JsonWebKey;
  if (!jwk.x) throw new Error("no public key");
  return jwk.x;
}

/**
 * The key id the registry stores and the install sends (X-OA-Kid): the first
 * 16 characters of base64url(SHA-256(raw public key)). Derived, never
 * configured, so it can't drift from the key on rotation.
 */
export async function keyId(x: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytesOf(x, "public key"));
  return b64.enc(new Uint8Array(d)).slice(0, 16);
}

/**
 * The exact bytes an install signs for a redeem, so a signature can never be
 * transplanted to another route or key id: the method, path, the kid the
 * broker will look up, then the body. Both sides build it from what they send.
 */
export function redeemTranscript(kid: string, body: string): string {
  return requestTranscript("/google/redeem", kid, body);
}

/**
 * The same transcript for any signed broker POST: the path is covered, so a
 * signature for one route (a sign-in redeem) never verifies on another (the
 * directory token exchange), and vice versa.
 */
export function requestTranscript(
  path: string,
  kid: string,
  body: string,
): string {
  return `oa-redeem-v1\nPOST\n${path}\n${kid}\n${body}`;
}

/** Signs the redeem transcript; base64url signature (X-OA-Sig). */
export function signRedeem(
  pkcs8: string,
  kid: string,
  body: string,
): Promise<string> {
  return signRequest(pkcs8, "/google/redeem", kid, body);
}

/** Signs requestTranscript(path, kid, body); base64url signature (X-OA-Sig). */
export function signRequest(
  pkcs8: string,
  path: string,
  kid: string,
  body: string,
): Promise<string> {
  return signTranscript(pkcs8, requestTranscript(path, kid, body));
}

/**
 * Signs exactly `transcript`'s UTF-8 bytes; base64url signature. The caller's
 * transcript carries its own domain-separation prefix (`oa-redeem-v1`,
 * `oa-broker-ticket-v1`).
 */
export async function signTranscript(
  pkcs8: string,
  transcript: string,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "pkcs8",
    bytesOf(pkcs8, "private key"),
    ED,
    false,
    ["sign"],
  );
  return b64.enc(
    new Uint8Array(await crypto.subtle.sign(ED, k, enc.encode(transcript))),
  );
}

/** Verifies `sig` over the transcript for `kid`/`body`; false on any error. */
export function verifyRedeem(
  x: string,
  kid: string,
  body: string,
  sig: string,
): Promise<boolean> {
  return verifyRequest(x, "/google/redeem", kid, body, sig);
}

/** Verifies `sig` over requestTranscript(path, kid, body); false on any error. */
export function verifyRequest(
  x: string,
  path: string,
  kid: string,
  body: string,
  sig: string,
): Promise<boolean> {
  return verifyTranscript(x, requestTranscript(path, kid, body), sig);
}

/** Verifies `sig` over exactly `transcript`; false on any error. */
export async function verifyTranscript(
  x: string,
  transcript: string,
  sig: string,
): Promise<boolean> {
  try {
    const raw = b64.dec(x);
    const s = b64.dec(sig);
    if (!raw || raw.length !== 32 || !s || s.length !== 64) return false;
    const k = await crypto.subtle.importKey("raw", raw, ED, false, ["verify"]);
    return await crypto.subtle.verify(ED, k, s, enc.encode(transcript));
  } catch {
    return false;
  }
}

/**
 * The nonce Google sees on the broker transport. Every hosted install shares
 * one Google client and redirect URI, so the nonce forwarded to Google is
 * derived from the install and the install's own (client) nonce: a token
 * minted through install A can never satisfy install B's nonce check even if
 * the attacker chose B's client nonce when starting A's flow. The install
 * keeps its client nonce in its state cookie and recomputes this at redeem.
 */
export async function brokerNonce(
  installId: string,
  clientNonce: string,
): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`oa-broker-v1|${installId}|${clientNonce}`),
  );
  return b64.enc(new Uint8Array(d));
}

/**
 * H(client nonce | code challenge): what the broker state binds on the broker
 * transport, and what the install proves it holds at redeem. A broker state
 * minted for one flow can't be redeemed with another flow's nonce/challenge.
 */
export async function flowHash(
  clientNonce: string,
  challenge: string,
): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`${clientNonce}|${challenge}`),
  );
  return b64.enc(new Uint8Array(d));
}
