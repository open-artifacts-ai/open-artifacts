// BrokerGate: an install's only way to reach the hosted brokers. A Worker in
// the dispatch namespace can't fetch a Worker on a zone Route of the same zone
// (Cloudflare refuses same-zone fetch to a Route; the subrequest goes to the
// 100:: origin and gets a 522), and WfP user Workers take no service bindings.
// So oa-<p>-dispatch and oa-<p>-scheduler, which do hold service bindings to
// both brokers, hand each install a stub of this class through dispatch props
// (ctx.exports.BrokerGate({ props })), valid only for that one request.
//
// The gate is narrower than a raw binding: one install, one broker, fixed
// routes. It never forwards a caller-chosen host, path, query or header that
// could steer routing; the broker still verifies the install's signature.
import { WorkerEntrypoint } from "cloudflare:workers";

export type BrokerKind = "auth" | "directory";

export interface BrokerGateProps {
  installId: string;
  kind: BrokerKind;
}

export interface BrokerGateEnv {
  AUTH_BROKER: Fetcher;
  DIRECTORY_BROKER: Fetcher;
  /** The broker's fixed public origin, https://auth.<app zone>. */
  AUTH_BROKER_ORIGIN: string;
  /** https://directory.<app zone>. */
  DIRECTORY_BROKER_ORIGIN: string;
}

/** The server-side POST routes an install calls, per broker; nothing else passes. */
export const GATE_ROUTES: Readonly<Record<BrokerKind, readonly string[]>> = {
  auth: ["/google/redeem"],
  directory: ["/google/directory/token", "/google/directory/revoke"],
};

/** The largest body the gate reads; every allowed request is far below it. */
export const GATE_MAX_BODY = 8192;

/** The only request headers forwarded: the body type and the install's signature. */
const FORWARD = ["content-type", "x-oa-kid", "x-oa-sig"] as const;

const INSTALL_ID = /^i[a-z0-9]{11}$/;

/**
 * Set on every refusal by the gate itself, never on a broker's response, so a
 * caller can tell "the gate refused" from the broker's own 404 or 4xx.
 */
export const GATE_HEADER = "x-oa-gate";

/** The gate's refusal codes, as the `error` of the JSON body. */
export type GateRefusal =
  | "gate_misconfigured"
  | "not_found"
  | "json_only"
  | "bad_body"
  | "too_large"
  | "bad_json"
  | "install_mismatch";

const refuse = (status: number, error: GateRefusal) =>
  Response.json({ error }, { status, headers: { [GATE_HEADER]: "1" } });

/** The body as text, or null when it is larger than `max` bytes. */
async function boundedText(req: Request, max: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) {
    await req.body?.cancel();
    return null;
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

/**
 * One request through the gate. 404 for any method or route the broker kind
 * doesn't allow (or a query string), 415 for a body that isn't JSON, 413 over
 * GATE_MAX_BODY, 400 for a body that can't be read or isn't UTF-8 (bad_body)
 * or JSON that doesn't parse to an object (bad_json), 403 when the body names
 * another install, 500 for missing or malformed props. Every refusal carries
 * `x-oa-gate: 1`. Otherwise the same body, the allowed headers
 * only, to the fixed origin over the service binding.
 */
export async function passGate(
  req: Request,
  props: BrokerGateProps | undefined,
  env: BrokerGateEnv,
): Promise<Response> {
  if (
    !props ||
    typeof props.installId !== "string" ||
    !INSTALL_ID.test(props.installId) ||
    !Object.hasOwn(GATE_ROUTES, props.kind)
  )
    return refuse(500, "gate_misconfigured");
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return refuse(404, "not_found");
  }
  if (
    req.method !== "POST" ||
    url.search !== "" ||
    !GATE_ROUTES[props.kind].includes(url.pathname)
  ) {
    await req.body?.cancel();
    return refuse(404, "not_found");
  }
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    await req.body?.cancel();
    return refuse(415, "json_only");
  }
  let text: string | null;
  try {
    text = await boundedText(req, GATE_MAX_BODY);
  } catch {
    return refuse(400, "bad_body");
  }
  if (text === null) return refuse(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refuse(400, "bad_json");
  if ((body as { install?: unknown }).install !== props.installId)
    return refuse(403, "install_mismatch");

  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  const auth = props.kind === "auth";
  const origin = auth ? env.AUTH_BROKER_ORIGIN : env.DIRECTORY_BROKER_ORIGIN;
  const target = auth ? env.AUTH_BROKER : env.DIRECTORY_BROKER;
  return target.fetch(
    new Request(`${origin}${url.pathname}`, {
      method: "POST",
      headers,
      body: text,
      redirect: "manual",
    }),
  );
}

export class BrokerGate extends WorkerEntrypoint<
  BrokerGateEnv,
  BrokerGateProps
> {
  override fetch(req: Request): Promise<Response> {
    return passGate(req, this.ctx.props, this.env);
  }
}

/** The props an install gets for one request: a gate per broker, for that install only. */
export function brokerProps(
  exports: {
    BrokerGate: (o: { props: BrokerGateProps }) => Fetcher;
  },
  installId: string,
): { AUTH_BROKER: Fetcher; DIRECTORY_BROKER: Fetcher } {
  return {
    AUTH_BROKER: exports.BrokerGate({ props: { installId, kind: "auth" } }),
    DIRECTORY_BROKER: exports.BrokerGate({
      props: { installId, kind: "directory" },
    }),
  };
}
