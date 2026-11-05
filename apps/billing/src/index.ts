// oa-<p>-billing: the tier store (self-serve step 1). See wrangler.jsonc.
//
// Gate routes (GET /tier, POST /trial/start, POST /usage, GET /health) are
// reachable only over a service binding: every internet request carries
// cf-connecting-ip and a binding request does not, so one that has it gets
// the plain 404. The install id comes only from x-oa-gate-install, which
// BillingGate sets to its own install; never from a query or a body.
//
// POST /checkout and POST /portal (self-serve step 3) answer a Stripe
// Checkout or Customer Portal URL, through @oa/billing-core (the one Stripe
// client). Their success, cancel and return URLs are built here from the
// app host the gate sends (x-oa-gate-app-host, from the gate's props), never
// from the request; a body with any field beyond the route's own is refused.
// The install's Stripe customer is created here only, and mapped in tiers
// before any session is made.
//
// Every POST also carries the install's Ed25519 assertion (defense in
// depth), the auth broker's redeem scheme: x-oa-kid names one of the gate
// install's registry keys, x-oa-sig signs requestTranscript(path, kid, body)
// over the exact body text, and the body's `ts` is within ASSERTION_SKEW_MS.
// Anything else is 401 bad_signature and writes nothing.
//
// POST /stripe/webhook is the one public route (internet traffic, with
// cf-connecting-ip). @oa/billing-core's handleStripeWebhook reads the raw
// body once and checks its Stripe-Signature itself, so billing never reads
// the body first. A missing STRIPE_WEBHOOK_SECRET (a Worker secret) is 500
// config, body unread. Any other method or path stays the plain 404.
//
// Logs carry fixed categories and install ids only: never bodies, headers or
// URLs.

import {
  type CheckoutTier,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  handleStripeWebhook,
  StripeApiError,
  type StripeConfig,
  StripeConfigError,
} from "@oa/billing-core";
import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import {
  GATE_APP_HOST_HEADER,
  GATE_INSTALL_HEADER,
} from "@oa/broker-core/gate-header";
import { isAppHost, type Env as OaEnv, TRIAL_MS } from "@oa/provision/names";

export interface Env {
  BILLING_DB: D1Database;
  /** The install registry (read-only): the namespace the auth broker reads. */
  BROKER_REGISTRY: KVNamespace;
  /** staging or prod: picks the app domain the gate's app host must be on. */
  OA_ENV: OaEnv;
  /** Stripe test-mode secret key (a Worker secret; billing-core refuses live keys). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (a Worker secret: never a var, never logged). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The env's Stripe price ids, one per paid plan (placeholders, filled at deploy). */
  STRIPE_PRICE_TEAM: string;
  STRIPE_PRICE_BUSINESS: string;
}

export { TRIAL_MS };
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

/** 401 bad_signature, logged by fixed outcome and install id. */
function badSignature(outcome: string, install: string) {
  console.log("billing signature", outcome, install);
  return bad("bad_signature", 401);
}

/**
 * A signed POST's body as a JSON object, or the refusal. The kid must be one
 * of the GATE install's registry keys (never the body's install), the
 * signature must cover this route's path and the exact body text, and the
 * body's `ts` must be within ASSERTION_SKEW_MS of now. Runs before any write.
 *
 * There is no nonce (jti): the same signed body can be replayed within the
 * skew window. That is accepted only because every POST is idempotent (a
 * trial starts once; /usage overwrites the month with the same data;
 * /checkout and /portal key each Stripe call by the body's ts, so a replay
 * gets the same session and the customer is made once). Any future POST that
 * is not idempotent must add a nonce and a seen-store first.
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
  if (!kid || !sig) return badSignature("missing", install);
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry) return badSignature("unknown_install", install);
  if (!(await verifyAssertion(entry, path, kid, text, sig)))
    return badSignature("bad", install);
  const body = jsonObject(text);
  if (!body) return bad("bad_body");
  if (
    typeof body.ts !== "number" ||
    !(Math.abs(now - body.ts) <= ASSERTION_SKEW_MS)
  )
    return badSignature("stale", install);
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

/** Each signed POST's allowed body keys; any other field is 400 bad_body. */
const BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  "/checkout": ["install", "ts", "plan"],
  "/portal": ["install", "ts"],
};
/** Only a Stripe-hosted page is ever passed back. */
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;
const PORTAL_URL = /^https:\/\/billing\.stripe\.com\//;
/** billing-core's price id shape; checked before any customer is made. */
const PRICE_ID = /^price_[A-Za-z0-9]{1,255}$/;

