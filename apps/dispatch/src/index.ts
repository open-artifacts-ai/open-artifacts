import {
  type BrokerGateEnv,
  type BrokerGateProps,
  brokerProps,
} from "@oa/broker-core/gate";
import { isInstallId, names, type Env as OaEnv } from "@oa/provision/names";

// The install's only path to the brokers (see @oa/broker-core/gate).
export { BrokerGate } from "@oa/broker-core/gate";

export interface Env extends BrokerGateEnv {
  DISPATCHER: DispatchNamespace;
  /** host -> install id, written by provisioning (create and delete). */
  HOSTS: KVNamespace;
  OA_ENV: OaEnv;
}

// IPv4 dotted quad, or IPv6 (URL.hostname keeps the brackets: "[::1]").
const IP_LITERAL = /^(?:\d+(?:\.\d+){3}|\[.*\])$/;

/**
 * The lookup key, or null for a host no install can hold. Matches @oa/shared's
 * normalizeHost on every tenant host (pinned by a parity test); kept local so
 * the bundle stays small.
 */
export function hostOf(req: Request): string | null {
  let host: string;
  try {
    // URL.hostname drops the port; no other header (X-Forwarded-Host) counts.
    host = new URL(req.url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  // Tenant hosts are <slug>.<zone>: a bare apex, a single label, www (a
  // reserved slug) or an IP literal is never in HOSTS, so skip the read.
  if (IP_LITERAL.test(host) || host.split(".").length < 3) return null;
  return host.startsWith("www.") ? null : host;
}

/**
 * Every failure is this one response: a miss, a bad value, a binding error or
 * a deleted script look the same, and nothing reaches another install.
 */
const notFound = () => new Response("Not found", { status: 404 });

/** A fixed log category; never the error text (it can carry names or URLs). */
const category = (e: unknown) =>
  e instanceof Error && e.message.startsWith("Worker not found")
    ? "not_found"
    : "exception";

/** What ctx.exports holds for this Worker's own BrokerGate export. */
interface GateExports {
  BrokerGate: (o: { props: BrokerGateProps }) => Fetcher;
}

export default {
  async fetch(req, env, ctx) {
    const host = hostOf(req);
    if (!host) return notFound();
    let id: string | null;
    try {
      id = await env.HOSTS.get(host, { cacheTtl: 60 });
    } catch {
      console.error("dispatch failed", "kv", host);
      return notFound();
    }
    if (typeof id !== "string" || !isInstallId(id)) return notFound();
    try {
      // The original Request, unread and unchanged (body, Upgrade, Cookie),
      // with this install's broker gates in ctx.props for this request only.
      const props = brokerProps(ctx.exports as unknown as GateExports, id);
      return await env.DISPATCHER.get(names(id, env.OA_ENV).script, {
        props,
      }).fetch(req);
    } catch (e) {
      // A deleted script, a crashing install or a binding error: still the
      // one 404, with only the host and a fixed category logged.
      console.error("dispatch failed", category(e), host);
      return notFound();
    }
  },
} satisfies ExportedHandler<Env>;
