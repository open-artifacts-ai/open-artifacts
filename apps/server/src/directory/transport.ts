import { GOOGLE_ISSUERS } from "@oa/auth-core";
import { authConfig, isEd25519Pkcs8 } from "../auth/config.js";
import { MIN_DIRECTORY_KEY_LENGTH } from "../auth/keys.js";
import type { Env } from "../env.js";
import { b64urlDecode } from "../util/crypto.js";

// How this install reaches Google for directory sync (P3 T12; mirrors P2's
// GoogleTransport):
// - broker (hosted): the directory broker (apps/directory-broker, its own
//   Worker on directory.<app domain>, DIRECTORY_BROKER_URL) holds the directory client
//   secret, runs the consent redirect and the code exchange and refresh. The
//   install keeps only the sealed refresh token.
// - direct (self-host without our broker): the install's own Google app
//   (GOOGLE_DIRECTORY_CLIENT_ID/SECRET) does the exchange and refresh itself.
// - none: no directory. HOSTED=1 may only tighten: a hosted install with the
//   direct variables set, or without a broker, resolves here (fail closed).
// Everything after completeConsent (sealing, the callback checks, the
// binding, sync) is shared code.

export type DirectoryTransport =
  | {
      kind: "broker";
      brokerUrl: string;
      installId: string;
      signingKey: string;
    }
  | { kind: "direct"; clientId: string; secret: string }
  | { kind: "none"; problem: string };

export const HOSTED_NEEDS_BROKER =
  "hosted installs use the broker for directory sync";

const nonEmpty = (v: string | undefined): v is string =>
  typeof v === "string" && v.trim() !== "";

function resolve(env: Env): DirectoryTransport {
  const none = (problem: string) => ({ kind: "none", problem }) as const;
  const directSet =
    nonEmpty(env.GOOGLE_DIRECTORY_CLIENT_ID) ||
    nonEmpty(env.GOOGLE_DIRECTORY_CLIENT_SECRET);
  // Fail closed: a hosted install never holds a Google client secret.
  if (env.HOSTED === "1" && (directSet || !nonEmpty(env.DIRECTORY_BROKER_URL)))
    return none(HOSTED_NEEDS_BROKER);
  if (!nonEmpty(env.DIRECTORY_BROKER_URL) && !directSet)
    return none("directory sync is not configured");
  if (
    typeof env.DIRECTORY_TOKEN_KEY !== "string" ||
    env.DIRECTORY_TOKEN_KEY.length < MIN_DIRECTORY_KEY_LENGTH
  )
    return none("DIRECTORY_TOKEN_KEY is not set (32+ characters)");
  if (authConfig(env).domains.length === 0)
    return none("AUTH_DOMAINS is empty");
  if (nonEmpty(env.DIRECTORY_BROKER_URL)) {
    let url: URL;
    try {
      url = new URL(env.DIRECTORY_BROKER_URL);
    } catch {
      return none("DIRECTORY_BROKER_URL is not a URL");
    }
    if (url.protocol !== "https:")
      return none("DIRECTORY_BROKER_URL must be https");
    if (!nonEmpty(env.INSTALL_ID)) return none("INSTALL_ID is empty");
    if (
      !nonEmpty(env.BROKER_SIGNING_KEY) ||
      !isEd25519Pkcs8(env.BROKER_SIGNING_KEY)
    )
      return none("BROKER_SIGNING_KEY is not a PKCS#8 Ed25519 key");
    return {
      kind: "broker",
      brokerUrl: url.origin,
      installId: env.INSTALL_ID.trim(),
      signingKey: env.BROKER_SIGNING_KEY,
    };
  }
  if (
    !nonEmpty(env.GOOGLE_DIRECTORY_CLIENT_ID) ||
    !nonEmpty(env.GOOGLE_DIRECTORY_CLIENT_SECRET)
  )
    return none(
      "GOOGLE_DIRECTORY_CLIENT_ID and GOOGLE_DIRECTORY_CLIENT_SECRET are both required",
    );
  return {
    kind: "direct",
    clientId: env.GOOGLE_DIRECTORY_CLIENT_ID.trim(),
    secret: env.GOOGLE_DIRECTORY_CLIENT_SECRET,
  };
}

