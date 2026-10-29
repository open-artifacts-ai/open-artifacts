import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import {
  billingGate,
  GATE_HEADER,
  isStaleStubError,
} from "../auth/broker-transport.js";
import type { Env } from "../env.js";

// The install's calls to oa-<p>-billing, through the platform's BillingGate
// (ctx.props.BILLING, #849) and nothing else: no binding, no HTTPS. The gate
// stamps this install's id; billing reads and writes only that row.
//
// GET /tier is unsigned. Every POST carries the install assertion: the body
// is `{ install, ts, ...fields }`, signed with BROKER_SIGNING_KEY over
// requestTranscript(path, kid, exact body text) (broker-core signRequest,
// the redeem scheme), sent as x-oa-kid and x-oa-sig. Billing refuses a bad,
// stale or foreign signature with 401 bad_signature and writes nothing.

/** The gate forwards only the path; billing never reads this host. */
export const BILLING_ORIGIN = "https://billing.oa.internal";

export const TIER_PATH = "/tier";
export const TRIAL_PATH = "/trial/start";
export const USAGE_PATH = "/usage";
/** Platform adds these billing routes against packages/billing-core (pending). */
export const CHECKOUT_PATH = "/checkout";
export const PORTAL_PATH = "/portal";

/** Nothing reached billing, or it answered with a failure we can't act on. */
export class BillingUnavailableError extends Error {
  constructor(
    /** A fixed category, safe to log: no_gate, unconfigured, gate_refused, stale, network, http_<status>, bad_answer. */
    public why: string,
  ) {
    super(`billing unavailable: ${why}`);
    this.name = "BillingUnavailableError";
  }
}

const kids = new Map<string, Promise<string>>();
const kidOf = (signingKey: string) => {
  let k = kids.get(signingKey);
  if (!k) {
    k = publicFromPkcs8(signingKey).then(keyId);
    k.catch(() => kids.delete(signingKey));
    kids.set(signingKey, k);
  }
  return k;
};

/** The install id and signing key, or BillingUnavailableError("unconfigured"). */
function identity(env: Env): { install: string; key: string } {
  const install = env.INSTALL_ID?.trim();
  const key = env.BROKER_SIGNING_KEY?.trim();
  if (!install || !key) throw new BillingUnavailableError("unconfigured");
  return { install, key };
}

/**
 * The signed POST for `path`: the exact body text, its kid and signature.
 * Exported for tests (the mock gate verifies it as billing does).
 */
export async function signedBillingRequest(
  env: Env,
  path: string,
  fields: Record<string, unknown>,
  now: number,
): Promise<Request> {
  const { install, key } = identity(env);
  const text = JSON.stringify({ install, ts: now, ...fields });
  const kid = await kidOf(key);
  return new Request(`${BILLING_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(key, path, kid, text),
    },
    body: text,
    redirect: "manual",
  });
}

/**
 * One call through the gate: the JSON answer of a 2xx, else
 * BillingUnavailableError. Never logs a body, header or URL.
 */
export async function billingCall(
  env: Env,
  path: string,
  fields: Record<string, unknown> | null,
  now: number,
): Promise<unknown> {
  const gate = billingGate();
  if (!gate) throw new BillingUnavailableError("no_gate");
  const req =
    fields === null
      ? new Request(`${BILLING_ORIGIN}${path}`, {
          method: "GET",
          redirect: "manual",
        })
      : await signedBillingRequest(env, path, fields, now);
  let res: Response;
  try {
    res = await gate.fetch(req);
  } catch (e) {
    throw new BillingUnavailableError(
      isStaleStubError(e) ? "stale" : "network",
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new BillingUnavailableError(
      res.headers.get(GATE_HEADER) === "1"
        ? "gate_refused"
        : `http_${res.status}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new BillingUnavailableError("bad_answer");
  }
}
