import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import billing, { type Env } from "../src/index.js";

// POST /checkout and POST /portal: signed like the other POSTs, redirect URLs
// built only from the gate's app host, the Stripe customer created and mapped
// here first, an Idempotency-Key on every Stripe call, and only a
// Stripe-hosted URL passed back. Stripe is a fake global fetch.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
const SECRET = "sk_test_FAKEfakeFAKEfake0123456789";
const baseEnv = (): Env => ({
  BILLING_DB: db,
  BROKER_REGISTRY: registry,
  OA_ENV: "staging",
  STRIPE_SECRET_KEY: SECRET,
  STRIPE_PRICE_TEAM: "price_team1",
  STRIPE_PRICE_BUSINESS: "price_business1",
});
let env = baseEnv();

const A = "iabc123def45";
const B = "izzz999yyy88";
const HOST_A = "acme.open-artifacts-staging.app";
const HOST_B = "beta.open-artifacts-staging.app";
const ORIGIN = "https://billing.oa.internal";

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

// ------------------------------------------------------------ fake Stripe

type StripeCall = {
  path: string;
  key: string | null;
  auth: string | null;
  form: Record<string, string>;
};

type Override = (
  c: StripeCall,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Stripe as far as billing-core uses it. Like Stripe, a repeated
 * Idempotency-Key replays the first answer.
 */
function fakeStripe(override?: Override) {
  const calls: StripeCall[] = [];
  const replay = new Map<string, unknown>();
  let n = 0;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input
          : (input as Request).url,
      );
      if (url.origin !== "https://api.stripe.com")
        throw new Error(`unexpected fetch ${url.origin}`);
      const h = new Headers(init?.headers);
      const c: StripeCall = {
        path: url.pathname,
        key: h.get("idempotency-key"),
        auth: h.get("authorization"),
        form: Object.fromEntries(new URLSearchParams(String(init?.body))),
      };
      calls.push(c);
      const o = await override?.(c);
      if (o) return o;
      const k = `${c.path} ${c.key}`;
      if (!replay.has(k)) {
        n++;
        replay.set(
          k,
          c.path === "/v1/customers"
            ? { id: `cus_fake${n}` }
            : c.path === "/v1/checkout/sessions"
              ? {
                  id: `cs_test_${n}`,
                  url: `https://checkout.stripe.com/c/pay/cs_test_${n}`,
                }
              : {
                  id: `bps_${n}`,
                  url: `https://billing.stripe.com/p/session/test_${n}`,
                },
        );
      }
      return Response.json(replay.get(k));
    });
  return { calls, spy };
}

// ------------------------------------------------------------ requests

const pk = (fill: number) =>
  b64u(
    new Uint8Array([
      ...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65],
      ...[0x70, 0x04, 0x22, 0x04, 0x20],
      ...new Uint8Array(32).fill(fill),
    ]),
  );
