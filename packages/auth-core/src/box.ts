// Tokens encrypted to the requesting install (P3 directory broker). The
// install sends a fresh X25519 public key inside its signed token request;
// the broker answers with the grant sealed to that key only:
//   shared = X25519(broker ephemeral, install ephemeral)
//   key    = HKDF-SHA256(shared, salt = installPub || brokerPub,
//                        info = "oa-dir-box-v1|" + installId), AES-256-GCM
//   AD     = "oa-dir-box-v1|" + installId + "|" + kid
// The install's private half never leaves the request that made it, so a
// relayed or logged response is useless to anyone else, and a box for one
// install (or key id) never opens as another's.

const enc = new TextEncoder();
const dec = new TextDecoder();
const X = { name: "X25519" } as const;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
};

export type Box = { epk: string; iv: string; ct: string };

/** A fresh X25519 key pair; `pub` is the raw 32 bytes, base64url. */
export async function boxKeyPair(): Promise<{
  pub: string;
  privateKey: CryptoKey;
}> {
  const kp = (await crypto.subtle.generateKey(X, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
  );
  return { pub: b64(raw), privateKey: kp.privateKey };
}

const label = (installId: string) => `oa-dir-box-v1|${installId}`;

async function aesKey(
  privateKey: CryptoKey,
  peer: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  installId: string,
  use: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("raw", peer, X, false, []);
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: pub },
    privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: enc.encode(label(installId)),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [use],
  );
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Broker side: seals `plaintext` to the install's `recipient` key. Throws on a malformed key. */
export async function sealToInstall(
  recipient: string,
  installId: string,
  kid: string,
  plaintext: string,
): Promise<Box> {
  const peer = unb64(recipient);
  if (!peer || peer.length !== 32) throw new Error("box: bad recipient key");
  const mine = await boxKeyPair();
  const minePub = unb64(mine.pub) as Uint8Array<ArrayBuffer>;
  const key = await aesKey(
    mine.privateKey,
    peer,
    concat(peer, minePub),
    installId,
    "encrypt",
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: enc.encode(`${label(installId)}|${kid}`),
    },
    key,
    enc.encode(plaintext),
  );
  return { epk: mine.pub, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Install side: opens a box sealed to `self`. Throws on any mismatch. */
export async function openFromBroker(
  self: { pub: string; privateKey: CryptoKey },
  installId: string,
  kid: string,
  box: Box,
): Promise<string> {
  const peer = typeof box?.epk === "string" ? unb64(box.epk) : null;
  const iv = typeof box?.iv === "string" ? unb64(box.iv) : null;
  const ct = typeof box?.ct === "string" ? unb64(box.ct) : null;
  const mine = unb64(self.pub);
  if (!peer || peer.length !== 32 || !iv || iv.length !== 12 || !ct || !mine)
    throw new Error("box: malformed");
  const key = await aesKey(
    self.privateKey,
    peer,
    concat(mine, peer),
    installId,
    "decrypt",
  );
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: enc.encode(`${label(installId)}|${kid}`),
    },
    key,
    ct,
  );
  return dec.decode(pt);
}
