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
  | { kind: "too_many" }
  /** The ask already has an answer: the refetch shows it. */
  | { kind: "answered" }
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
    if (e.code === "already_answered") return { kind: "answered" };
    if (e.code === "rate_limited") return { kind: "too_many" };
    return { kind: "other" };
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError")
    return { kind: "cancelled" };
  if (name === "NotSupportedError" || name === "SecurityError")
    return { kind: "failed" };
  return { kind: "other" };
}

const WEEK = 7 * 24 * 3600_000;

/** When a cooling passkey can approve, in the viewer's local time: weekday and time under 7 days, else the date. `title` is always the full date. */
export function coolingTime(
  until: string | null,
  now = Date.now(),
): { text: string; title: string } | null {
  const t = until ? new Date(until) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  const title = t.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
  const text =
    t.getTime() - now < WEEK
      ? `${t.toLocaleDateString([], { weekday: "short" })} ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`
      : t.toLocaleDateString([], { dateStyle: "medium" });
  return { text, title };
}

/** The inline line for a passkey failure (role=alert), or null for the box states and ordinary errors. */
export function passkeyLine(
  f: PasskeyFailure,
): { text: string; danger: boolean } | null {
  switch (f.kind) {
    case "cancelled":
      return { text: "Nothing was approved.", danger: false };
    case "failed":
      return {
        text: "Passkey check failed. Nothing was approved.",
        danger: true,
      };
    case "expired":
      return {
        text: "That approval timed out. Nothing was approved.",
        danger: true,
      };
    case "too_many":
      return { text: "Too many tries. Wait a moment.", danger: true };
    case "answered":
      return { text: "This ask was already answered.", danger: false };
    default:
      return null;
  }
}
