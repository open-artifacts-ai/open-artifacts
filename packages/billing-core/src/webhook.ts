// POST billing.<zone>/stripe/webhook, mounted by oa-<p>-billing (#849):
//   handleStripeWebhook(req, { BILLING_DB, STRIPE_WEBHOOK_SECRET }, now)
//
// 1. The raw body is read once (at most MAX_WEBHOOK_BODY bytes, UTF-8) and
//    the Stripe-Signature checked over it, timestamp within 5 minutes,
//    BEFORE anything parses it. Bad: 400 bad_signature, nothing written.
// 2. Idempotency: the event id goes into stripe_events in the same D1 batch
//    as the change, and the change runs only when that insert added the row
//    (changes() = 1). A replay is 200 with no change.
// 3. The customer maps to an install only by tiers.stripe_customer_id: an
//    event can only ever change the row whose customer it names, never an
//    install it names in metadata or anywhere else. An unknown customer is
//    409 and its event id is NOT recorded, so Stripe retries it (billing's
//    /checkout writes the customer id before the session exists; this is
//    the backstop for the window in between).
// 4. Ordering: Stripe delivers out of order. Each row keeps the newest
//    applied event's `created` (last_event_created); an older event is
//    recorded and skipped. At the same second, nothing changes a lapsed row,
//    so a delayed update or a retried checkout never revives a deleted
//    subscription.
// 5. The row's tier, status, trial_ends_at and grace_until move as below,
//    with version = version + 1 (installs never accept an older version).
//
// Logs: fixed categories and the install id only; never a body, header or
// Stripe id. Stripe test mode only: a livemode event changes nothing.

/** Webhook bodies are a few KB; anything this large is refused unread. */
export const MAX_WEBHOOK_BODY = 1024 * 1024;
/** past_due keeps the paid tier this long (then the install is read-only). */
export const GRACE_MS = 7 * 86_400_000;

export interface WebhookEnv {
  BILLING_DB: D1Database;
  STRIPE_WEBHOOK_SECRET: string;
}

import { verifyStripeSignature } from "./signature.js";

export type PaidTier = "team" | "business";
export type TierStatus = "active" | "past_due" | "lapsed" | "suspended";

/** The event fields we act on; anything else in Stripe's payload is ignored. */
export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  /** Stripe's event time, epoch seconds: the ordering key. */
  created: number;
  /** data.object */
  object: Record<string, unknown>;
};

export const HANDLED = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
] as const;

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,255}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,255}$/;
const SUB_ID = /^sub_[A-Za-z0-9]{1,255}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The event, or null when it isn't a Stripe event shape. Pure. */
export function parseEvent(text: string): StripeEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.object !== "event") return null;
  const { id, type, livemode, created, data } = raw;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return null;
  if (typeof type !== "string" || typeof livemode !== "boolean") return null;
  if (
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created < 0
  )
    return null;
  if (!isObj(data) || !isObj(data.object)) return null;
  return { id, type, livemode, created, object: data.object };
}

/** An object's customer id (a string or an expanded customer), or null. */
export function customerOf(o: Record<string, unknown>): string | null {
  const c = o.customer;
  const id = typeof c === "string" ? c : isObj(c) ? c.id : null;
  return typeof id === "string" && CUSTOMER_ID.test(id) ? id : null;
}

const asTier = (v: unknown): PaidTier | null =>
  v === "team" || v === "business" ? v : null;

/**
 * A subscription's paid tier: its metadata.tier (Checkout writes it through
 * subscription_data), else the first item whose price lookup_key, or price
 * metadata.tier, names one. Null when none does (the tier is then left as
 * it is). Pure.
 */
export function tierFromSubscription(
  sub: Record<string, unknown>,
): PaidTier | null {
  const own = isObj(sub.metadata) ? asTier(sub.metadata.tier) : null;
  if (own) return own;
  const items =
    isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  for (const item of items) {
    if (!isObj(item) || !isObj(item.price)) continue;
    const p = item.price;
    const t =
      asTier(p.lookup_key) ??
      (isObj(p.metadata) ? asTier(p.metadata.tier) : null);
    if (t) return t;
  }
  return null;
}

