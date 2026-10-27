import { boxKeyPair } from "@oa/auth-core";
import {
  BrokerGateRefusedError,
  BrokerGateStaleError,
  type BrokerName,
  type BrokerTransportKind,
  BrokerUnavailableError,
  brokerFetch,
  brokerTransportKind,
  GATE_HEADER,
} from "../auth/broker-transport.js";
import { authConfig } from "../auth/config.js";
import { brokerRedeemRequest } from "../auth/providers/google.js";
import { DIRECTORY_TOKEN, signedRequest } from "../directory/broker.js";
import { directoryTransport } from "../directory/transport.js";
import type { Env } from "../env.js";

// POST R.adminBrokerCheck (org owner): proves this install reaches each of
// its brokers through the transport it really uses (binding, props or
// HTTPS), signed exactly as a sign-in redeem or a directory token request,
// with a junk code (refresh token) the broker must refuse. `ok` only for broker-core's
// post-verification refusal of that code: 401, no gate header, body exactly
// {"error":"bad_flow"}. That proves the request crossed the transport and
// the broker verified this install's registration, key and signature.
// Before verification broker-core answers 401 {"error":"unauthorized"}
// (unknown install, bad signature or key): "unverified". A verified but
// stale assertion (clock skew) is 401 {"error":"stale"}: "stale". Nothing
// about the answer leaves this module except its status and timing;
// bodies, tokens and URLs are never logged or returned.

export const BROKER_CHECK_TIMEOUT_MS = 5_000;
/**
 * A check within this long of the last one gets that result (cached: true)
 * instead of calling the brokers: their per-IP buckets may be shared by
 * every install behind a binding or props (ip:unknown).
 */
export const BROKER_CHECK_COOLDOWN_MS = 30_000;

/**
 * Why a check isn't ok: the broker refused before verifying (unverified),
 * the assertion or the capability was stale, or (status 0) nothing came
 * back: no transport, the gate refused it, a timeout or a network error.
 */
export type BrokerCheckError =
  | "unverified"
  | "unavailable"
  | "gate"
  | "stale"
  | "timeout"
  | "network";

export type BrokerCheckResult = {
  /** The broker verified this install and refused only the junk code, or skipped. */
  ok: boolean;
  /** The broker's HTTP status; 0 when nothing came back. */
  status: number;
  ms: number;
  transport: BrokerTransportKind | null;
  /** This install doesn't use this broker (direct Google, none configured). */
  skipped?: "no_broker";
  error?: BrokerCheckError;
  /** The last check's result, served within BROKER_CHECK_COOLDOWN_MS. */
  cached?: true;
};

export type BrokerCheck = {
  auth: BrokerCheckResult;
  directory: BrokerCheckResult;
};

/** A junk value no flow ever issued (the broker refuses it as bad_flow). */
const JUNK = "oa-broker-check";

const skipped = (): BrokerCheckResult => ({
  ok: true,
  status: 0,
  ms: 0,
  transport: null,
  skipped: "no_broker",
});

class Timeout extends Error {}

const errorOf = (e: unknown): BrokerCheckError =>
  e instanceof BrokerUnavailableError
    ? "unavailable"
    : e instanceof BrokerGateRefusedError
      ? "gate"
      : e instanceof BrokerGateStaleError
        ? "stale"
        : e instanceof Timeout
          ? "timeout"
          : "network";

/** broker-core's 401 bodies, each exactly {"error": code}: null is ok. */
const VERDICTS: Readonly<Record<string, BrokerCheckError | null>> = {
  bad_flow: null,
  unauthorized: "unverified",
  stale: "stale",
};

/**
 * A broker-core 401 (never the gate's): null for bad_flow (ok), its error
 * for the others, undefined for anything else.
 */
async function verdict(
  res: Response,
): Promise<BrokerCheckError | null | undefined> {
  if (res.status !== 401 || res.headers.has(GATE_HEADER)) return undefined;
  const text = await res.text().catch(() => "");
  if (text.length > 64) return undefined;
  try {
    const out = JSON.parse(text) as unknown;
    if (
      !out ||
      typeof out !== "object" ||
      Array.isArray(out) ||
      Object.keys(out).length !== 1
    )
      return undefined;
    const e = (out as { error?: unknown }).error;
    return typeof e === "string" && Object.hasOwn(VERDICTS, e)
      ? VERDICTS[e]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Sends `build()`'s request to `which` by the real transport, within `timeoutMs`. */
async function probe(
  env: Env,
  which: BrokerName,
  build: () => Promise<Request>,
  timeoutMs: number,
): Promise<BrokerCheckResult> {
  const transport = brokerTransportKind(env, which);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Timeout());
    }, timeoutMs);
  });
  try {
    const run = async () => {
      const res = await brokerFetch(env, which, await build());
      // An answer after the timeout: nobody reads it, release it.
      if (timedOut) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: 0, error: undefined };
      }
      try {
        const v = await verdict(res);
        const error: BrokerCheckError | undefined = res.headers.has(GATE_HEADER)
          ? "gate"
          : (v ?? undefined);
        return { ok: v === null, status: res.status, error };
      } finally {
        if (!res.bodyUsed) await res.body?.cancel().catch(() => {});
      }
    };
    const pending = run();
    // Its late rejection (after the timeout) is nobody's to handle.
    pending.catch(() => {});
    const r = await Promise.race([pending, timeout]);
    return {
      ok: r.ok,
      status: r.status,
      ms: ms(),
      transport,
      ...(r.error ? { error: r.error } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: ms(),
      transport,
      error: errorOf(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks both brokers in parallel; one not configured here is skipped. */
export async function checkBrokers(
  env: Env,
  timeoutMs = BROKER_CHECK_TIMEOUT_MS,
): Promise<BrokerCheck> {
  const google = authConfig(env).google;
  const g = google?.transport.kind === "broker" ? google.transport : null;
  const dt = directoryTransport(env);
  const d = dt.kind === "broker" ? dt : null;
  const [auth, directory] = await Promise.all([
    g
      ? probe(
          env,
          "auth",
          () =>
            brokerRedeemRequest(g, {
              code: JUNK,
              verifier: `${JUNK}-verifier-${crypto.randomUUID()}`,
              nonce: `${JUNK}-${crypto.randomUUID()}`,
              bstate: JUNK,
            }),
          timeoutMs,
        )
      : skipped(),
    d
      ? probe(
          env,
          "directory",
          async () =>
            (
              await signedRequest(d, DIRECTORY_TOKEN, {
                epk: (await boxKeyPair()).pub,
                // A refresh grant with a junk token: refused after
                // verification as bad_flow (bad_refresh).
                grant: "refresh",
                refresh_token: JUNK,
              })
            ).req,
          timeoutMs,
        )
      : skipped(),
  ]);
  return { auth, directory };
}