function b64u(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const KEYS: Record<string, string> = { [A]: pk(1), [B]: pk(2) };
const kidOf = async (key: string) => keyId(await publicFromPkcs8(key));

async function register() {
  for (const [id, key] of Object.entries(KEYS)) {
    const x = await publicFromPkcs8(key);
    await registry.put(
      `install:${id}`,
      JSON.stringify({
        installId: id,
        origin: `https://${id}.example.test`,
        keys: [{ kid: await keyId(x), x }],
      }),
    );
  }
}

type Opts = {
  install?: string;
  appHost?: string | null;
  headers?: Record<string, string>;
  /** Sign with this install's key (default: the header install's). */
  signer?: string;
  /** The path the signature covers (default: the request's). */
  signPath?: string;
  unsigned?: boolean;
  query?: string;
};

/** A signed POST as BillingGate forwards it. `ts` defaults to now. */
async function req(path: string, body: Record<string, unknown>, o: Opts = {}) {
  const install = o.install ?? A;
  const text = JSON.stringify(
    "ts" in body ? body : { ...body, ts: Date.now() },
  );
  const key = KEYS[o.signer ?? install] as string;
  const kid = await kidOf(key);
  const appHost =
    o.appHost === undefined ? (install === B ? HOST_B : HOST_A) : o.appHost;
  return new Request(`${ORIGIN}${path}${o.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-gate-install": install,
      ...(appHost === null ? {} : { "x-oa-gate-app-host": appHost }),
      ...(o.unsigned
        ? {}
        : {
            "x-oa-kid": kid,
            "x-oa-sig": await signRequest(key, o.signPath ?? path, kid, text),
          }),
      ...o.headers,
    },
    body: text,
  });
}

const call = async (r: Request | Promise<Request>, e: Env = env) =>
  billing.fetch((await r) as Parameters<typeof billing.fetch>[0], e);

const rowOf = (install: string) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const customerOf = async (install: string) =>
  (await rowOf(install))?.stripe_customer_id ?? null;

async function seed(install: string, customer: string | null, tier = "free") {
  await db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, version, updated_at) VALUES (?1, ?2, 'active', ?3, 3, 0)",
    )
    .bind(install, tier, customer)
    .run();
}

beforeEach(async () => {
  env = baseEnv();
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
  ]);
  clearRegistryCache();
  await register();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CHECKOUT = "/v1/checkout/sessions";
const PORTAL = "/v1/billing_portal/sessions";
const CUSTOMERS = "/v1/customers";

// ------------------------------------------------------------ tests

describe("POST /checkout", () => {
  it("no row: makes the free row, creates and maps the customer, then the session; answers {url} only", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    const r = await call(req("/checkout", { install: A, ts, plan: "team" }));
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_2" });
    expect(s.calls.map((c) => [c.path, c.key])).toEqual([
      [CUSTOMERS, `cust-${A}`],
      [CHECKOUT, `checkout-${A}-${ts}`],
    ]);
    expect(s.calls[0]?.form).toEqual({ "metadata[install_id]": A });
    expect(s.calls[1]?.form).toEqual({
      mode: "subscription",
      customer: "cus_fake1",
      "line_items[0][price]": "price_team1",
      "line_items[0][quantity]": "1",
      success_url: `https://${HOST_A}/settings/billing?checkout=done`,
      cancel_url: `https://${HOST_A}/settings/billing?checkout=cancel`,
      "metadata[tier]": "team",
      "subscription_data[metadata][tier]": "team",
    });
    for (const c of s.calls) expect(c.auth).toBe(`Bearer ${SECRET}`);
    expect(await rowOf(A)).toMatchObject({
      tier: "free",
      status: "active",
      version: 0,
      stripe_customer_id: "cus_fake1",
    });
    expect(await rowOf(B)).toBeNull();
  });

  it("an existing mapping is used as is: no customer call, the row's tier untouched", async () => {
    await seed(A, "cus_existingA", "trial");
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "business" }));
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => c.path)).toEqual([CHECKOUT]);
    expect(s.calls[0]?.form.customer).toBe("cus_existingA");
    expect(s.calls[0]?.form["line_items[0][price]"]).toBe("price_business1");
    expect(s.calls[0]?.form["metadata[tier]"]).toBe("business");
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 3 });
  });

  it("a row without a customer keeps its tier; the id is added only to it", async () => {
    await seed(A, null, "trial");
    fakeStripe();
    expect(
      (await call(req("/checkout", { install: A, plan: "team" }))).status,
    ).toBe(200);
    expect(await rowOf(A)).toMatchObject({
      tier: "trial",
      version: 3,
      stripe_customer_id: "cus_fake1",
    });
  });

  it("a retried identical request (same ts) is the same customer and the same session", async () => {
    const s = fakeStripe();
    const body = { install: A, ts: Date.now(), plan: "team" };
    const r1 = await (await call(req("/checkout", body))).json();
    const r2 = await (await call(req("/checkout", body))).json();
    expect(r2).toEqual(r1);
    expect(s.calls.map((c) => c.key)).toEqual([
      `cust-${A}`,
      `checkout-${A}-${body.ts}`,
      `checkout-${A}-${body.ts}`,
    ]);
  });

  it("concurrent first checkouts create one customer (cust-<install>) and both sessions use it", async () => {
    const s = fakeStripe();
    const now = Date.now();
    const rs = await Promise.all([
      call(req("/checkout", { install: A, ts: now, plan: "team" })),
      call(req("/checkout", { install: A, ts: now + 1, plan: "team" })),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const cust = s.calls.filter((c) => c.path === CUSTOMERS);
    expect(new Set(cust.map((c) => c.key))).toEqual(new Set([`cust-${A}`]));
    const mapped = await customerOf(A);
    expect(
      s.calls.filter((c) => c.path === CHECKOUT).map((c) => c.form.customer),
    ).toEqual([mapped, mapped]);
  });

  it("two different customer answers racing: the first mapping wins, and both sessions use the winner (re-read)", async () => {
    // Both requests reach createCustomer before either writes; Stripe (as if
    // the key had expired) answers each with its own id.
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const s = fakeStripe(async (c) => {
      if (c.path !== CUSTOMERS) return undefined;
      if (++arrived === 2) release();
      await both;
      return Response.json({ id: `cus_race${++n}` });
    });
    const now = Date.now();
    const rs = await Promise.all([
      call(req("/checkout", { install: A, ts: now, plan: "team" })),
      call(req("/checkout", { install: A, ts: now + 1, plan: "team" })),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const mapped = await customerOf(A);
    expect(mapped).toMatch(/^cus_race[12]$/);
    expect(
      s.calls.filter((c) => c.path === CHECKOUT).map((c) => c.form.customer),
    ).toEqual([mapped, mapped]);
  });

  it("the customer is mapped before any session: a session failure still leaves the mapping", async () => {
    const s = fakeStripe((c) =>
      c.path === CHECKOUT
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : undefined,
    );
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "upstream" });
    expect(s.calls.map((c) => c.path)).toEqual([CUSTOMERS, CHECKOUT]);
    expect(await customerOf(A)).toBe("cus_fake1");
  });

  it("a bad plan, a non-integer ts or a missing install: refused before any Stripe call", async () => {
    const s = fakeStripe();
    for (const [body, status, error] of [
      [{ install: A, plan: "free" }, 400, "bad_plan"],
      [{ install: A, plan: "trial" }, 400, "bad_plan"],
      [{ install: A }, 400, "bad_plan"],
      [{ install: A, plan: "team", ts: Date.now() + 0.5 }, 400, "bad_body"],
      [{ plan: "team" }, 403, "install_mismatch"],
      [{ install: B, plan: "team" }, 403, "install_mismatch"],
    ] as [Record<string, unknown>, number, string][]) {
      const r = await call(req("/checkout", body));
      expect([r.status, await r.json()]).toEqual([status, { error }]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });
});

describe("POST /portal", () => {
  it("no mapping: 409 no_customer, no Stripe call, nothing written", async () => {
    const s = fakeStripe();
    const r = await call(req("/portal", { install: A }));
    expect([r.status, await r.json()]).toEqual([409, { error: "no_customer" }]);
    await seed(A, null);
    const r2 = await call(req("/portal", { install: A }));
    expect(r2.status).toBe(409);
    expect(s.calls).toEqual([]);
    expect(await customerOf(A)).toBeNull();
  });

  it("with a mapping: the portal session for it, return URL from the app host, keyed portal-<install>-<ts>", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const ts = Date.now();
    const r = await call(req("/portal", { install: A, ts }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      url: "https://billing.stripe.com/p/session/test_1",
    });
    expect(s.calls).toEqual([
      {
        path: PORTAL,
        key: `portal-${A}-${ts}`,
        auth: `Bearer ${SECRET}`,
        form: {
          customer: "cus_existingA",
          return_url: `https://${HOST_A}/settings/billing`,
        },
      },
    ]);
  });

  it("a body with any field beyond install and ts is 400 bad_body", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const extra of [
      { return_url: "https://evil.example/" },
      { returnUrl: "https://evil.example/" },
      { plan: "team" },
    ]) {
      const r = await call(req("/portal", { install: A, ...extra }));
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_body" }]);
    }
    expect(s.calls).toEqual([]);
  });
});

