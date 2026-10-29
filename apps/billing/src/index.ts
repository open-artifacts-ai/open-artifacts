// oa-<p>-billing: the tier store (self-serve step 1). See wrangler.jsonc.
//
// Gate routes (GET /tier, POST /trial/start, POST /usage, GET /health) are
// reachable only over a service binding: every internet request carries
// cf-connecting-ip and a binding request does not, so one that has it gets
// the plain 404. The install id comes only from x-oa-gate-install, which
// BillingGate sets to its own install; never from a query or a body.
//
// The two POSTs also carry the install's Ed25519 assertion (defense in
// depth), the auth broker's redeem scheme: x-oa-kid names one of the gate
// install's registry keys, x-oa-sig signs requestTranscript(path, kid, body)
// over the exact body text, and the body's `ts` is within ASSERTION_SKEW_MS.
// Anything else is 401 bad_signature and writes nothing.
//
// Logs carry fixed categories and install ids only: never bodies, headers or
// URLs.
import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";

export interface Env {
  BILLING_DB: D1Database;
  /** The install registry (read-only): the namespace the auth broker reads. */
  BROKER_REGISTRY: KVNamespace;
}

const DAY_MS = 86_400_000;
export const TRIAL_MS = 14 * DAY_MS;
/** The most creators one usage report may list. */
export const MAX_CREATORS = 10_000;
/**
 * The largest body billing reads: room for MAX_CREATORS ids at their longest.
 * Gate traffic is already capped lower (GATE_MAX_BODY).
 */
export const MAX_BODY = 2 * 1024 * 1024;

const INSTALL_ID = /^i[a-z0-9]{11}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** An opaque creator id: the install chooses it; billing only counts it. */
const CREATOR = /^[A-Za-z0-9_-]{1,128}$/;

const notFound = () => new Response("Not found", { status: 404 });
const bad = (error: string, status = 400) =>
  Response.json({ error }, { status });

interface TierRow {
  tier: string | null;
  status: string | null;
  trial_ends_at: number | null;
  grace_until: number | null;
  version: number;
}

/** What an install sees: no Stripe ids, ever. */
function view(r: TierRow | null, now: number) {
  if (!r)
    return {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
      asOf: now,
    };
  return {
    tier: r.tier,
    status: r.status,
    trialEndsAt: r.trial_ends_at,
    graceUntil: r.grace_until,
    version: r.version,
    asOf: now,
  };
}

const COLS = "tier, status, trial_ends_at, grace_until, version";
// The read records last_read_at on the install's own row and writes nothing
// when there is no row (create writes rows, not this route).
const READ_SQL = `UPDATE tiers SET last_read_at = ?2 WHERE install_id = ?1 RETURNING ${COLS}`;
const SELECT_SQL = `SELECT ${COLS} FROM tiers WHERE install_id = ?1`;
// Only free/active with no trial before: a trial never starts twice.
// No row is the free/active default, so a trial can start from it too (an
// install made before create writes rows); an existing row moves only from
// free/active, and only once (trial_ends_at stays set after).
const TRIAL_SQL = `INSERT INTO tiers (install_id, tier, status, trial_ends_at, version, updated_at) VALUES (?1, 'trial', 'active', ?2, 1, ?3) ON CONFLICT (install_id) DO UPDATE SET tier = 'trial', trial_ends_at = ?2, version = tiers.version + 1, updated_at = ?3 WHERE tiers.tier = 'free' AND tiers.status = 'active' AND tiers.trial_ends_at IS NULL RETURNING ${COLS}`;
const USAGE_SQL =
  "INSERT INTO usage (install_id, month, creators_json, count, received_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (install_id, month) DO UPDATE SET creators_json = excluded.creators_json, count = excluded.count, received_at = excluded.received_at";

/** The body's exact text (JSON content type, UTF-8, at most MAX_BODY), or null. */
async function bodyText(req: Request): Promise<string | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) return null;
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) return null;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

const sigLog = (outcome: string, install: string) =>
  console.log("billing signature", outcome, install);
const badSignature = () => bad("bad_signature", 401);

/**
 * A signed POST's body as a JSON object, or the refusal. The kid must be one
 * of the GATE install's registry keys (never the body's install), the
 * signature must cover this route's path and the exact body text, and the
 * body's `ts` must be within ASSERTION_SKEW_MS of now. Runs before any write.
 */