/** Stripe subscription status → ours; null leaves the status as it is. Pure. */
export function statusFromSubscription(s: unknown): TierStatus | null {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "lapsed";
    default:
      // incomplete: the first payment is still pending; nothing changes.
      return null;
  }
}

/** One column assignment in the row update: SQL and its binds. */
type Set = { sql: string; args: unknown[] };

/**
 * The change an event makes to its customer's row, or null for an event we
 * don't act on. Pure: `now` is the caller's clock.
 */
export function changeFor(ev: StripeEvent, now: number): Set[] | null {
  const o = ev.object;
  switch (ev.type) {
    case "checkout.session.completed": {
      const sub =
        typeof o.subscription === "string" && SUB_ID.test(o.subscription)
          ? o.subscription
          : null;
      const sets: Set[] = [];
      if (sub) sets.push({ sql: "stripe_subscription_id = ?", args: [sub] });
      // Paid (or nothing to pay): active at its tier. Otherwise (an async
      // payment still pending) the status and tier wait for the invoice and
      // subscription events.
      if (
        o.payment_status === "paid" ||
        o.payment_status === "no_payment_required"
      ) {
        sets.push(
          { sql: "status = 'active'", args: [] },
          { sql: "grace_until = NULL", args: [] },
        );
        const tier = isObj(o.metadata) ? asTier(o.metadata.tier) : null;
        if (tier) sets.push({ sql: "tier = ?", args: [tier] });
      }
      return sets.length ? sets : null;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sets: Set[] = [];
      const status = statusFromSubscription(o.status);
      // incomplete (first payment pending): no tier yet either.
      const tier = status ? tierFromSubscription(o) : null;
      if (tier) sets.push({ sql: "tier = ?", args: [tier] });
      if (status === "active")
        sets.push(
          { sql: "status = 'active'", args: [] },
          { sql: "grace_until = NULL", args: [] },
        );
      else if (status === "past_due")
        sets.push(
          { sql: "status = 'past_due'", args: [] },
          {
            sql: "grace_until = coalesce(grace_until, ?)",
            args: [now + GRACE_MS],
          },
        );
      else if (status === "lapsed")
        sets.push(
          { sql: "status = 'lapsed'", args: [] },
          { sql: "grace_until = NULL", args: [] },
        );
      // Stripe's own trial (trialing), when one runs: its end.
      if (o.status === "trialing" && typeof o.trial_end === "number")
        sets.push({ sql: "trial_ends_at = ?", args: [o.trial_end * 1000] });
      if (typeof o.id === "string" && SUB_ID.test(o.id))
        sets.push({ sql: "stripe_subscription_id = ?", args: [o.id] });
      return sets.length ? sets : null;
    }
    case "customer.subscription.deleted":
      // Ended: read-only on the install at once; nothing is deleted.
      return [
        { sql: "status = 'lapsed'", args: [] },
        { sql: "grace_until = NULL", args: [] },
      ];
    case "invoice.payment_failed":
      // Grace from the first failure; a suspended or lapsed row stays so.
      return [
        {
          sql: "status = CASE WHEN status IN ('active', 'past_due') THEN 'past_due' ELSE status END",
          args: [],
        },
        {
          sql: "grace_until = CASE WHEN status IN ('active', 'past_due') THEN coalesce(grace_until, ?) ELSE grace_until END",
          args: [now + GRACE_MS],
        },
      ];
    case "invoice.paid":
      // Only a past_due row comes back: an old invoice never revives a
      // lapsed or suspended one.
      return [
        {
          sql: "status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END",
          args: [],
        },
        {
          sql: "grace_until = CASE WHEN status = 'past_due' THEN NULL ELSE grace_until END",
          args: [],
        },
      ];
    default:
      return null;
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** One fixed-category line, the install id only (never a Stripe id). */
const log = (category: string, install?: string | null) =>
  console.log("billing webhook", category, ...(install ? [install] : []));

async function rawText(req: Request): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_WEBHOOK_BODY)) {
    await req.body?.cancel();
    return null;
  }
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_WEBHOOK_BODY) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