// The free/active row, created first when missing (as /trial/start does).
// Version 0 is what GET /tier shows for no row, so the view is unchanged.
const ENSURE_ROW_SQL =
  "INSERT INTO tiers (install_id, tier, status, version, updated_at) VALUES (?1, 'free', 'active', 0, ?2) ON CONFLICT (install_id) DO NOTHING";
const CUSTOMER_SQL =
  "SELECT stripe_customer_id FROM tiers WHERE install_id = ?1";
// Only where none is mapped yet: a concurrent winner's id is kept.
const MAP_CUSTOMER_SQL =
  "UPDATE tiers SET stripe_customer_id = ? WHERE install_id = ? AND stripe_customer_id IS NULL";

/** A Stripe failure, as the route's answer (logged by category only). */
class StripeFailure {
  constructor(public res: Response) {}
}

/**
 * Runs one billing-core call: StripeConfigError is 500 config and
 * StripeApiError (bad_answer: bad_upstream) or a network error is 502
 * upstream, each logged as a fixed category with the install id.
 */
async function stripe<T>(install: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StripeConfigError) {
      console.error("billing stripe config", install);
      throw new StripeFailure(bad("config", 500));
    }
    // An idempotent request still in progress (a concurrent call with the
    // same key): the caller may retry it.
    if (e instanceof StripeApiError && e.status === 409) {
      console.error("billing stripe retry", install);
      throw new StripeFailure(bad("retry", 503));
    }
    if (e instanceof StripeApiError && e.type === "bad_answer") {
      console.error("billing stripe bad_upstream", install);
      throw new StripeFailure(bad("bad_upstream", 502));
    }
    console.error("billing stripe upstream", install);
    throw new StripeFailure(bad("upstream", 502));
  }
}

/** The body's own fields only, and an integer ts (it keys the session). */
function strictBody(body: Record<string, unknown>, path: string): boolean {
  const keys = BODY_KEYS[path] ?? [];
  return (
    Object.keys(body).every((k) => keys.includes(k)) &&
    Number.isSafeInteger(body.ts)
  );
}

/**
 * The install's Stripe customer id. The mapping is read first; with none,
 * the row is made if missing, billing-core creates the customer (one per
 * install: Idempotency-Key cust-<install>), the id is written only where
 * none is mapped, and the row is read again so a concurrent winner's id is
 * the one used.
 */
async function customerFor(
  db: D1Database,
  install: string,
  cfg: StripeConfig,
  now: number,
): Promise<string> {
  const read = async () =>
    (
      await db
        .prepare(CUSTOMER_SQL)
        .bind(install)
        .first<{ stripe_customer_id: string | null }>()
    )?.stripe_customer_id ?? null;
  const mapped = await read();
  if (mapped) return mapped;
  await db.prepare(ENSURE_ROW_SQL).bind(install, now).run();
  const { id } = await stripe(install, () =>
    createCustomer(
      { installId: install, idempotencyKey: `cust-${install}` },
      cfg,
    ),
  );
  // One in-request retry of the write; a second failure is the route's 503.
  const map = () => db.prepare(MAP_CUSTOMER_SQL).bind(id, install).run();
  const wrote = await map().catch(() => {
    console.error("billing customer map_retry", install);
    return map();
  });
  console.log(
    "billing customer",
    wrote.meta.changes === 1 ? "mapped" : "kept",
    install,
  );
  const winner = await read();
  if (!winner) throw new Error("customer mapping missing after write");
  return winner;
}