describe("the redirect origin comes only from the gate's app host", () => {
  it("a URL field in the body is 400 bad_body, before any Stripe call", async () => {
    const s = fakeStripe();
    for (const extra of [
      { success_url: "https://evil.example/" },
      { cancel_url: "https://evil.example/" },
      { successUrl: "https://evil.example/" },
      { return_url: "https://evil.example/" },
      { url: "https://evil.example/" },
      { origin: "https://evil.example" },
      { appHost: HOST_B },
    ]) {
      const r = await call(
        req("/checkout", { install: A, plan: "team", ...extra }),
      );
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_body" }]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });

  it("a request header or query never changes the URLs", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const evil = {
      host: HOST_B,
      origin: `https://${HOST_B}`,
      referer: `https://${HOST_B}/settings/billing`,
      "x-forwarded-host": HOST_B,
      "x-original-host": HOST_B,
    };
    const q = `?success_url=https://${HOST_B}/&return_url=https://${HOST_B}/&appHost=${HOST_B}`;
    for (const path of ["/checkout", "/portal"]) {
      const r = await call(
        req(
          path,
          {
            install: A,
            plan: "team",
            ...(path === "/portal" ? { plan: undefined } : {}),
          },
          { headers: evil, query: q },
        ),
      );
      expect(r.status).toBe(200);
    }
    const urls = s.calls.flatMap((c) =>
      ["success_url", "cancel_url", "return_url"]
        .map((k) => c.form[k])
        .filter((v) => v !== undefined),
    );
    expect(urls).toEqual([
      `https://${HOST_A}/settings/billing?checkout=done`,
      `https://${HOST_A}/settings/billing?checkout=cancel`,
      `https://${HOST_A}/settings/billing`,
    ]);
  });

  it("a missing app host, or one not on this env's app domain: 500 bad_app_host, no Stripe call", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const appHost of [
      null,
      "",
      "acme.open-artifacts.app",
      "acme.open-artifacts-staging.page",
      "a.b.open-artifacts-staging.app",
      "Acme.open-artifacts-staging.app",
      "acme.open-artifacts-staging.app.evil.test",
      "evil.example",
    ])
      for (const path of ["/checkout", "/portal"]) {
        const r = await call(
          req(
            path,
            path === "/checkout"
              ? { install: A, plan: "team" }
              : { install: A },
            { appHost },
          ),
        );
        expect([r.status, await r.json()]).toEqual([
          500,
          { error: "bad_app_host" },
        ]);
      }
    expect(s.calls).toEqual([]);
  });

  it("prod checks the prod app domain", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    env = { ...baseEnv(), OA_ENV: "prod" };
    expect(
      (await call(req("/portal", { install: A }, { appHost: HOST_A }))).status,
    ).toBe(500);
    const r = await call(
      req("/portal", { install: A }, { appHost: "acme.open-artifacts.app" }),
    );
    expect(r.status).toBe(200);
    expect(s.calls[0]?.form.return_url).toBe(
      "https://acme.open-artifacts.app/settings/billing",
    );
  });
});