async function signedBody(
  req: Request,
  env: Env,
  install: string,
  path: string,
  now: number,
): Promise<Record<string, unknown> | Response> {
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  const text = await bodyText(req);
  if (text === null) return bad("bad_body");
  if (!kid || !sig) return sigLog("missing", install), badSignature();
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry) return sigLog("unknown_install", install), badSignature();
  if (!(await verifyAssertion(entry, path, kid, text, sig)))
    return sigLog("bad", install), badSignature();
  const body = jsonObject(text);
  if (!body) return bad("bad_body");
  if (
    typeof body.ts !== "number" ||
    !(Math.abs(now - body.ts) <= ASSERTION_SKEW_MS)
  )
    return sigLog("stale", install), badSignature();
  return body;
}

/** The text as a JSON object, or null for anything else. */
function jsonObject(text: string): Record<string, unknown> | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** A body naming an install names the gate's own (defense in depth). */
const mismatched = (body: Record<string, unknown>, install: string) =>
  Object.hasOwn(body, "install") && body.install !== install;

async function tier(db: D1Database, install: string, now: number) {
  const r = await db.prepare(READ_SQL).bind(install, now).first<TierRow>();
  console.log("billing tier", r ? "row" : "default", install);
  return Response.json(view(r, now));
}

async function trialStart(
  db: D1Database,
  install: string,
  body: Record<string, unknown>,
  now: number,
) {
  if (mismatched(body, install)) return bad("install_mismatch", 403);
  const started = await db
    .prepare(TRIAL_SQL)
    .bind(install, now + TRIAL_MS, now)
    .first<TierRow>();
  if (started) {
    console.log("billing trial started", install);
    return Response.json(view(started, now));
  }
  // Any other state: unchanged, and still a 200.
  const r = await db.prepare(SELECT_SQL).bind(install).first<TierRow>();
  console.log("billing trial unchanged", install);
  return Response.json(view(r, now));
}

async function usage(
  db: D1Database,
  install: string,
  body: Record<string, unknown>,
  now: number,
) {
  if (mismatched(body, install)) return bad("install_mismatch", 403);
  const { month, creators, count } = body;
  if (typeof month !== "string" || !MONTH.test(month)) return bad("bad_month");
  if (
    !Array.isArray(creators) ||
    creators.length > MAX_CREATORS ||
    !creators.every((c) => typeof c === "string" && CREATOR.test(c)) ||
    new Set(creators).size !== creators.length
  )
    return bad("bad_creators");
  if (count !== creators.length) return bad("bad_count");
  await db
    .prepare(USAGE_SQL)
    .bind(install, month, JSON.stringify(creators), count, now)
    .run();
  console.log("billing usage", install);
  return Response.json({ ok: true, month, count });
}

/** Gate routes: method, path. /health takes no install. */
const GATE = new Set([
  "GET /tier",
  "GET /health",
  "POST /trial/start",
  "POST /usage",
]);

export default {
  async fetch(req, env) {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return notFound();
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === "POST /stripe/webhook") {
      // Backend's webhook module mounts here (step 2).
      await req.body?.cancel();
      return Response.json({ error: "not_implemented" }, { status: 501 });
    }
    // Gate routes only over a binding: an internet request always carries
    // cf-connecting-ip.
    if (!GATE.has(route) || req.headers.has("cf-connecting-ip")) {
      await req.body?.cancel();
      return notFound();
    }
    if (route === "GET /health") return Response.json({ ok: true });
    // The install is the gate's header and nothing else.
    const install = req.headers.get(GATE_INSTALL_HEADER);
    if (install === null || !INSTALL_ID.test(install)) {
      await req.body?.cancel();
      return notFound();
    }
    const now = Date.now();
    try {
      if (route === "GET /tier")
        return await tier(env.BILLING_DB, install, now);
      // Both POSTs: the install's signature first, before any write.
      const body = await signedBody(req, env, install, url.pathname, now);
      if (body instanceof Response) return body;
      if (route === "POST /trial/start")
        return await trialStart(env.BILLING_DB, install, body, now);
      return await usage(env.BILLING_DB, install, body, now);
    } catch {
      // Never the error text: it can carry a D1 message.
      console.error("billing db_error", install);
      return bad("unavailable", 503);
    }
  },
} satisfies ExportedHandler<Env>;