async function checkout(
  env: Env,
  install: string,
  appHost: string,
  body: Record<string, unknown>,
) {
  const { plan } = body;
  if (plan !== "team" && plan !== "business") return bad("bad_plan");
  const tier: CheckoutTier = plan;
  const priceId =
    tier === "team" ? env.STRIPE_PRICE_TEAM : env.STRIPE_PRICE_BUSINESS;
  // An unfilled or malformed price never gets as far as a customer.
  if (typeof priceId !== "string" || !PRICE_ID.test(priceId)) {
    console.error("billing stripe config", install);
    return bad("config", 500);
  }
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const customerId = await customerFor(
    env.BILLING_DB,
    install,
    cfg,
    Date.now(),
  );
  const base = `https://${appHost}/settings/billing`;
  const s = await stripe(install, () =>
    createCheckoutSession(
      {
        customerId,
        priceId,
        tier,
        successUrl: `${base}?checkout=done`,
        cancelUrl: `${base}?checkout=cancel`,
        // Plan in the key: the same ts with another plan is a new session,
        // never Stripe's 400 for a reused key with other params.
        idempotencyKey: `checkout-${install}-${tier}-${body.ts}`,
      },
      cfg,
    ),
  );
  return answer(install, "checkout", s.url, CHECKOUT_URL);
}

async function portal(
  env: Env,
  install: string,
  appHost: string,
  body: Record<string, unknown>,
) {
  const row = await env.BILLING_DB.prepare(CUSTOMER_SQL)
    .bind(install)
    .first<{ stripe_customer_id: string | null }>();
  const customerId = row?.stripe_customer_id;
  if (!customerId) {
    console.log("billing portal no_customer", install);
    return bad("no_customer", 409);
  }
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const s = await stripe(install, () =>
    createPortalSession(
      {
        customerId,
        returnUrl: `https://${appHost}/settings/billing`,
        idempotencyKey: `portal-${install}-${body.ts}`,
      },
      cfg,
    ),
  );
  return answer(install, "portal", s.url, PORTAL_URL);
}

/** `{url}` only, and only a Stripe-hosted page (else 502 bad_upstream). */
function answer(install: string, route: string, url: string, host: RegExp) {
  if (!host.test(url)) {
    console.error("billing stripe bad_upstream", install);
    return bad("bad_upstream", 502);
  }
  console.log("billing", route, "session", install);
  return Response.json({ url });
}

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
  "POST /checkout",
  "POST /portal",
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
    // The one public route: reachable with cf-connecting-ip (Stripe's
    // delivery). billing-core reads and verifies the body; billing doesn't.
    if (route === "POST /stripe/webhook") {
      const secret = env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        await req.body?.cancel();
        console.error("billing webhook config");
        return bad("config", 500);
      }
      return handleStripeWebhook(
        req,
        { BILLING_DB: env.BILLING_DB, STRIPE_WEBHOOK_SECRET: secret },
        Date.now(),
      );
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
      if (route === "POST /checkout" || route === "POST /portal") {
        if (body.install !== install) return bad("install_mismatch", 403);
        if (!strictBody(body, url.pathname)) return bad("bad_body");
        // The redirect origin: the gate's header (its props), and only an
        // app host on this env's app domain.
        const appHost = req.headers.get(GATE_APP_HOST_HEADER);
        if (!isAppHost(appHost, env.OA_ENV)) {
          console.error("billing bad_app_host", install);
          return bad("bad_app_host", 500);
        }
        try {
          return route === "POST /checkout"
            ? await checkout(env, install, appHost, body)
            : await portal(env, install, appHost, body);
        } catch (e) {
          if (e instanceof StripeFailure) return e.res;
          throw e;
        }
      }
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
