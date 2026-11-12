/** Passkey approval of dangerous asks (#2263): WebAuthn helpers and the card's error states. */
import { ApiClientError } from "../../api/client";

const fromB64 = (s: string): ArrayBuffer => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64 = (buf: ArrayBuffer | null): string => {
  let s = "";
  for (const b of new Uint8Array(buf ?? new ArrayBuffer(0)))
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Json = Record<string, unknown>;

/** PublicKeyCredentialRequestOptionsJSON to the binary options navigator.credentials.get takes. */
export function decodeRequestOptions(
  o: Json,
): PublicKeyCredentialRequestOptions {
  const parse = (
    PublicKeyCredential as unknown as {
      parseRequestOptionsFromJSON?: (
        j: Json,
      ) => PublicKeyCredentialRequestOptions;
    }
  ).parseRequestOptionsFromJSON;
  if (typeof parse === "function") return parse.call(PublicKeyCredential, o);
  const allow = (o.allowCredentials as Json[] | undefined)?.map((c) => ({
    ...c,
    id: fromB64(String(c.id)),
  }));
  return {
    ...o,
    challenge: fromB64(String(o.challenge)),
    ...(allow ? { allowCredentials: allow } : {}),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/** A WebAuthn assertion as AuthenticationResponseJSON. */
export function assertionToJSON(cred: PublicKeyCredential): Json {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      ...(r.userHandle ? { userHandle: toB64(r.userHandle) } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
  };
}

export type PasskeyFailure =
  | { kind: "cancelled" }
  | { kind: "failed" }
  | { kind: "expired" }
  | { kind: "no_passkey" }
  | { kind: "cooling"; until: string | null }
  | { kind: "other" };

/** Which card state an error from the passkey flow belongs to. */
export function passkeyFailure(e: unknown): PasskeyFailure {
  if (e instanceof ApiClientError) {
    if (e.code === "no_passkey") return { kind: "no_passkey" };
    if (e.code === "passkey_cooling") {
      const u = (e.details as { until?: unknown } | undefined)?.until;
      return { kind: "cooling", until: typeof u === "string" ? u : null };
    }
    if (e.code === "passkey_failed" || e.code === "passkey_required")
      return { kind: "failed" };
    if (e.code === "challenge_expired") return { kind: "expired" };
    return { kind: "other" };
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError")
    return { kind: "cancelled" };
  if (name === "NotSupportedError" || name === "SecurityError")
    return { kind: "failed" };
  return { kind: "other" };
}

/** Copy for a passkey failure, or null when the ordinary answer error copy applies. */
export function passkeyCopy(f: PasskeyFailure): string | null {
  switch (f.kind) {
    case "cancelled":
      return "Passkey approval was cancelled.";
    case "failed":
      return "The passkey didn't check out.";
    case "expired":
      return "That approval timed out.";
    case "no_passkey":
      return "Add a passkey to approve this here. Or the agent can ask in its own terminal.";
    case "cooling": {
      const t = f.until ? new Date(f.until) : null;
      return t && !Number.isNaN(t.getTime())
        ? `Your new passkey can approve from ${t.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`
        : "Your new passkey can't approve yet.";
    }
    default:
      return null;
  }
}

/** Failures worth a Retry button. */
export const canRetry = (f: PasskeyFailure) =>
  f.kind === "cancelled" || f.kind === "failed" || f.kind === "expired";
