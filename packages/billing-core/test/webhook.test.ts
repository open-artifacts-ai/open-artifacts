import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  changeFor,
  GRACE_MS,
  handleStripeWebhook,
  parseEvent,
  parseSignatureHeader,
  STRIPE_TOLERANCE_S,
  signStripePayload,
  statusFromSubscription,
  tierFromSubscription,
  verifyStripeSignature,
  type WebhookEnv,
} from "../src/index.js";

// The webhook against the tier store's real tables (#849 0001_init.sql).
// Signatures are made here with a test secret; no Stripe call is made.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
/** A test-only signing secret (not a real endpoint's). */
const SECRET = "whsec_test_billing_core_0123456789abcdef";
const env: WebhookEnv = { BILLING_DB: db, STRIPE_WEBHOOK_SECRET: SECRET };
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const T = Math.floor(NOW / 1000);
const A = "iabc123def45";
const B = "izzz999yyy88";
const CUS_A = "cus_TestA0001";
const CUS_B = "cus_TestB0002";

beforeAll(async () => {
  await applyD1Migrations(
    db,
    (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM stripe_events"),
  ]);
  await seed(A, CUS_A, "trial");
  await seed(B, CUS_B, "team");
});
afterEach(() => vi.restoreAllMocks());

async function seed(install: string, customer: string, tier: string) {
  await db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, trial_ends_at, grace_until, stripe_customer_id, version, updated_at) VALUES (?, ?, 'active', NULL, NULL, ?, 1, 1)",
    )
    .bind(install, tier, customer)
    .run();
}
type Row = {
  install_id: string;
  tier: string;
  status: string;
  trial_ends_at: number | null;
  grace_until: number | null;
  stripe_subscription_id: string | null;
  version: number;
  updated_at: number;
};
const row = async (install: string) =>
  db
    .prepare("SELECT * FROM tiers WHERE install_id = ?")
    .bind(install)
    .first<Row>() as Promise<Row>;

let n = 0;
const event = (
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: `evt_test${++n}`,
  object: "event",
  type,
  livemode: false,
  created: T,
  data: { object },
  ...extra,
});
const sub = (o: Record<string, unknown> = {}) => ({
  id: "sub_Test1",
  object: "subscription",
  customer: CUS_A,
  status: "active",
  items: { data: [{ price: { id: "price_Team", lookup_key: "team" } }] },
  ...o,
});

async function deliver(
  body: unknown,
  o: { t?: number; secret?: string; text?: string; now?: number } = {},
) {
  const text = o.text ?? JSON.stringify(body);
  const sig = await signStripePayload(text, o.secret ?? SECRET, o.t ?? T);
  return handleStripeWebhook(
    new Request("https://billing.example/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: text,
    }),
    env,
    o.now ?? NOW,
  );
}