const memo = new WeakMap<Env, DirectoryTransport>();

/** The directory transport for this env, resolved once per env object. */
export function directoryTransport(env: Env): DirectoryTransport {
  let t = memo.get(env);
  if (!t) {
    t = resolve(env);
    memo.set(env, t);
  }
  return t;
}

/** What a completed consent hands to the shared checks. */
export type ConsentResult = {
  refreshToken: string;
  /** The access token from the same exchange, for the callback's checks. */
  accessToken: string;
  /** The token response's space-separated `scope`. */
  grantedScopes: string;
  /** The consenting account's Google id (users.get key). */
  sub: string;
  /** Its Workspace domain claim, or null when absent. */
  hd: string | null;
};

/** The callback's inputs to completeConsent. */
export type ConsentCallback = {
  code: string;
  verifier: string;
  /** The broker's own state, relayed back (broker transport). */
  bstate?: string;
};

/**
 * Why a transport call failed; `stage` is safe to log. `refused`: the
 * broker refused the request (signature, state, flow); `invalid_grant`:
 * Google revoked the grant (T13 marks auth_failed); `broker_unavailable`:
 * a hosted install with no binding and no DIRECTORY_BROKER capability in this
 * invocation (auth/broker-transport.ts); `gate_refused`: the platform's
 * BrokerGate refused the request before the broker saw it (never a 401);
 * `gate_stale`: the runtime refused a capability used past its invocation
 * (nothing sent; feedSync hands nothing over and the next tick retries);
 * `exchange`: anything else.
 */
export class TransportError extends Error {
  constructor(
    public stage:
      | "refused"
      | "invalid_grant"
      | "exchange"
      | "broker_unavailable"
      | "gate_refused"
      | "gate_stale",
  ) {
    super(`directory transport: ${stage}`);
    this.name = "TransportError";
  }
}

/** One interface for both kinds (broker.ts, direct.ts). */
export interface DirectoryClient {
  kind: "broker" | "direct";
  /** Where GET R.directoryConnect sends the browser. */
  beginConsent(a: { state: string; challenge: string; hd: string }): string;
  completeConsent(cb: ConsentCallback): Promise<ConsentResult>;
  /** A fresh access token for the sealed refresh token (T13 polling). */
  accessToken(sealedRefresh: string): Promise<string>;
  /** Revokes the grant behind the sealed refresh token at Google. Throws TransportError. */
  revoke(sealedRefresh: string): Promise<void>;
}

/**
 * sub and hd from the ID token of a code exchange. The token comes straight
 * from Google's token endpoint over TLS (direct), or from the authenticated
 * broker that fetched it so (OIDC Core 3.1.3.7), so the claims are read
 * without a JWKS round trip; iss, exp and (direct only) aud are still
 * checked. Throws TransportError("exchange") on anything malformed.
 */
export function idClaims(
  idToken: string,
  aud: string | null,
  now = Date.now(),
): { sub: string; hd: string | null } {
  const bad = () => new TransportError("exchange");
  const part = idToken.split(".")[1];
  const raw = part ? b64urlDecode(part) : null;
  if (!raw) throw bad();
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  if (
    !c ||
    typeof c.sub !== "string" ||
    !c.sub ||
    !(GOOGLE_ISSUERS as readonly unknown[]).includes(c.iss) ||
    typeof c.exp !== "number" ||
    c.exp * 1000 < now - 60_000 ||
    (aud !== null && c.aud !== aud)
  )
    throw bad();
  return { sub: c.sub, hd: typeof c.hd === "string" ? c.hd : null };
}

/** The code-exchange JSON both transports return, checked for shape. */
export function grantOf(out: unknown, aud: string | null): ConsentResult {
  const o = out as Record<string, unknown> | null;
  if (
    !o ||
    typeof o.refresh_token !== "string" ||
    typeof o.access_token !== "string" ||
    typeof o.id_token !== "string"
  )
    throw new TransportError("exchange");
  return {
    refreshToken: o.refresh_token,
    accessToken: o.access_token,
    grantedScopes: typeof o.scope === "string" ? o.scope : "",
    ...idClaims(o.id_token, aud),
  };
}
