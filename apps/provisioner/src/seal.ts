// Sealed delivery of redline_creds (design v7 10.1, R26): the credentials
// are encrypted to the caller's ephemeral X25519 public key, so jobs.sealed
// (and D1) never holds a plaintext credential. ECDH with a fresh ephemeral
// key, HKDF-SHA256 over (ephemeral public key || recipient key), AES-256-GCM.
// Wire form: `oa-seal-v1.<epk>.<iv>.<ciphertext>`, each base64url.
const PREFIX = "oa-seal-v1";
/**
 * HKDF info, one per use: R26's redline creds (the default) and R28's test
 * admin sid (#1053), so a value sealed for one never opens as the other.
 */
export const SEAL_INFO = {
  redlineCreds: "oa-redline-creds-v1",
  testAdminSession: "oa-test-admin-session-v1",
} as const;
export type SealInfo = (typeof SEAL_INFO)[keyof typeof SEAL_INFO];

/**
 * The X25519 public keys of small order (libsodium's blocklist, top bit
 * cleared as X25519 ignores it): 0, 1, the order-8 points, p-1, p, p+1. A
 * shared secret from one is all zeros, so the sealed value would open for
 * anyone; it lands in a public log (R28), so such a key is refused outright.
 */
const LOW_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];
const hex = (u: Uint8Array) =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
/** True for a small-order X25519 public key (any value of its top bit). */
export function isLowOrderKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const k = Uint8Array.from(raw);
  k[31] = (k[31] ?? 0) & 0x7f;
  return LOW_ORDER.includes(hex(k));
}
const allZero = (b: ArrayBuffer) => new Uint8Array(b).every((x) => x === 0);

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
  info: SealInfo,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const salt = new Uint8Array(new ArrayBuffer(epk.length + recipient.length));
  salt.set(epk, 0);
  salt.set(recipient, epk.length);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode(info),
    },
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
  info: SealInfo = SEAL_INFO.redlineCreds,
): Promise<string> {
  const recipient = fromB64u(recipientKey);
  if (recipient.length !== 32)
    throw new Error("the recipient key is not 32 bytes");
  if (isLowOrderKey(recipient))
    throw new Error("the recipient key is a small-order point");
  const pub = await crypto.subtle.importKey(
    "raw",
    recipient,
    X25519,
    false,
    [],
  );
  const eph = (await crypto.subtle.generateKey(X25519, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer,
  );
  const shared = await crypto.subtle.deriveBits(
    {
      name: "X25519",
      public: pub,
    } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    eph.privateKey,
    256,
  );
  if (allZero(shared)) throw new Error("the shared secret is all zeros");
  const key = await aesKey(shared, epk, recipient, "encrypt", info);
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
  info: SealInfo = SEAL_INFO.redlineCreds,
): Promise<string> {
  const [p, e, i, c, ...rest] = sealed.split(".");
  if (p !== PREFIX || !e || !i || !c || rest.length)
    throw new Error("not an oa-seal-v1 value");
  const epk = fromB64u(e);
  const pub = await crypto.subtle.importKey("raw", epk, X25519, false, []);
  const shared = await crypto.subtle.deriveBits(
    {
      name: "X25519",
      public: pub,
    } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    recipient.privateKey,
    256,
  );
  const mine = new Uint8Array(
    (await crypto.subtle.exportKey("raw", recipient.publicKey)) as ArrayBuffer,
  );
  if (allZero(shared)) throw new Error("the shared secret is all zeros");
  const key = await aesKey(shared, epk, mine, "decrypt", info);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64u(i) },
    key,
    fromB64u(c),
  );
  return new TextDecoder().decode(pt);
}
