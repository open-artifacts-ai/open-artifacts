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
// with junk values the broker must refuse. Only broker-core's own refusal
// (401, no gate header, body exactly {"error":"unauthorized"}) counts: it
// means the request crossed the transport and the broker parsed it. Nothing
// about the answer leaves this module except its status and timing; bodies,
// tokens and URLs are never logged or returned.

export const BROKER_CHECK_TIMEOUT_MS = 5_000;

/** Why a check threw before a broker answered (status 0). */
export type BrokerCheckError =
  | "unavailable"
  | "gate"
  | "stale"
  | "timeout"
  | "network";

export type BrokerCheckResult = {
  ok: boolean;
  /** The broker's HTTP status; 0 when nothing came back. */
  status: number;
  ms: number;
  transport: BrokerTransportKind | null;
  /** This install doesn't use this broker (direct Google, none configured). */
  skipped?: "no_broker";
  error?: BrokerCheckError;
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

/** broker-core refused(): 401 {"error":"unauthorized"}, never the gate's. */
async function isRefused(res: Response): Promise<boolean> {
  if (res.status !== 401 || res.headers.has(GATE_HEADER)) return false;
  const text = await res.text().catch(() => "");
  if (text.length > 64) return false;
  try {
    const out = JSON.parse(text) as unknown;
    return (
      !!out &&
      typeof out === "object" &&
      !Array.isArray(out) &&
      Object.keys(out).length === 1 &&
      (out as { error?: unknown }).error === "unauthorized"
    );
  } catch {
    return false;
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
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), timeoutMs);
  });
  try {
    const run = async () => {
      const res = await brokerFetch(env, which, await build());
      try {
        const ok = await isRefused(res);
        return { ok, status: res.status, gate: res.headers.has(GATE_HEADER) };
      } finally {
        if (!res.bodyUsed) await res.body?.cancel().catch(() => {});
      }
    };
    const r = await Promise.race([run(), timeout]);
    return {
      ok: r.ok,
      status: r.status,
      ms: ms(),
      transport,
      ...(r.gate ? { error: "gate" as const } : {}),
    };
  } catch (e) {
    return { ok: false, status: 0, ms: ms(), transport, error: errorOf(e) };
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
                grant: "code",
                code: JUNK,
                verifier: `${JUNK}-verifier-${crypto.randomUUID()}`,
                bstate: JUNK,
              })
            ).req,
          timeoutMs,
        )
      : skipped(),
  ]);
  return { auth, directory };
}
