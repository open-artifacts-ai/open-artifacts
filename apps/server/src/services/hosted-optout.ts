// The platform's hosted-wide opt-out list (#2652). On hosted, before each
// outside share email the install asks the platform whether the address is
// opted out (check) and gets a token for this email's unsubscribe link (mint).
// The contract (OA Platform, per OA Axe; shapes in @oa/provisioning-contract):
// - the install sends only h1 = HMAC(OPTOUT_HASH_KEY, address), never the
//   address, one hash per call, signed, with a fresh nonce;
// - the check is the source of truth on hosted and fails closed: no answer, no
//   email; a mint refused over the daily cap is no email either;
// - the link goes to the platform's public unsubscribe page; the install never
//   adds to the list itself;
// - a self-hosted install never calls any of it.
// It rides the platform's LoginGate (ctx.props.LOGIN). Off until the platform
// sets OPTOUT_PLATFORM=on on the install, so merging changes nothing on hosted.
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import {
  OPTOUT_CHECK_PATH,
  OPTOUT_MINT_PATH,
  OptoutCheckResponseSchema,
  OptoutMintResponseSchema,
} from "@oa/provisioning-contract";
import {
  GATE_HEADER,
  isStaleStubError,
  loginGate,
} from "../auth/broker-transport.js";
import type { Env } from "../env.js";
import { b64urlEncode } from "../util/crypto.js";

/** The gate forwards only the path; the platform never reads this host. */
const LOGIN_ORIGIN = "https://login.oa.internal";

/** Why the platform could not answer: a fixed category, safe to log. */
export class OptoutUnavailableError extends Error {
  constructor(public why: string) {
    super(`opt-out list unavailable: ${why}`);
    this.name = "OptoutUnavailableError";
  }
}

/** The platform's list behind an interface: the gate in production, a fake in tests. */
export interface OptoutPlatform {
  /** Is this address hash opted out hosted-wide? Throws OptoutUnavailableError when it can't say. */
  check(env: Env, h1: string): Promise<boolean>;
  /** A token for this email's unsubscribe link. Throws OptoutUnavailableError (why "capped" over the daily cap). */
  mint(env: Env, h1: string): Promise<string>;
}

async function call(env: Env, path: string, h1: string): Promise<unknown> {
  const gate = loginGate();
  if (!gate) throw new OptoutUnavailableError("no_gate");
  const key = env.BROKER_SIGNING_KEY?.trim();
  if (!key) throw new OptoutUnavailableError("unconfigured");
  // The body names no install: the gate stamps it. The nonce is fresh per call.
  const text = JSON.stringify({
    ts: Date.now(),
    nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    h1,
  });
  const kid = await keyId(await publicFromPkcs8(key));
  const req = new Request(`${LOGIN_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(key, path, kid, text),
    },
    body: text,
    redirect: "manual",
  });
  let res: Response;
  try {
    res = await gate.fetch(req);
  } catch (e) {
    throw new OptoutUnavailableError(isStaleStubError(e) ? "stale" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 429 && res.headers.get(GATE_HEADER) !== "1")
      throw new OptoutUnavailableError("capped");
    throw new OptoutUnavailableError(
      res.headers.get(GATE_HEADER) === "1"
        ? "gate_refused"
        : `http_${res.status}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new OptoutUnavailableError("bad_answer");
  }
}

/** Over the platform's LoginGate. */
export const gateOptoutPlatform: OptoutPlatform = {
  async check(env, h1) {
    const out = OptoutCheckResponseSchema.safeParse(
      await call(env, OPTOUT_CHECK_PATH, h1),
    );
    if (!out.success) throw new OptoutUnavailableError("bad_answer");
    return out.data.optedOut;
  },
  async mint(env, h1) {
    const out = OptoutMintResponseSchema.safeParse(
      await call(env, OPTOUT_MINT_PATH, h1),
    );
    if (!out.success) throw new OptoutUnavailableError("bad_answer");
    return out.data.token;
  },
};

/** What the code calls: the gate, or a fake in tests. */
export const optoutPlatform: { impl: OptoutPlatform } = {
  impl: gateOptoutPlatform,
};

/** Hosted installs the platform has switched on; self-host never. */
export const hostedOptoutOn = (env: Env): boolean =>
  env.HOSTED === "1" && env.OPTOUT_PLATFORM === "on";

/**
 * h1 = HMAC-SHA256(OPTOUT_HASH_KEY, lowercased trimmed address), lowercase
 * hex. Null when the key is not set: the caller fails closed.
 */
export async function optoutHash(
  env: Env,
  email: string,
): Promise<string | null> {
  const key = env.OPTOUT_HASH_KEY?.trim();
  if (!key) return null;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    enc.encode(email.trim().toLowerCase()),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The unsubscribe link the platform's page opens, from the base the platform set. Null when unset or not https. */
export function platformUnsubscribeUrl(env: Env, token: string): string | null {
  const base = env.OPTOUT_UNSUBSCRIBE_URL?.trim();
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" || u.search || u.hash) return null;
    u.searchParams.set("t", token);
    return u.href;
  } catch {
    return null;
  }
}