describe("signature", () => {
  it("accepts the right secret within 5 minutes, either way, and nothing else", async () => {
    const body = '{"a":1}';
    const h = await signStripePayload(body, SECRET, T);
    expect(await verifyStripeSignature(body, h, SECRET, NOW)).toEqual({
      ok: true,
      timestamp: T,
    });
    const edge = NOW + STRIPE_TOLERANCE_S * 1000;
    expect((await verifyStripeSignature(body, h, SECRET, edge)).ok).toBe(true);
    expect(await verifyStripeSignature(body, h, SECRET, edge + 1000)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await verifyStripeSignature(
        body,
        h,
        SECRET,
        NOW - STRIPE_TOLERANCE_S * 1000 - 1000,
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await verifyStripeSignature(`${body} `, h, SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyStripeSignature(body, h, "whsec_other", NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyStripeSignature(body, null, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyStripeSignature(body, "v1=abc", SECRET, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await verifyStripeSignature(body, `t=${T},v1=zz`, SECRET, NOW),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("any of several v1 signatures may match (secret rotation); v0 never counts", async () => {
    const body = "{}";
    const good = (await signStripePayload(body, SECRET, T)).split(
      ",",
    )[1] as string;
    const old = (await signStripePayload(body, "whsec_old", T)).split(
      ",",
    )[1] as string;
    expect(
      (await verifyStripeSignature(body, `t=${T},${old},${good}`, SECRET, NOW))
        .ok,
    ).toBe(true);
    expect(
      (
        await verifyStripeSignature(
          body,
          `t=${T},v0=${good.slice(3)}`,
          SECRET,
          NOW,
        )
      ).ok,
    ).toBe(false);
    expect(parseSignatureHeader(`t=${T},t=${T},${good}`)).toBeNull();
  });
});

describe("pure helpers", () => {
  it("parseEvent takes Stripe's event shape only", () => {
    expect(
      parseEvent(JSON.stringify(event("invoice.paid", { customer: CUS_A }))),
    ).toMatchObject({ type: "invoice.paid", livemode: false });
    expect(parseEvent("not json")).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({
          object: "event",
          id: "nope",
          type: "x",
          livemode: false,
          data: { object: {} },
        }),
      ),
    ).toBeNull();
    expect(
      parseEvent(JSON.stringify({ ...event("x", {}), data: [] })),
    ).toBeNull();
  });

  it("tierFromSubscription reads the price lookup key, price metadata, then the subscription's", () => {
    expect(tierFromSubscription(sub())).toBe("team");
    expect(
      tierFromSubscription(
        sub({
          items: { data: [{ price: { metadata: { tier: "business" } } }] },
        }),
      ),
    ).toBe("business");
    expect(
      tierFromSubscription(
        sub({ items: { data: [] }, metadata: { tier: "business" } }),
      ),
    ).toBe("business");
    expect(
      tierFromSubscription(
        sub({ items: { data: [{ price: { lookup_key: "enterprise" } }] } }),
      ),
    ).toBeNull();
    expect(statusFromSubscription("trialing")).toBe("active");
    expect(statusFromSubscription("unpaid")).toBe("past_due");
    expect(statusFromSubscription("canceled")).toBe("lapsed");
    expect(statusFromSubscription("incomplete")).toBeNull();
    expect(
      changeFor(
        { id: "evt_x", type: "charge.refunded", livemode: false, object: {} },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("handleStripeWebhook", () => {
  it("checkout completed, then the subscription: paid team, version bumped", async () => {
    expect(
      (
        await deliver(
          event("checkout.session.completed", {
            customer: CUS_A,
            subscription: "sub_Test1",
            mode: "subscription",
          }),
        )
      ).status,
    ).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      stripe_subscription_id: "sub_Test1",
      version: 2,
      updated_at: NOW,
    });
    expect(
      (await deliver(event("customer.subscription.created", sub()))).status,
    ).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      grace_until: null,
      version: 3,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ items: { data: [{ price: { lookup_key: "business" } }] } }),
      ),
    );
    expect((await row(A)).tier).toBe("business");
  });

  it("payment failed starts grace once; paid ends it; deleted lapses; nothing is deleted", async () => {
    await deliver(event("invoice.payment_failed", { customer: CUS_A }));
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: NOW + GRACE_MS,
    });
    await deliver(event("invoice.payment_failed", { customer: CUS_A }), {
      now: NOW + 1000,
    });
    expect((await row(A)).grace_until).toBe(NOW + GRACE_MS);
    await deliver(event("invoice.paid", { customer: CUS_A }));
    expect(await row(A)).toMatchObject({ status: "active", grace_until: null });
    await deliver(event("customer.subscription.deleted", sub()));
    expect(await row(A)).toMatchObject({ tier: "trial", status: "lapsed" });
    // An old invoice paid never revives a lapsed row.
    await deliver(event("invoice.paid", { customer: CUS_A }));
    expect((await row(A)).status).toBe("lapsed");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM tiers")
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });

  it("a Stripe trial sets trialEndsAt; past_due from the subscription sets grace", async () => {
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "trialing", trial_end: T + 86_400 }),
      ),
    );
    expect((await row(A)).trial_ends_at).toBe((T + 86_400) * 1000);
    await deliver(
      event("customer.subscription.updated", sub({ status: "past_due" })),
    );
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: NOW + GRACE_MS,
    });
  });

  it("idempotent: a replayed event id changes nothing", async () => {
    const ev = event("invoice.payment_failed", { customer: CUS_A });
    await deliver(ev);
    const once = await row(A);
    expect((await deliver(ev, { now: NOW + 5000 })).status).toBe(200);
    expect(await row(A)).toEqual(once);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM stripe_events")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("one install's event never changes another install's row", async () => {
    const before = await row(B);
    // Customer A's events, one of them naming install B everywhere it can.
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "canceled", metadata: { install: B, tier: "business" } }),
      ),
    );
    await deliver(
      event("invoice.payment_failed", {
        customer: CUS_A,
        metadata: { install: B },
      }),
    );
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        client_reference_id: B,
        metadata: { install: B },
      }),
    );
    expect(await row(B)).toEqual(before);
    expect((await row(A)).version).toBe(4);
  });

  it("an unknown customer is 200 with no change", async () => {
    const a = await row(A);
    const b = await row(B);
    expect(
      (
        await deliver(
          event("invoice.payment_failed", { customer: "cus_Nobody" }),
        )
      ).status,
    ).toBe(200);
    expect(await row(A)).toEqual(a);
    expect(await row(B)).toEqual(b);
  });

  it("refuses before parsing: bad or stale signature, wrong secret, oversize; nothing written", async () => {
    const ev = event("invoice.payment_failed", { customer: CUS_A });
    expect((await deliver(ev, { secret: "whsec_someone_else" })).status).toBe(
      400,
    );
    expect((await deliver(ev, { t: T - STRIPE_TOLERANCE_S - 1 })).status).toBe(
      400,
    );
    const big = await handleStripeWebhook(
      new Request("https://billing.example/stripe/webhook", {
        method: "POST",
        headers: {
          "content-length": String(2 * 1024 * 1024),
          "stripe-signature": "t=1,v1=00",
        },
        body: "x",
      }),
      env,
      NOW,
    );
    expect(big.status).toBe(400);
    // A signed body that isn't an event: signature first, then 400 bad_event.
    expect((await deliver(null, { text: '{"hello":1}' })).status).toBe(400);
    expect((await row(A)).version).toBe(1);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM stripe_events")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const misconfigured = await handleStripeWebhook(
      new Request("https://billing.example/stripe/webhook", {
        method: "POST",
        body: "{}",
      }),
      { ...env, STRIPE_WEBHOOK_SECRET: "" },
      NOW,
    );
    expect(misconfigured.status).toBe(500);
  });

  it("a livemode event changes nothing (test mode only)", async () => {
    const before = await row(A);
    expect(
      (
        await deliver(
          event(
            "invoice.payment_failed",
            { customer: CUS_A },
            { livemode: true },
          ),
        )
      ).status,
    ).toBe(200);
    expect(await row(A)).toEqual(before);
  });

  it("logs carry fixed categories and install ids only: no body, header or Stripe id", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    await deliver(event("customer.subscription.updated", sub()));
    await deliver(event("invoice.paid", { customer: "cus_Nobody" }));
    await deliver(event("invoice.paid", { customer: CUS_A }), {
      secret: "whsec_bad",
    });
    const all = lines.join("\n");
    expect(lines).toEqual([
      `billing webhook applied ${A}`,
      "billing webhook unknown_customer",
      "billing webhook bad_signature_mismatch",
    ]);
    for (const s of [
      CUS_A,
      "cus_Nobody",
      "sub_Test1",
      "evt_test",
      SECRET,
      "price_Team",
    ])
      expect(all).not.toContain(s);
  });
});
