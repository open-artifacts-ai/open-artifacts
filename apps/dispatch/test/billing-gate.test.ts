import {
  BILLING_GATE_ROUTES,
  BILLING_ORIGIN,
  type BillingGateEnv,
  type BillingGateProps,
  billingProps,
  passBillingGate,
  USAGE_MAX_BODY,
} from "@oa/broker-core/billing-gate";
import { GATE_MAX_BODY } from "@oa/broker-core/gate";
import { describe, expect, it } from "vitest";

// BillingGate is an install's only path to the tier store. Each case below is
// one of its refusals, or proof that an allowed call reaches only the billing
// binding, on a fixed route, with the gate's own install header.

const A = "iabc123def45";
const B = "izzz999yyy88";

function world() {
  const got: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  const env: BillingGateEnv = {
    BILLING: {
      fetch: async (req: Request) => {
        got.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers),
          body: await req.text(),
        });
        return Response.json({ tier: "free" }, { status: 200 });
      },
    } as unknown as Fetcher,
  };
  return { env, got };
}

const APP_HOST = "acme.open-artifacts-staging.app";
const props: BillingGateProps = { installId: A, appHost: APP_HOST };

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`https://anything.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A gate refusal: its status and body, and it carries the gate's marker. */
const err = async (r: Response) => {
  expect(r.headers.get("x-oa-gate")).toBe("1");
  return { status: r.status, ...((await r.json()) as object) };
};

/** Headers a caller might try to steer with; none may pass. */
const HOSTILE = {
  host: "evil.example",
  "x-forwarded-host": "evil.example",
  "cf-connecting-ip": "1.2.3.4",
  cookie: "a=b",
  authorization: "Bearer x",
  "x-oa-gate-install": B,
  "x-oa-gate-app-host": "evil.open-artifacts-staging.app",
};

describe("BillingGate: allowed calls", () => {
  it("GET /tier and /health: the fixed origin, no body, the gate's install header only", async () => {
    const w = world();
    for (const path of BILLING_GATE_ROUTES.GET) {
      const r = await passBillingGate(
        new Request(`https://anything.example${path}`, {
          headers: { ...HOSTILE, "x-oa-kid": "k1", "x-oa-sig": "s1" },
        }),
        props,
        w.env,
      );
      expect(r.status).toBe(200);
    }
    expect(w.got).toEqual(
      BILLING_GATE_ROUTES.GET.map((p) => ({
        url: `${BILLING_ORIGIN}${p}`,
        method: "GET",
        headers: { "x-oa-kid": "k1", "x-oa-sig": "s1", "x-oa-gate-install": A },
        body: "",
      })),
    );
  });

  it("every POST: body unchanged, three headers plus the install; /checkout and /portal also the props' app host", async () => {
    const w = world();
    const bodies = {
      "/trial/start": JSON.stringify({ install: A }),
      "/usage": JSON.stringify({
        install: A,
        month: "2026-10",
        creators: ["c"],
        count: 1,
      }),
      "/checkout": JSON.stringify({ install: A, ts: 1, plan: "team" }),
      "/portal": JSON.stringify({ install: A, ts: 1 }),
    } as Record<string, string>;
    for (const path of BILLING_GATE_ROUTES.POST) {
      const r = await passBillingGate(
        post(path, bodies[path], { ...HOSTILE, "x-oa-sig": "s" }),
        props,
        w.env,
      );
      expect(r.status).toBe(200);
    }
    expect(w.got).toEqual(
      BILLING_GATE_ROUTES.POST.map((p) => ({
        url: `${BILLING_ORIGIN}${p}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-sig": "s",
          "x-oa-gate-install": A,
          ...(p === "/checkout" || p === "/portal"
            ? { "x-oa-gate-app-host": APP_HOST }
            : {}),
        },
        body: bodies[p],
      })),
    );
  });

  it("the allowlist is exactly the six routes", () => {
    expect(BILLING_GATE_ROUTES).toEqual({
      GET: ["/tier", "/health"],
      POST: ["/trial/start", "/usage", "/checkout", "/portal"],
    });
  });

  it("the app host is the props' only: no caller header, query or body moves it", async () => {
    const w = world();
    const r = await passBillingGate(
      post(
        "/checkout",
        {
          install: A,
          ts: 1,
          plan: "team",
          success_url: "https://evil.example/",
        },
        {
          ...HOSTILE,
          origin: "https://evil.example",
          referer: "https://evil.example/",
        },
      ),
      props,
      w.env,
    );
    expect(r.status).toBe(200);
    expect(w.got[0]?.headers["x-oa-gate-app-host"]).toBe(APP_HOST);
    // A query is refused before anything else.
    const q = await passBillingGate(
      post("/portal?appHost=evil.example", { install: A, ts: 1 }),
      props,
      w.env,
    );
    expect(q.status).toBe(404);
    expect(w.got).toHaveLength(1);
  });

  it("billingProps gives one gate, for that install only", () => {
    const made: unknown[] = [];
    const out = billingProps(
      {
        BillingGate: (o) => {
          made.push(o.props);
          return { gate: o.props } as unknown as Fetcher;
        },
      },
      A,
      APP_HOST,
    );
    expect(out).toEqual({
      BILLING: { gate: { installId: A, appHost: APP_HOST } },
    });
    expect(made).toEqual([{ installId: A, appHost: APP_HOST }]);
  });
});

describe("BillingGate: refusals (nothing reaches billing)", () => {
  it("a wrong method, an unknown path, a near miss or a query → 404", async () => {
    const w = world();
    const reqs = [
      post("/tier", { install: A }),
      post("/health", { install: A }),
      new Request("https://x.example/trial/start"),
      new Request("https://x.example/usage"),
      new Request("https://x.example/tier/"),
      new Request("https://x.example/Tier"),
      new Request("https://x.example/stripe/webhook"),
      post("/stripe/webhook", { install: A }),
      new Request("https://x.example/tier?install=izzz999yyy88"),
      post("/usage?x=1", { install: A }),
      new Request("https://x.example/tier", { method: "PUT", body: "{}" }),
      new Request("https://x.example/tier", { method: "DELETE" }),
      new Request("https://x.example/tier", { method: "HEAD" }),
    ];
    for (const req of reqs)
      expect(await err(await passBillingGate(req, props, w.env))).toEqual({
        status: 404,
        error: "not_found",
      });
    expect(w.got).toEqual([]);
  });

  it("a POST body for another install, or none named → 403", async () => {
    const w = world();
    for (const path of BILLING_GATE_ROUTES.POST)
      for (const body of [
        { install: B },
        { install: A.toUpperCase() },
        {},
        { install: [A] },
      ])
        expect(
          await err(await passBillingGate(post(path, body), props, w.env)),
        ).toEqual({ status: 403, error: "install_mismatch" });
    expect(w.got).toEqual([]);
  });

  it("not JSON → 415; JSON that isn't an object → 400", async () => {
    const w = world();
    const text = new Request("https://x.example/usage", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ install: A }),
    });
    expect(await err(await passBillingGate(text, props, w.env))).toEqual({
      status: 415,
      error: "json_only",
    });
    for (const body of ["{", "", "null", "[]", '"x"', "1"])
      expect(
        await err(await passBillingGate(post("/usage", body), props, w.env)),
      ).toEqual({ status: 400, error: "bad_json" });
    expect(w.got).toEqual([]);
  });

  it("a body over the cap → 413, by Content-Length or by the bytes read", async () => {
    const w = world();
    const big = JSON.stringify({ install: A, pad: "x".repeat(GATE_MAX_BODY) });
    expect(
      await err(await passBillingGate(post("/trial/start", big), props, w.env)),
    ).toEqual({ status: 413, error: "too_large" });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request("https://x.example/trial/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required for a streamed body in workerd
      duplex: "half",
    });
    expect(await err(await passBillingGate(req, props, w.env))).toEqual({
      status: 413,
      error: "too_large",
    });
    expect(w.got).toEqual([]);
  });

  it("/usage alone has the larger cap: 10,000 creators of 128 chars pass, more is 413", async () => {
    const w = world();
    const creators = Array.from({ length: 10_000 }, (_, i) =>
      String(i).padStart(128, "c"),
    );
    const full = JSON.stringify({
      install: A,
      month: "2026-10",
      creators,
      count: creators.length,
    });
    expect(full.length).toBeGreaterThan(GATE_MAX_BODY);
    const r = await passBillingGate(post("/usage", full), props, w.env);
    expect(r.headers.get("x-oa-gate")).toBeNull();
    expect(w.got).toHaveLength(1);
    const over = JSON.stringify({
      install: A,
      pad: "x".repeat(USAGE_MAX_BODY),
    });
    expect(
      await err(await passBillingGate(post("/usage", over), props, w.env)),
    ).toEqual({ status: 413, error: "too_large" });
    expect(w.got).toHaveLength(1);
  });

  it("bad bytes in the body → 400", async () => {
    const w = world();
    const req = new Request("https://x.example/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect(await err(await passBillingGate(req, props, w.env))).toEqual({
      status: 400,
      error: "bad_body",
    });
    expect(w.got).toEqual([]);
  });

  it("missing or malformed props → 500, never a call", async () => {
    const w = world();
    for (const p of [
      undefined,
      {},
      { installId: "../x" },
      { installId: A.toUpperCase() },
      { installId: 1 },
    ] as unknown as BillingGateProps[])
      expect(
        await err(
          await passBillingGate(
            new Request("https://x.example/tier"),
            p,
            w.env,
          ),
        ),
      ).toEqual({ status: 500, error: "gate_misconfigured" });
    expect(w.got).toEqual([]);
  });

  it("/checkout and /portal with a missing or malformed appHost → 500, never a call; other routes don't need it", async () => {
    const w = world();
    for (const appHost of [
      undefined,
      "",
      "Acme.open-artifacts-staging.app",
      "acme.open-artifacts-staging.app/x",
      "acme.open-artifacts-staging.app:443",
      "evil.example?x=",
      "localhost",
      1,
    ])
      for (const [path, body] of [
        ["/checkout", { install: A, ts: 1, plan: "team" }],
        ["/portal", { install: A, ts: 1 }],
      ] as const)
        expect(
          await err(
            await passBillingGate(
              post(path, body),
              {
                installId: A,
                appHost,
              } as unknown as BillingGateProps,
              w.env,
            ),
          ),
        ).toEqual({ status: 500, error: "gate_misconfigured" });
    expect(w.got).toEqual([]);
    const r = await passBillingGate(
      new Request("https://x.example/tier"),
      { installId: A, appHost: "" },
      w.env,
    );
    expect(r.status).toBe(200);
    expect(w.got[0]?.headers).not.toHaveProperty("x-oa-gate-app-host");
  });

  it("billing's own response passes through without the gate's marker", async () => {
    const w = world();
    w.env.BILLING = {
      fetch: async () => new Response("Not found", { status: 404 }),
    } as unknown as Fetcher;
    const r = await passBillingGate(
      new Request("https://x.example/tier"),
      props,
      w.env,
    );
    expect(r.status).toBe(404);
    expect(r.headers.get("x-oa-gate")).toBeNull();
  });
});
