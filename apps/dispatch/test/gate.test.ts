import {
  type BrokerGateEnv,
  type BrokerGateProps,
  GATE_MAX_BODY,
  GATE_ROUTES,
  passGate,
} from "@oa/broker-core/gate";
import { describe, expect, it } from "vitest";

// BrokerGate is an install's only path to the brokers. Each case below is one
// of the gate's refusals, or proof that an allowed call reaches only the
// fixed broker with the body and the three allowed headers.

const A = "iabc123def45";
const B = "izzz999yyy88";
const AUTH = "https://auth.open-artifacts-staging.app";
const DIR = "https://directory.open-artifacts-staging.app";

function broker() {
  const got: {
    url: string;
    method: string;
    headers: [string, string][];
    body: string;
  }[] = [];
  const f = {
    fetch: async (req: Request) => {
      got.push({
        url: req.url,
        method: req.method,
        headers: [...req.headers],
        body: await req.text(),
      });
      return Response.json({ id_token: "t" }, { status: 200 });
    },
  } as unknown as Fetcher;
  return { f, got };
}

function world() {
  const auth = broker();
  const dir = broker();
  const env: BrokerGateEnv = {
    AUTH_BROKER: auth.f,
    DIRECTORY_BROKER: dir.f,
    AUTH_BROKER_ORIGIN: AUTH,
    DIRECTORY_BROKER_ORIGIN: DIR,
  };
  return { env, auth: auth.got, dir: dir.got };
}

const auth: BrokerGateProps = { installId: A, kind: "auth" };
const dir: BrokerGateProps = { installId: A, kind: "directory" };

const post = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const err = async (r: Response) => ({
  status: r.status,
  ...((await r.json()) as object),
});

describe("BrokerGate: allowed calls", () => {
  it("redeem goes to the auth broker at its fixed origin, body unchanged, three headers only", async () => {
    const w = world();
    const body = JSON.stringify({ install: A, code: "c", ts: 1 });
    const r = await passGate(
      post("https://anything.example/google/redeem", body, {
        "x-oa-kid": "k1",
        "x-oa-sig": "s1",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "cf-connecting-ip": "1.2.3.4",
        cookie: "a=b",
        authorization: "Bearer x",
      }),
      auth,
      w.env,
    );
    expect(r.status).toBe(200);
    expect(w.dir).toEqual([]);
    expect(w.auth).toHaveLength(1);
    const g = w.auth[0];
    expect(g?.url).toBe(`${AUTH}/google/redeem`);
    expect(g?.method).toBe("POST");
    expect(g?.body).toBe(body);
    expect(Object.fromEntries(g?.headers ?? [])).toEqual({
      "content-type": "application/json",
      "x-oa-kid": "k1",
      "x-oa-sig": "s1",
    });
  });

  it("both directory routes go to the directory broker only", async () => {
    const w = world();
    for (const path of GATE_ROUTES.directory) {
      const r = await passGate(
        post(`${DIR}${path}`, { install: A }),
        dir,
        w.env,
      );
      expect(r.status).toBe(200);
    }
    expect(w.dir.map((g) => g.url)).toEqual(
      GATE_ROUTES.directory.map((p) => `${DIR}${p}`),
    );
    expect(w.auth).toEqual([]);
  });

  it("the allowlist is exactly the server's POST routes", () => {
    expect(GATE_ROUTES).toEqual({
      auth: ["/google/redeem"],
      directory: ["/google/directory/token", "/google/directory/revoke"],
    });
  });
});

describe("BrokerGate: refusals (nothing reaches a broker)", () => {
  it("a route of the other broker, an unknown path, a query or a non-POST → 404", async () => {
    const w = world();
    const cases: [Request, BrokerGateProps][] = [
      [post(`${AUTH}/google/directory/token`, { install: A }), auth],
      [post(`${DIR}/google/redeem`, { install: A }), dir],
      [post(`${AUTH}/google/redeem/`, { install: A }), auth],
      [post(`${AUTH}/google/authorize`, { install: A }), auth],
      [post(`${AUTH}/google/redeem?x=1`, { install: A }), auth],
      [new Request(`${AUTH}/google/redeem`), auth],
      [
        new Request(`${AUTH}/google/redeem`, { method: "PUT", body: "{}" }),
        auth,
      ],
    ];
    for (const [req, p] of cases)
      expect(await err(await passGate(req, p, w.env))).toEqual({
        status: 404,
        error: "not_found",
      });
    expect([...w.auth, ...w.dir]).toEqual([]);
  });

  it("a body for another install → 403", async () => {
    const w = world();
    for (const body of [
      { install: B },
      { install: A.toUpperCase() },
      {},
      { install: [A] },
    ])
      expect(
        await err(
          await passGate(post(`${AUTH}/google/redeem`, body), auth, w.env),
        ),
      ).toEqual({
        status: 403,
        error: "install_mismatch",
      });
    expect(w.auth).toEqual([]);
  });

  it("not JSON → 415; JSON that isn't an object → 400", async () => {
    const w = world();
    const text = new Request(`${AUTH}/google/redeem`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ install: A }),
    });
    expect(await err(await passGate(text, auth, w.env))).toEqual({
      status: 415,
      error: "json_only",
    });
    for (const body of ["{", "", "null", "[]", '"x"', "1"])
      expect(
        await err(
          await passGate(post(`${AUTH}/google/redeem`, body), auth, w.env),
        ),
      ).toEqual({
        status: 400,
        error: "bad_json",
      });
    expect(w.auth).toEqual([]);
  });

  it("a body over the cap → 413, by Content-Length or by the bytes read", async () => {
    const w = world();
    const big = JSON.stringify({ install: A, pad: "x".repeat(GATE_MAX_BODY) });
    expect(
      await err(
        await passGate(post(`${AUTH}/google/redeem`, big), auth, w.env),
      ),
    ).toEqual({
      status: 413,
      error: "too_large",
    });
    // A stream with no Content-Length is cut off at the cap too.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request(`${AUTH}/google/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required for a streamed body in workerd
      duplex: "half",
    });
    expect(await err(await passGate(req, auth, w.env))).toEqual({
      status: 413,
      error: "too_large",
    });
    // Right at the cap is fine.
    const at = JSON.stringify({ install: A, p: "" });
    const fits = at.replace(
      '"p":""',
      `"p":"${"y".repeat(GATE_MAX_BODY - at.length)}"`,
    );
    expect(fits.length).toBe(GATE_MAX_BODY);
    expect(
      (await passGate(post(`${AUTH}/google/redeem`, fits), auth, w.env)).status,
    ).toBe(200);
    expect(w.auth).toHaveLength(1);
  });

  it("bad bytes in the body → 400", async () => {
    const w = world();
    const req = new Request(`${AUTH}/google/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect((await passGate(req, auth, w.env)).status).toBe(400);
    expect(w.auth).toEqual([]);
  });

  it("missing or malformed props → 500, never a call", async () => {
    const w = world();
    for (const p of [
      undefined,
      { installId: "../x", kind: "auth" },
      { installId: A, kind: "other" },
      { installId: A, kind: "__proto__" },
    ] as unknown as BrokerGateProps[])
      expect(
        (
          await passGate(
            post(`${AUTH}/google/redeem`, { install: A }),
            p,
            w.env,
          )
        ).status,
      ).toBe(500);
    expect([...w.auth, ...w.dir]).toEqual([]);
  });
});
