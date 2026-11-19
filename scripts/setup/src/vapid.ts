/** A fresh VAPID pair for Web Push: public = uncompressed P-256 point, private = scalar, both base64url. */
export async function generateVapidPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  return {
    publicKey: raw.toString("base64url"),
    privateKey: jwk.d as string,
  };
}
