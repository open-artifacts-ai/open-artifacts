// WebAuthn JSON helpers (#2263): the server speaks the JSON forms of the
// options and the credential; the browser wants ArrayBuffers. Use the
// browser's own parse/toJSON when it has them, else do the base64url by hand.

type Json = Record<string, unknown>;
type Bytes = Uint8Array<ArrayBuffer>;

export function b64urlToBytes(s: string): Bytes {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const u =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Desc = Json & { id: string };
const descriptors = (list: unknown): PublicKeyCredentialDescriptor[] =>
  Array.isArray(list)
    ? (list as Desc[]).map(
        (d) =>
          ({
            ...d,
            id: b64urlToBytes(d.id),
          }) as unknown as PublicKeyCredentialDescriptor,
      )
    : [];

type Statics = {
  parseCreationOptionsFromJSON?: (
    j: Json,
  ) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (j: Json) => PublicKeyCredentialRequestOptions;
};
const statics = (): Statics =>
  (typeof PublicKeyCredential === "undefined"
    ? {}
    : PublicKeyCredential) as unknown as Statics;

export function decodeCreationOptions(
  json: Json,
): PublicKeyCredentialCreationOptions {
  const native = statics().parseCreationOptionsFromJSON;
  if (native) return native.call(PublicKeyCredential, json);
  const user = json.user as Json & { id: string };
  return {
    ...json,
    challenge: b64urlToBytes(json.challenge as string),
    user: { ...user, id: b64urlToBytes(user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function decodeRequestOptions(
  json: Json,
): PublicKeyCredentialRequestOptions {
  const native = statics().parseRequestOptionsFromJSON;
  if (native) return native.call(PublicKeyCredential, json);
  return {
    ...json,
    challenge: b64urlToBytes(json.challenge as string),
    allowCredentials: descriptors(json.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

const enc = (b: ArrayBuffer | null | undefined) =>
  b ? bytesToB64url(b) : undefined;

/** PublicKeyCredential.toJSON(), or the same shape built by hand. */
export function credentialToJSON(c: PublicKeyCredential): Json {
  const native = (c as unknown as { toJSON?: () => Json }).toJSON;
  if (typeof native === "function") return native.call(c);
  const r = c.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const response: Json = { clientDataJSON: enc(r.clientDataJSON) };
  if ("attestationObject" in r && r.attestationObject) {
    response.attestationObject = enc(r.attestationObject);
    const t = (r as { getTransports?: () => string[] }).getTransports?.();
    if (t) response.transports = t;
  } else {
    response.authenticatorData = enc(r.authenticatorData);
    response.signature = enc(r.signature);
    const h = enc(r.userHandle);
    if (h) response.userHandle = h;
  }
  return {
    id: c.id,
    rawId: enc(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: c.getClientExtensionResults(),
    ...(c.authenticatorAttachment
      ? { authenticatorAttachment: c.authenticatorAttachment }
      : {}),
  };
}

/** The member dismissed or timed out the browser's passkey prompt. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PasskeyCancelled";
  }
}

const wrap = async (run: () => Promise<Credential | null>) => {
  let c: Credential | null;
  try {
    c = await run();
  } catch (e) {
    if (
      e instanceof DOMException &&
      ["NotAllowedError", "AbortError"].includes(e.name)
    )
      throw new PasskeyCancelled();
    throw e;
  }
  if (!c) throw new PasskeyCancelled();
  return credentialToJSON(c as PublicKeyCredential);
};

/** Create a passkey from the server's creation options (JSON). */
export const createCredential = (options: Json) =>
  wrap(() =>
    navigator.credentials.create({ publicKey: decodeCreationOptions(options) }),
  );

/** Get an assertion for the server's request options (JSON). */
export const getAssertion = (options: Json) =>
  wrap(() =>
    navigator.credentials.get({ publicKey: decodeRequestOptions(options) }),
  );

/** The URL only if it stays on this site (relative, or this origin); else null. */
export function sameOriginUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url || url.startsWith("//")) return null;
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}

/** Leave this page for a same-origin URL (a seam for tests). */
export const redirectTo = (url: string) => location.assign(url);

/** "Fri 3:04 PM": a time in the member's own zone, with its weekday. */
export const coolingTime = (iso: string | number | Date) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
