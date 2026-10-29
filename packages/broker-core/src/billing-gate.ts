// BillingGate: an install's only way to reach oa-<p>-billing, built like
// BrokerGate (gate.ts) and for the same reason: an install in the dispatch
// namespace takes no service bindings and can't fetch a Worker on its own
// zone. oa-<p>-dispatch and oa-<p>-scheduler hold the BILLING binding and hand
// each install a stub of this class in ctx.props, valid for that one request.
//
// The gate is the identity: it sets x-oa-gate-install to its own install, and
// billing reads and writes only that row. It forwards four fixed routes, never
// a caller-chosen host, query or header beyond the three below.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  boundedText,
  GATE_HEADER,
  GATE_MAX_BODY,
  type GateRefusal,
} from "./gate.js";
import { GATE_INSTALL_HEADER } from "./gate-header.js";

export interface BillingGateProps {
  installId: string;
}

export interface BillingGateEnv {
  BILLING: Fetcher;
}

/**
 * The billing Worker has no public origin for these routes (binding only), so
 * the forwarded URL's host is this fixed name; billing never reads it.
 */
/** The /usage body cap: 10,000 creator ids of up to 128 chars (billing's own MAX_BODY). */
export const USAGE_MAX_BODY = 2 * 1024 * 1024;

export const BILLING_ORIGIN = "https://billing.oa.internal";

/** The routes an install may call, by method; nothing else passes. */
export const BILLING_GATE_ROUTES: Readonly<
  Record<"GET" | "POST", readonly string[]>
> = {
  GET: ["/tier", "/health"],
  POST: ["/trial/start", "/usage"],
};

const FORWARD = ["content-type", "x-oa-kid", "x-oa-sig"] as const;

const INSTALL_ID = /^i[a-z0-9]{11}$/;

const refuse = (status: number, error: GateRefusal) =>
  Response.json({ error }, { status, headers: { [GATE_HEADER]: "1" } });

/**
 * One request through the gate. 404 for any other method or route (or a
 * query string), 415 for a POST body that isn't JSON, 413 over GATE_MAX_BODY,
 * 400 for a body that can't be read (bad_body) or isn't a JSON object
 * (bad_json), 403 when a POST body's `install` isn't the gate's, 500 for
 * missing or malformed props. Every refusal carries `x-oa-gate: 1`.
 * Otherwise the fixed route, the allowed headers and the gate's install
 * header, over the BILLING binding.
 */
export async function passBillingGate(
  req: Request,
  props: BillingGateProps | undefined,
  env: BillingGateEnv,
): Promise<Response> {
  if (
    !props ||
    typeof props.installId !== "string" ||
    !INSTALL_ID.test(props.installId)
  )
    return refuse(500, "gate_misconfigured");
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return refuse(404, "not_found");
  }
  const method = req.method;
  if (
    (method !== "GET" && method !== "POST") ||
    url.search !== "" ||
    !BILLING_GATE_ROUTES[method].includes(url.pathname)
  ) {
    await req.body?.cancel();
    return refuse(404, "not_found");
  }

  let text: string | undefined;
  if (method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(type)) {
      await req.body?.cancel();
      return refuse(415, "json_only");
    }
    let t: string | null;
    try {
      // /usage carries the month's creator list (up to 10,000 ids); every
      // other route stays at the broker gates' cap.
      t = await boundedText(
        req,
        url.pathname === "/usage" ? USAGE_MAX_BODY : GATE_MAX_BODY,
      );
    } catch {
      return refuse(400, "bad_body");
    }
    if (t === null) return refuse(413, "too_large");
    let body: unknown;
    try {
      body = JSON.parse(t);
    } catch {
      return refuse(400, "bad_json");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return refuse(400, "bad_json");
    if ((body as { install?: unknown }).install !== props.installId)
      return refuse(403, "install_mismatch");
    text = t;
  }

  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // Billing's only source of the install id: this gate's, never a caller's.
  headers.set(GATE_INSTALL_HEADER, props.installId);
  return env.BILLING.fetch(
    new Request(`${BILLING_ORIGIN}${url.pathname}`, {
      method,
      headers,
      ...(text === undefined ? {} : { body: text }),
      redirect: "manual",
    }),
  );
}

export class BillingGate extends WorkerEntrypoint<
  BillingGateEnv,
  BillingGateProps
> {
  override fetch(req: Request): Promise<Response> {
    return passBillingGate(req, this.ctx.props, this.env);
  }
}

/** The install's billing gate for one request, for that install only. */
export function billingProps(
  exports: { BillingGate: (o: { props: BillingGateProps }) => Fetcher },
  installId: string,
): { BILLING: Fetcher } {
  return { BILLING: exports.BillingGate({ props: { installId } }) };
}