describe("signing and the gate rules hold for both routes", () => {
  it("cf-connecting-ip: the plain 404, nothing called or written", async () => {
    const s = fakeStripe();
    for (const path of ["/checkout", "/portal"]) {
      const r = await call(
        req(
          path,
          { install: A, plan: "team" },
          {
            headers: { "cf-connecting-ip": "1.2.3.4" },
          },
        ),
      );
      expect([r.status, await r.text()]).toEqual([404, "Not found"]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });

  it("unsigned, signed for another route, by another install, or stale: 401, nothing called or written", async () => {
    await seed(B, "cus_existingB");
    const s = fakeStripe();
    for (const path of ["/checkout", "/portal"]) {
      const body = { install: A, plan: "team" };
      for (const o of [
        { unsigned: true },
        { signPath: path === "/checkout" ? "/portal" : "/checkout" },
        { signPath: "/trial/start" },
        { signer: B },
      ] as Opts[]) {
        const r = await call(req(path, body, o));
        expect([r.status, await r.json()]).toEqual([
          401,
          { error: "bad_signature" },
        ]);
      }
      const stale = await call(
        req(path, { ...body, ts: Date.now() - 120_000 }),
      );
      expect(stale.status).toBe(401);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });
});

describe("red-line: install A can never get a session for install B", () => {
  it("A's signed requests use A's customer and A's origin only, with B mapped", async () => {
    await seed(B, "cus_existingB");
    const s = fakeStripe();
    // A's portal: A has no customer, so 409, never B's.
    expect((await call(req("/portal", { install: A }))).status).toBe(409);
    // A's body naming B, A's header with B's body, B's header with A's key.
    expect(
      (await call(req("/checkout", { install: B, plan: "team" }))).status,
    ).toBe(403);
    expect(
      (await call(req("/portal", { install: B }, { install: B, signer: A })))
        .status,
    ).toBe(401);
    expect(s.calls).toEqual([]);
    // A's checkout: a new customer for A; B's mapping untouched.
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect(r.status).toBe(200);
    const forms = s.calls.map((c) => c.form);
    expect(forms[0]).toEqual({ "metadata[install_id]": A });
    expect(forms[1]?.customer).toBe("cus_fake1");
    expect(JSON.stringify(s.calls)).not.toContain("cus_existingB");
    expect(JSON.stringify(s.calls)).not.toContain(HOST_B);
    expect(await customerOf(B)).toBe("cus_existingB");
    expect(await customerOf(A)).toBe("cus_fake1");
  });
});

describe("Stripe answers and errors", () => {
  it("only a Stripe-hosted URL is passed back (else 502 bad_upstream)", async () => {
    await seed(A, "cus_existingA");
    for (const [path, url] of [
      [CHECKOUT, "https://evil.example/c/pay"],
      [CHECKOUT, "http://checkout.stripe.com/c/pay"],
      [CHECKOUT, "https://billing.stripe.com/p/session/x"],
      [CHECKOUT, "https://checkout.stripe.com.evil.example/"],
      [PORTAL, "https://checkout.stripe.com/c/pay"],
      [PORTAL, "https://evil.example/"],
    ]) {
      vi.restoreAllMocks();
      fakeStripe((c) =>
        c.path === path ? Response.json({ id: "x_1", url }) : undefined,
      );
      const r = await call(
        req(
          path === CHECKOUT ? "/checkout" : "/portal",
          path === CHECKOUT ? { install: A, plan: "team" } : { install: A },
        ),
      );
      const text = await r.text();
      expect([r.status, text]).toEqual([
        502,
        JSON.stringify({ error: "bad_upstream" }),
      ]);
    }
  });

  it("config errors are 500 config with no Stripe call: no key, a live key, an unfilled price", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const e of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678" },
      { STRIPE_PRICE_TEAM: "{{STRIPE_PRICE_TEAM_STAGING}}" },
    ]) {
      const r = await call(req("/checkout", { install: A, plan: "team" }), {
        ...baseEnv(),
        ...e,
      });
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
    }
    expect(s.calls).toEqual([]);
  });

  it("a Stripe error or a network failure is 502 upstream", async () => {
    await seed(A, "cus_existingA");
    for (const o of [
      () => Response.json({ error: { type: "card_error" } }, { status: 402 }),
      () => {
        throw new TypeError("network down");
      },
    ] as Override[]) {
      vi.restoreAllMocks();
      fakeStripe(o);
      for (const path of ["/checkout", "/portal"]) {
        const r = await call(
          req(
            path,
            path === "/checkout"
              ? { install: A, plan: "team" }
              : { install: A },
          ),
        );
        expect([r.status, await r.json()]).toEqual([
          502,
          { error: "upstream" },
        ]);
      }
    }
  });
});

