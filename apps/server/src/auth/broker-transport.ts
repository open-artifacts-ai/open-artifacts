import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../env.js";

// How this install reaches its brokers (the auth broker for the sign-in
// redeem, the directory broker for directory tokens and revokes). Every
// broker request goes through brokerFetch; nothing else in src fetches a
// broker origin (test/node/broker-transport-lint.test.ts).
//
// Precedence, per broker:
// 1. binding: a service binding (env.BROKER, env.DIRECTORY_BROKER), a
//    self-hosted install on the broker's account.
// 2. props: the invocation's capability from the platform (hosted). Dispatch
//    and the scheduler pass ctx.props.AUTH_BROKER / DIRECTORY_BROKER, a stub
//    whose fetch(req) forwards only the broker's install routes to its fixed
//    origin. It is valid only during the invocation that received it, so it
//    is kept in that invocation's async context (withBrokerProps), never in
//    module state, storage or a Durable Object.
// 3. https: public HTTPS to AUTH_BROKER_URL / DIRECTORY_BROKER_URL. Never on
//    HOSTED=1: a hosted Worker reaching a Route on its own zone gets 522, so
//    without a binding or props a hosted install fails closed
//    (BrokerUnavailableError: OIDC stage broker_unavailable, directory
//    TransportError broker_unavailable).

export type BrokerName = "auth" | "directory";
export type BrokerTransportKind = "binding" | "props" | "https";

/** The platform's capability for one broker: forwards to its fixed origin. */
export interface BrokerGate {
  fetch(req: Request): Promise<Response>;
}

/** The ctx.props key carrying each broker's capability. */
export const BROKER_PROPS = {
  auth: "AUTH_BROKER",
  directory: "DIRECTORY_BROKER",
} as const satisfies Record<BrokerName, string>;

type Gates = Partial<Record<BrokerName, BrokerGate>>;

const invocation = new AsyncLocalStorage<Gates>();

const isGate = (v: unknown): v is BrokerGate =>
  !!v &&
  (typeof v === "object" || typeof v === "function") &&
  typeof (v as { fetch?: unknown }).fetch === "function";

function gatesOf(ctx: { props?: unknown } | null | undefined): Gates {
  let props: unknown;
  try {
    props = ctx?.props;
  } catch {
    props = undefined;
  }
  const out: Gates = {};
  if (!props || typeof props !== "object") return out;
  for (const which of ["auth", "directory"] as const) {
    const g = (props as Record<string, unknown>)[BROKER_PROPS[which]];
    if (isGate(g)) out[which] = g;
  }
  return out;
}

/** Runs `f` with this invocation's broker capabilities (ctx.props) in scope. */
export function withBrokerProps<T>(
  ctx: { props?: unknown } | null | undefined,
  f: () => T,
): T {
  return invocation.run(gatesOf(ctx), f);
}

/**
 * Runs `f` with no broker capability in scope: a Durable Object's own
 * invocations (alarms) never hold one, whatever context they were reached from.
 */
export function withoutBrokerProps<T>(f: () => T): T {
  return invocation.run({}, f);
}

const bindingOf = (env: Env, which: BrokerName): Fetcher | undefined =>
  which === "auth" ? env.BROKER : env.DIRECTORY_BROKER;

/**
 * The transport brokerFetch would use for `which` right now, or null when
 * none may be used (hosted, no binding, no props: fail closed).
 */
export function brokerTransportKind(
  env: Env,
  which: BrokerName,
): BrokerTransportKind | null {
  if (bindingOf(env, which)) return "binding";
  if (invocation.getStore()?.[which]) return "props";
  return env.HOSTED === "1" ? null : "https";
}

/** No way to reach the broker: hosted, without a binding or props. */
export class BrokerUnavailableError extends Error {
  constructor(public broker: BrokerName) {
    super(`${broker} broker unavailable`);
    this.name = "BrokerUnavailableError";
  }
}

/**
 * The platform's gate refused the request before the broker saw it: marked
 * `x-oa-gate: 1`, with its own JSON `error` (404, 415, 413, 400, 403, or 500
 * when props are misconfigured). Never a 401: that is always the broker's.
 */
export class BrokerGateRefusedError extends Error {
  constructor(
    public broker: BrokerName,
    public status: number,
    public error: string,
  ) {
    super(`${broker} broker gate refused: ${status} ${error}`);
    this.name = "BrokerGateRefusedError";
  }
}

/** The header the gate sets on its own refusals (never on a broker answer). */
export const GATE_HEADER = "x-oa-gate";

/** The gate's refusal codes (platform BrokerGate, #720), read only under GATE_HEADER. */
export const GATE_ERRORS: ReadonlySet<string> = new Set([
  "gate_misconfigured",
  "not_found",
  "install_mismatch",
  "json_only",
  "bad_json",
  "bad_body",
  "too_large",
]);

/**
 * A props-transport answer that is the gate's refusal, not the broker's:
 * keyed on GATE_HEADER only, so a broker's own error (its 404 not_found
 * included) always passes through. The code names the refusal ("gate" when
 * it isn't one of GATE_ERRORS).
 */
async function gateRefusal(res: Response): Promise<string | null> {
  if (res.ok || res.headers.get(GATE_HEADER) !== "1") return null;
  try {
    const out = (await res.clone().json()) as { error?: unknown } | null;
    const e = out?.error;
    return typeof e === "string" && GATE_ERRORS.has(e) ? e : "gate";
  } catch {
    return "gate";
  }
}

/**
 * The runtime refused the capability itself: a stub used outside the
 * invocation that received it (cross-request I/O) or disconnected. Nothing
 * reached the broker; the next invocation brings a fresh one.
 */
export class BrokerGateStaleError extends Error {
  constructor(public broker: BrokerName) {
    super(`${broker} broker capability is stale`);
    this.name = "BrokerGateStaleError";
  }
}

/** workerd's errors for an I/O object or RPC stub used past its request. */
const STALE_STUB =
  /different request|after (it has been|being) disposed|stub (was |has been )?(disposed|disconnected)|RPC (stub|receiver) .*disconnected|disconnected .*RPC|Network connection lost/i;

export const isStaleStubError = (e: unknown): boolean =>
  e instanceof Error && STALE_STUB.test(e.message);

/**
 * Sends `req` (already addressed to the broker's configured URL and signed)
 * by the first available transport. Throws BrokerUnavailableError when none
 * is (HOSTED=1 never falls back to HTTPS), BrokerGateRefusedError when the
 * platform's gate (props) refused it, and BrokerGateStaleError when the
 * runtime refused a capability used past its invocation.
 */
export async function brokerFetch(
  env: Env,
  which: BrokerName,
  req: Request,
): Promise<Response> {
  const binding = bindingOf(env, which);
  if (binding) return binding.fetch(req);
  const gate = invocation.getStore()?.[which];
  if (gate) {
    let res: Response;
    try {
      res = await gate.fetch(req);
    } catch (e) {
      if (isStaleStubError(e)) throw new BrokerGateStaleError(which);
      throw e;
    }
    const refused = await gateRefusal(res);
    if (refused === null) return res;
    await res.body?.cancel();
    throw new BrokerGateRefusedError(which, res.status, refused);
  }
  if (env.HOSTED === "1") throw new BrokerUnavailableError(which);
  // Self-host only (unreachable on HOSTED=1, above): public HTTPS.
  return fetch(req);
}
