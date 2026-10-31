// Sealed delivery of redline_creds (design v7 10.1, R26): the credentials
// are encrypted to the caller's ephemeral X25519 public key, so jobs.sealed
// (and D1) never holds a plaintext credential. ECDH with a fresh ephemeral
// key, HKDF-SHA256 over (ephemeral public key || recipient key), AES-256-GCM.
// Wire form: `oa-seal-v1.<epk>.<iv>.<ciphertext>`, each base64url.
const PREFIX = "oa-seal-v1";
const INFO = new TextEncoder().encode("oa-redline-creds-v1");

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const X25519 = { name: "X25519" } as const;

async function aesKey(
  shared: ArrayBuffer,
  epk: Uint8Array<ArrayBuffer>,
  recipient: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const salt = new Uint8Array(new ArrayBuffer(epk.length + recipient.length));
  salt.set(epk, 0);
  salt.set(recipient, epk.length);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** `plaintext` sealed to a raw 32-byte X25519 public key (base64url). */
export async function sealTo(
  recipientKey: string,
  plaintext: string,
): Promise<string> {
  const recipient = fromB64u(recipientKey);
  if (recipient.length !== 32)
    throw new Error("the recipient key is not 32 bytes");
  const pub = await crypto.subtle.importKey("raw", recipient, X25519, false, []);
  const eph = (await crypto.subtle.generateKey(X25519, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer,
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    eph.privateKey,
    256,
  );
  const key = await aesKey(shared, epk, recipient, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${PREFIX}.${b64u(epk)}.${b64u(iv)}.${b64u(ct)}`;
}

/** Opens a sealed value with the recipient's X25519 key pair (the caller's side). */
export async function openSealed(
  recipient: CryptoKeyPair,
  sealed: string,
): Promise<string> {
  const [p, e, i, c, ...rest] = sealed.split(".");
  if (p !== PREFIX || !e || !i || !c || rest.length)
    throw new Error("not an oa-seal-v1 value");
  const epk = fromB64u(e);
  const pub = await crypto.subtle.importKey("raw", epk, X25519, false, []);
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    recipient.privateKey,
    256,
  );
  const mine = new Uint8Array(
    (await crypto.subtle.exportKey("raw", recipient.publicKey)) as ArrayBuffer,
  );
  const key = await aesKey(shared, epk, mine, "decrypt");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64u(i) },
    key,
    fromB64u(c),
  );
  return new TextDecoder().decode(pt);
}