describe("logs", () => {
  it("fixed categories and install ids: never the secret, a Stripe id, a URL or a body", async () => {
    const lines: string[] = [];
    for (const k of ["log", "warn", "error"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    fakeStripe((c) =>
      c.key?.startsWith("portal-") && c.form.customer === "cus_fake1"
        ? Response.json(
            { error: { type: "api_error", message: SECRET } },
            { status: 500 },
          )
        : undefined,
    );
    await call(req("/checkout", { install: A, plan: "team" }));
    await call(req("/portal", { install: A }));
    await call(req("/portal", { install: B }, { install: B }));
    await call(
      req(
        "/checkout",
        { install: A, plan: "team" },
        { appHost: "evil.example" },
      ),
    );
    await call(req("/checkout", { install: A, plan: "team" }), {
      ...baseEnv(),
      STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678",
    });
    expect(lines).toEqual([
      `billing customer mapped ${A}`,
      `billing checkout session ${A}`,
      `billing stripe upstream ${A}`,
      `billing portal no_customer ${B}`,
      `billing bad_app_host ${A}`,
      `billing stripe config ${A}`,
    ]);
    const all = lines.join("\n");
    for (const bad of [
      SECRET,
      "sk_live",
      "cus_",
      "cs_test",
      "https://",
      HOST_A,
    ])
      expect(all).not.toContain(bad);
  });
});
