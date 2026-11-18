// One signed call through the platform's LoginGate (ctx.props.LOGIN): the
// route is one of the gate's fixed paths, the body names no install (the gate
// stamps it) and is signed with this install's key (x-oa-kid, x-oa-sig over the
// path, the kid and the exact body text), with a fresh nonce. A hung gate is
// aborted after `timeoutMs`. Never logs a body.
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import {
  GATE_HEADER,
  isStaleStubError,
  loginGate,
} from "../auth/broker-transport.js";
import type { Env } from "../env.js";
import { b64urlEncode } from "../util/crypto.js";

/** The gate forwards only the path; the platform never reads this host. */
const LOGIN_ORIGIN = "https://login.oa.internal";

/** The platform could not answer: a fixed category, safe to log. */
export class LoginGateError extends Error {
  constructor(public why: string) {
    super(`login gate unavailable: ${why}`);
    this.name = "LoginGateError";
  }
}

/** How long each call may take before it counts as no answer. */
export const LOGIN_GATE_TIMEOUT_MS = 2500;

/** POSTs `{ ts, nonce, ...fields }` to `path` and returns the 2xx JSON, else throws LoginGateError. */
export async function loginGateCall(
  env: Env,
  path: string,
  fields: Record<string, unknown> = {},
  timeoutMs = LOGIN_GATE_TIMEOUT_MS,
): Promise<unknown> {
  const gate = loginGate();
  if (!gate) throw new LoginGateError("no_gate");
  const key = env.BROKER_SIGNING_KEY?.trim();
  if (!key) throw new LoginGateError("unconfigured");
  const text = JSON.stringify({
    ts: Date.now(),
    nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    ...fields,
  });
  const kid = await keyId(await publicFromPkcs8(key));
  const abort = new AbortController();
  const req = new Request(`${LOGIN_ORIGIN}${path}`, {
    method: "POST",
    signal: abort.signal,
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(key, path, kid, text),
    },
    body: text,
    redirect: "manual",
  });
  let res: Response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      gate.fetch(req),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new LoginGateError("timeout"));
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof LoginGateError) throw e;
    throw new LoginGateError(isStaleStubError(e) ? "stale" : "network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new LoginGateError(
      res.headers.get(GATE_HEADER) === "1"
        ? "gate_refused"
        : `http_${res.status}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new LoginGateError("bad_answer");
  }
}
