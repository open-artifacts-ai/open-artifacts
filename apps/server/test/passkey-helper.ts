import { b64urlEncode } from "../src/util/crypto.js";

// A software WebAuthn authenticator for tests: ES256, user verification on.

const enc = new TextEncoder();

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  return [(major << 5) | 25, n >> 8, n & 255];
}
type C = number | string | Uint8Array | C[] | Map<C, C>;
function cbor(v: C): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  return [
    ...head(5, v.size),
    ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)]),
  ];
}
export const cborBytes = (v: C) => new Uint8Array(cbor(v));

const sha256 = async (d: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", d));

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = [...b.slice(i)];
    if ((v[0] as number) & 0x80) v = [0, ...v];
    return [2, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export type Opts = {
  challenge: string;
  origin: string;
  rpId: string;
  /** Override pieces to build a bad response. */
  type?: string;
  uv?: boolean;
  up?: boolean;
  signCount?: number;
  rpIdOverride?: string;
  originOverride?: string;
  challengeOverride?: string;
};

export class FakeAuthenticator {
  signCount = 0;
  private constructor(
    private keys: CryptoKeyPair,
    readonly credentialId: string,
    private x: Uint8Array,
    private y: Uint8Array,
  ) {}

  static async create(): Promise<FakeAuthenticator> {
    const keys = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const dec = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
    return new FakeAuthenticator(
      keys,
      b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      dec(jwk.x as string),
      dec(jwk.y as string),
    );
  }

  private async authData(o: Opts, withKey: boolean): Promise<Uint8Array> {
    const rp = await sha256(enc.encode(o.rpIdOverride ?? o.rpId));
    const flags =
      (o.up === false ? 0 : 1) |
      (o.uv === false ? 0 : 4) |
      (withKey ? 0x40 : 0);
    const n = o.signCount ?? this.signCount;
    const base = [
      ...rp,
      flags,
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
    ];
    if (!withKey) return new Uint8Array(base);
    const id = Uint8Array.from(
      atob(this.credentialId.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const cose = cborBytes(
      new Map<C, C>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    return new Uint8Array([
      ...base,
      ...new Uint8Array(16),
      id.length >> 8,
      id.length & 255,
      ...id,
      ...cose,
    ]);
  }

  private clientData(o: Opts, type: string): Uint8Array<ArrayBuffer> {
    return enc.encode(
      JSON.stringify({
        type: o.type ?? type,
        challenge: o.challengeOverride ?? o.challenge,
        origin: o.originOverride ?? o.origin,
        crossOrigin: false,
      }),
    );
  }

  /** navigator.credentials.create() as JSON. */
  async attest(o: Opts) {
    const att = cborBytes(
      new Map<C, C>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", await this.authData(o, true)],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(this.clientData(o, "webauthn.create")),
        attestationObject: b64urlEncode(att),
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() as JSON. Bumps the counter unless `signCount` is set. */
  async assert(o: Opts) {
    if (o.signCount === undefined) this.signCount += 1;
    const authData = await this.authData(o, false);
    const cd = this.clientData(o, "webauthn.get");
    const signed = new Uint8Array([...authData, ...(await sha256(cd))]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        signed,
      ),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(cd),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(rawToDer(raw)),
      },
      clientExtensionResults: {},
    };
  }
}