const INSERT_EVENT =
  "INSERT INTO stripe_events (event_id, received_at) VALUES (?1, ?2) ON CONFLICT (event_id) DO NOTHING";
/** Recorded only when the customer is known (an unknown one is retried). */
const INSERT_KNOWN_EVENT =
  "INSERT INTO stripe_events (event_id, received_at) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM tiers WHERE stripe_customer_id = ?3) ON CONFLICT (event_id) DO NOTHING";
const KNOWN =
  "SELECT EXISTS (SELECT 1 FROM tiers WHERE stripe_customer_id = ?) AS known";
/**
 * Newer than the row's last applied event; at the same second, never on a
 * lapsed row (a delayed update or retried checkout can't revive it).
 */
const IN_ORDER =
  "(?1 > coalesce(last_event_created, 0) OR (?1 = coalesce(last_event_created, 0) AND status IS NOT 'lapsed'))";

/** The Stripe webhook route. Never throws: a D1 error is 500 (Stripe retries). */
export async function handleStripeWebhook(
  req: Request,
  env: WebhookEnv,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") {
    await req.body?.cancel();
    return json({ error: "method_not_allowed" }, 405);
  }
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret.startsWith("whsec_")) {
    await req.body?.cancel();
    log("misconfigured");
    return json({ error: "misconfigured" }, 500);
  }
  const text = await rawText(req);
  if (text === null) {
    log("bad_body");
    return json({ error: "bad_body" }, 400);
  }
  const sig = await verifyStripeSignature(
    text,
    req.headers.get("stripe-signature"),
    secret,
    now,
  );
  if (!sig.ok) {
    log(`bad_signature_${sig.reason}`);
    return json({ error: "bad_signature" }, 400);
  }
  const ev = parseEvent(text);
  if (!ev) {
    log("bad_event");
    return json({ error: "bad_event" }, 400);
  }
  // No live keys anywhere: a live event (only possible on a misconfigured
  // endpoint) is acknowledged and changes nothing.
  if (ev.livemode) {
    log("livemode_ignored");
    return json({ received: true });
  }
  const change = changeFor(ev, now);
  const customer = customerOf(ev.object);
  try {
    const db = env.BILLING_DB;
    if (!change || !customer) {
      const res = await db.batch([db.prepare(INSERT_EVENT).bind(ev.id, now)]);
      const fresh = (res[0]?.meta.changes ?? 0) > 0;
      log(!fresh ? "replay" : !change ? "ignored_type" : "no_customer");
      return json({ received: true });
    }
    const sets = [
      ...change,
      { sql: "last_event_created = ?", args: [ev.created] },
      { sql: "version = version + 1", args: [] },
      { sql: "updated_at = ?", args: [now] },
    ];
    // Positional binds after the numbered ?1 in IN_ORDER would collide, so
    // the ordering check binds its own copy of `created` by number last.
    const n = sets.reduce((k, s) => k + s.args.length, 0);
    const order = IN_ORDER.replaceAll("?1", `?${n + 2}`);
    const res = await db.batch<{ known?: number; install_id?: string }>([
      db.prepare(KNOWN).bind(customer),
      db.prepare(INSERT_KNOWN_EVENT).bind(ev.id, now, customer),
      db
        .prepare(
          // changes() is the event insert's: 1 the first time, 0 on a
          // replay or an unknown customer.
          `UPDATE tiers SET ${sets.map((s) => s.sql).join(", ")} WHERE stripe_customer_id = ? AND changes() = 1 AND ${order} RETURNING install_id`,
        )
        .bind(...sets.flatMap((s) => s.args), customer, ev.created),
    ]);
    if (!res[0]?.results[0]?.known) {
      // Not recorded: Stripe retries until billing has written the customer.
      log("unknown_customer");
      return json({ error: "unknown_customer" }, 409);
    }
    if ((res[1]?.meta.changes ?? 0) === 0) {
      log("replay");
      return json({ received: true });
    }
    const install = res[2]?.results[0]?.install_id ?? null;
    log(install ? "applied" : "stale", install);
    return json({ received: true });
  } catch {
    // Never the error text: it can carry a D1 message.
    log("db_error");
    return json({ error: "unavailable" }, 500);
  }
}
