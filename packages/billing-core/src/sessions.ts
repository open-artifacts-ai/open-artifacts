// Stripe Checkout and Customer Portal sessions, for oa-<p>-billing's signed
// POST /checkout and /portal routes (the install asks through BillingGate;
// billing holds the secret key and answers only the URL). No Stripe SDK: one
// form-encoded POST each, with an Idempotency-Key.
//
// Every URL is billing's own (passed in by billing, never taken from a
// request), https only. Stripe test mode only: a key that isn't sk_test_ or
// rk_test_ is refused before any call. Errors never carry Stripe's body.

export const STRIPE_API = "https://api.stripe.com";

export interface StripeConfig {
  /** sk_test_... or rk_test_... (a Worker secret; never in code or argv). */
  secretKey: string;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Test seam; defaults to STRIPE_API. */
  apiBase?: string;
}

export interface CheckoutInput {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** Seats at checkout (the creator count follows on each report). Default 1. */
  quantity?: number;
}

export interface PortalInput {
  customerId: string;
  returnUrl: string;
  idempotencyKey: string;
}

export type StripeSession = { id: string; url: string };

/** A refused input or key, before any call. */
export class StripeConfigError extends Error {
  constructor(public field: string) {
    super(`invalid ${field}`);
    this.name = "StripeConfigError";
  }
}

/** Stripe answered with an error (status and error type only). */
export class StripeApiError extends Error {
  constructor(
    public status: number,
    public type: string,
  ) {
    super(`stripe ${status} ${type}`);
    this.name = "StripeApiError";
  }
}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{8,255}$/;
const CUSTOMER = /^cus_[A-Za-z0-9]{1,255}$/;
const PRICE = /^price_[A-Za-z0-9]{1,255}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_:.-]{8,255}$/;

function https(field: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new StripeConfigError(field);
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new StripeConfigError(field);
  return u.toString();
}

function check(re: RegExp, field: string, v: string): string {
  if (!re.test(v)) throw new StripeConfigError(field);
  return v;
}

async function post(
  cfg: StripeConfig,
  path: string,
  form: Record<string, string>,
  idempotencyKey: string,
  urlHost: RegExp,
): Promise<StripeSession> {
  check(TEST_KEY, "secretKey", cfg.secretKey);
  check(IDEMPOTENCY, "idempotencyKey", idempotencyKey);
  const res = await (cfg.fetch ?? fetch)(
    `${cfg.apiBase ?? STRIPE_API}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": idempotencyKey,
      },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    },
  );
  let out: Record<string, unknown> | null = null;
  try {
    out = (await res.json()) as Record<string, unknown>;
  } catch {
    out = null;
  }
  if (!res.ok) {
    const err = out?.error as { type?: unknown } | undefined;
    throw new StripeApiError(
      res.status,
      typeof err?.type === "string" ? err.type : "unknown",
    );
  }
  const id = out?.id;
  const url = out?.url;
  if (typeof id !== "string" || typeof url !== "string" || !urlHost.test(url))
    throw new StripeApiError(res.status, "bad_answer");
  return { id, url };
}

/** A subscription Checkout session for `customerId` at `priceId`. */
export function createCheckoutSession(
  input: CheckoutInput,
  cfg: StripeConfig,
): Promise<StripeSession> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
    throw new StripeConfigError("quantity");
  return post(
    cfg,
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer: check(CUSTOMER, "customerId", input.customerId),
      "line_items[0][price]": check(PRICE, "priceId", input.priceId),
      "line_items[0][quantity]": String(quantity),
      success_url: https("successUrl", input.successUrl),
      cancel_url: https("cancelUrl", input.cancelUrl),
    },
    input.idempotencyKey,
    /^https:\/\/checkout\.stripe\.com\//,
  );
}

/** A Customer Portal session for `customerId`. */
export function createPortalSession(
  input: PortalInput,
  cfg: StripeConfig,
): Promise<StripeSession> {
  return post(
    cfg,
    "/v1/billing_portal/sessions",
    {
      customer: check(CUSTOMER, "customerId", input.customerId),
      return_url: https("returnUrl", input.returnUrl),
    },
    input.idempotencyKey,
    /^https:\/\/billing\.stripe\.com\//,
  );
}
