// The signed redeem request for the auth broker (POST /google/redeem), shared
// by the server's hosted Google transport and the Provisioning API's admin
// sign-in (design v7 4.3 step 3), so both sign exactly alike.
import { flowHash, keyId, publicFromPkcs8, signRedeem } from "./ed25519.js";

export type BrokerSigner = {
  /** The broker origin (https://auth.<hosted>). */
  url: string;
  installId: string;
  /** Ed25519 PKCS#8, base64url. */
  signingKey: string;
};

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The PKCE S256 challenge of `verifier`. */
export const pkceChallenge = async (verifier: string) =>
  b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

const kids = new Map<string, Promise<string>>();
/** The signer's key id: derived from its public key, never configured (N3). */
const kidOf = (signingKey: string) => {
  let k = kids.get(signingKey);
  if (!k) {
    k = publicFromPkcs8(signingKey).then(keyId);
    k.catch(() => kids.delete(signingKey));
    kids.set(signingKey, k);
  }
  return k;
};

export async function brokerRedeemRequest(
  t: BrokerSigner,
  a: { code: string; verifier: string; nonce: string; bstate?: string },
  now: number = Date.now(),
): Promise<Request> {
  const body = JSON.stringify({
    install: t.installId,
    code: a.code,
    verifier: a.verifier,
    ts: now,
    // The broker refuses unless its state binds this exact flow.
    bstate: a.bstate ?? "",
    h: await flowHash(a.nonce, await pkceChallenge(a.verifier)),
  });
  const kid = await kidOf(t.signingKey);
  return new Request(`${t.url}/google/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig": await signRedeem(t.signingKey, kid, body),
    },
    body,
    redirect: "manual",
  });
}
