import { describe, expect, it, vi } from "vitest";
import { normalizeHost } from "../../../packages/shared/src/hosts";
import dispatch, { type Env, hostOf } from "../src/index.js";

// P1 Task 6: a hostname that isn't mapped must get the generic 404 and never
// reach another install. The fakes record every HOSTS read and every script
// the dispatcher was asked for.

const A = "iabc123def45";
const B = "izzz999yyy88";

type Fetcher = (req: Request) => Promise<Response>;

function fakes(
  map: Record<string, string> = {},
  opts: { get?: () => never; fetch?: Fetcher; kvThrows?: boolean } = {},
) {
  const reads: { key: string; opts: unknown }[] = [];
  const scripts: string[] = [];
  const args: unknown[] = [];
  const seen: Request[] = [];
  const env = {
    OA_ENV: "staging",
    HOSTS: {
      get: async (key: string, o: unknown) => {
        reads.push({ key, opts: o });
        if (opts.kvThrows) throw new Error(`kv down for ${key}`);
        return map[key] ?? null;
      },
    },
    DISPATCHER: {
      get: (name: string, a?: unknown) => {
        scripts.push(name);
        args.push(a);
        if (opts.get) opts.get();
        return {
          fetch: async (req: Request) => {
            seen.push(req);
            return opts.fetch
              ? opts.fetch(req)
              : new Response(`hello from ${name}`, { status: 200 });
          },
        };
      },
    },
  } as unknown as Env;
  return { env, reads, scripts, seen, args };
}

/** ctx.exports.BrokerGate as the runtime gives it: each call is one stub with its props. */
const gates: { props: unknown }[] = [];
const ctx = {
  exports: {
    BrokerGate: (o: { props: unknown }) => {
      gates.push(o);
      return { gate: o.props };
    },
    BillingGate: (o: { props: unknown }) => {
      gates.push(o);
      return { billingGate: o.props };
    },
  },
} as unknown as ExecutionContext;

const MAP = {
  "acme.open-artifacts-staging.app": A,
  "acme.open-artifacts-staging.page": A,
  "beta.open-artifacts-staging.app": B,
};

/** An incoming request as the handler types it (cf properties unused). */
type In = Parameters<typeof dispatch.fetch>[0];

const call = (env: Env, input: string | Request, init?: RequestInit) =>
  dispatch.fetch(
    (typeof input === "string" ? new Request(input, init) : input) as In,
    env,
    ctx,
  );

/** Status, every header and the body bytes: what the client can observe. */
async function observe(r: Response) {
  return {
    status: r.status,
    headers: [...r.headers],
    body: [...new Uint8Array(await r.arrayBuffer())],
  };
}

const NOT_FOUND = {
  status: 404,
  headers: [["content-type", "text/plain;charset=UTF-8"]],
  body: [...new TextEncoder().encode("Not found")],
};

describe("dispatch", () => {
  it("unmapped host → 404 with a generic body and nothing dispatched", async () => {
    const f = fakes(MAP);
    for (const url of [
      "https://acme.open-artifacts-staging.ap/", // typo
      "https://gone.open-artifacts-staging.app/", // an old install's host
      "https://acmee.open-artifacts-staging.app/",
      "https://open-artifacts-staging.app/", // bare apex
      "https://open-artifacts-staging.page/",
      "https://www.open-artifacts-staging.app/",
      "https://acme.open-artifacts.app/", // the other env's zone
    ]) {
      expect(await observe(await call(f.env, url))).toEqual(NOT_FOUND);
    }
    expect(f.scripts).toEqual([]);
  });

  it("uppercase, trailing dot and explicit port map to the same install", async () => {
    const f = fakes(MAP);
    for (const url of [
      "https://ACME.OPEN-ARTIFACTS-STAGING.APP/",
      "https://acme.open-artifacts-staging.app./",
      "https://acme.open-artifacts-staging.app:8443/",
      "https://Acme.Open-Artifacts-Staging.App.:443/x",
    ]) {
      expect((await call(f.env, url)).status).toBe(200);
    }
    expect(f.scripts).toEqual(Array(4).fill(`oa-s-${A}`));
    expect(new Set(f.reads.map((r) => r.key))).toEqual(
      new Set(["acme.open-artifacts-staging.app"]),
    );
  });

  it("reads HOSTS with a 60 s edge cache", async () => {
    const f = fakes(MAP);
    await call(f.env, "https://acme.open-artifacts-staging.app/");
    expect(f.reads).toEqual([
      { key: "acme.open-artifacts-staging.app", opts: { cacheTtl: 60 } },
    ]);
  });

  it("app and content hosts of one install dispatch to the same script", async () => {
    const f = fakes(MAP);
    await call(f.env, "https://acme.open-artifacts-staging.app/");
    await call(f.env, "https://acme.open-artifacts-staging.page/a/x");
    await call(f.env, "https://beta.open-artifacts-staging.app/");
    expect(f.scripts).toEqual([`oa-s-${A}`, `oa-s-${A}`, `oa-s-${B}`]);
  });

  it("prod uses the prod script prefix", async () => {
    const f = fakes({ "acme.open-artifacts.app": A });
    (f.env as { OA_ENV: string }).OA_ENV = "prod";
    expect((await call(f.env, "https://acme.open-artifacts.app/")).status).toBe(
      200,
    );
    expect(f.scripts).toEqual([`oa-p-${A}`]);
  });

  it("a HOSTS value that isn't an install id → 404 (no script name injection)", async () => {
    const bad = [
      "",
      " iabc123def45",
      "iabc123def45 ",
      "iabc123def45\n",
      "IABC123DEF45",
      "iabc123def45/x",
      "../iabc123def45",
      "iabc123def4..",
      "iabc123def456",
      "oa-s-iabc123def45",
      "oa-p-iabc123def45",
      `{"id":"${A}"}`,
    ];
    for (const v of bad) {
      const f = fakes({ "acme.open-artifacts-staging.app": v });
      expect(
        await observe(
          await call(f.env, "https://acme.open-artifacts-staging.app/"),
        ),
      ).toEqual(NOT_FOUND);
      expect(f.scripts).toEqual([]);
    }
  });

  it("an unknown OA_ENV → 404, nothing dispatched", async () => {
    const f = fakes(MAP);
    (f.env as { OA_ENV: string }).OA_ENV = "dev";
    expect(
      await observe(
        await call(f.env, "https://acme.open-artifacts-staging.app/"),
      ),
    ).toEqual(NOT_FOUND);
    expect(f.scripts).toEqual([]);
  });

  it("the request reaches the user Worker byte-for-byte", async () => {
    let got: {
      method: string;
      url: string;
      headers: string[][];
      body: string;
    } = { method: "", url: "", headers: [], body: "" };
    const f = fakes(MAP, {
      fetch: async (req) => {
        got = {
          method: req.method,
          url: req.url,
          headers: [...req.headers],
          body: await req.text(),
        };
        return new Response("ok");
      },
    });
    const headers = {
      cookie: "oa_session=s1; other=x",
      authorization: "Bearer oa_pat_0123456789abcdef",
      "x-forwarded-host": "beta.open-artifacts-staging.app",
      "content-type": "application/json",
    };
    const req = new Request(
      "https://acme.open-artifacts-staging.app:8443/api/v1/x?q=1#f",
      {
        method: "PUT",
        headers,
        body: '{"a":1}',
      },
    );
    const r = await call(f.env, req);
    expect(r.status).toBe(200);
    expect(f.seen).toEqual([req]);
    expect(f.seen[0]).toBe(req);
    // X-Forwarded-Host names beta: routing still follows the URL (acme).
    expect(f.scripts).toEqual([`oa-s-${A}`]);
    expect(got).toEqual({
      method: "PUT",
      url: req.url,
      headers: [...new Headers(headers)],
      body: '{"a":1}',
    });
  });

  it("routes on the URL host only, never a Host or X-Forwarded-Host header", async () => {
    const f = fakes(MAP);
    const req = new Request("https://acme.open-artifacts-staging.app/", {
      headers: {
        host: "beta.open-artifacts-staging.app",
        "x-forwarded-host": "beta.open-artifacts-staging.app",
      },
    });
    expect((await call(f.env, req)).status).toBe(200);
    expect(f.scripts).toEqual([`oa-s-${A}`]);
    expect(f.reads.map((r) => r.key)).toEqual([
      "acme.open-artifacts-staging.app",
    ]);
  });

  it("the user Worker's response is returned unchanged", async () => {
    const res = new Response("teapot", {
      status: 418,
      headers: { "set-cookie": "a=b", "x-custom": "1" },
    });
    const f = fakes(MAP, { fetch: async () => res });
    expect(await call(f.env, "https://acme.open-artifacts-staging.app/")).toBe(
      res,
    );
  });

  it("a HEAD request and a streaming body are forwarded unread", async () => {
    const f = fakes(MAP, { fetch: async () => new Response(null) });
    const head = new Request("https://acme.open-artifacts-staging.app/", {
      method: "HEAD",
    });
    await call(f.env, head);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk"));
        c.close();
      },
    });
    const post = new Request("https://acme.open-artifacts-staging.app/upload", {
      method: "POST",
      body: stream,
      // @ts-expect-error: duplex is required for a stream body, not yet in the types
      duplex: "half",
    });
    await call(f.env, post);
    expect(f.seen).toEqual([head, post]);
    expect(f.seen[0]).toBe(head);
    expect(f.seen[1]).toBe(post);
    expect(post.bodyUsed).toBe(false);
    expect(post.body).toBe(stream);
    expect(await post.text()).toBe("chunk");
  });

  it("a WebSocket upgrade passes through unchanged", async () => {
    const f = fakes(MAP, {
      fetch: async (req) => {
        expect(req.headers.get("upgrade")).toBe("websocket");
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        return new Response(null, { status: 101, webSocket: client });
      },
    });
    const req = new Request(
      "https://acme.open-artifacts-staging.app/api/v1/live",
      {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      },
    );
    const r = await call(f.env, req);
    expect(f.seen[0]).toBe(req);
    expect(r.status).toBe(101);
    expect(r.webSocket).not.toBeNull();
  });

  it("a throwing DISPATCHER.get → 404, not 500 with a stack", async () => {
    const f = fakes(MAP, {
      get: () => {
        throw new Error("namespace binding broken");
      },
    });
    const r = await call(f.env, "https://acme.open-artifacts-staging.app/");
    expect(await observe(r)).toEqual(NOT_FOUND);
  });

  it("a rejected .fetch() (the install's script was deleted) → 404", async () => {
    const f = fakes(MAP, {
      fetch: async () => {
        throw new Error(`Worker not found: oa-s-${A}`);
      },
    });
    const r = await call(f.env, "https://acme.open-artifacts-staging.app/");
    expect(await observe(r)).toEqual(NOT_FOUND);
    expect(f.scripts).toEqual([`oa-s-${A}`]);
  });

  it("a HOSTS.get that throws → 404", async () => {
    const f = fakes(MAP, { kvThrows: true });
    const r = await call(f.env, "https://acme.open-artifacts-staging.app/");
    expect(await observe(r)).toEqual(NOT_FOUND);
    expect(f.scripts).toEqual([]);
  });

  it("IP literals and single-label hosts → 404 without a HOSTS read", async () => {
    const f = fakes({ ...MAP, "127.0.0.1": A, "[::1]": A, localhost: A });
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.1:8787/",
      "http://[::1]/",
      "http://[2001:db8::1]:443/",
      "http://localhost/",
    ])
      expect(await observe(await call(f.env, url))).toEqual(NOT_FOUND);
    expect(f.reads).toEqual([]);
    expect(f.scripts).toEqual([]);
  });

  it("a request whose url isn't a URL → 404", async () => {
    const f = fakes(MAP);
    const req = { url: "not a url", headers: new Headers() } as Request;
    expect(await observe(await call(f.env, req))).toEqual(NOT_FOUND);
    expect(f.scripts).toEqual([]);
  });

  it("every failure kind is the same byte-identical 404", async () => {
    const throwGet = fakes(MAP, {
      get: () => {
        throw new Error("x");
      },
    });
    const rejectFetch = fakes(MAP, {
      fetch: async () => {
        throw new Error("x");
      },
    });
    const kinds: [string, Env, string | Request][] = [
      ["miss", fakes(MAP).env, "https://nope.open-artifacts-staging.app/"],
      [
        "invalid value",
        fakes({ "acme.open-artifacts-staging.app": "../x" }).env,
        "https://acme.open-artifacts-staging.app/",
      ],
      [
        "get throws",
        fakes(MAP, { kvThrows: true }).env,
        "https://acme.open-artifacts-staging.app/",
      ],
      [
        "dispatcher throws",
        throwGet.env,
        "https://acme.open-artifacts-staging.app/",
      ],
      [
        "fetch rejects",
        rejectFetch.env,
        "https://acme.open-artifacts-staging.app/",
      ],
      ["non-URL", fakes(MAP).env, { url: "::" } as Request],
      ["IP literal", fakes(MAP).env, "http://192.168.1.1/"],
      ["bare apex", fakes(MAP).env, "https://open-artifacts-staging.app/"],
      ["www", fakes(MAP).env, "https://www.open-artifacts-staging.app/"],
    ];
    const seen = [];
    for (const [, env, input] of kinds)
      seen.push(await observe(await call(env, input)));
    for (const [i, o] of seen.entries())
      expect({ kind: kinds[i]?.[0], ...o }).toEqual({
        kind: kinds[i]?.[0],
        ...NOT_FOUND,
      });
  });

  it("logs only the host and a fixed category, and only on a dispatch error", async () => {
    const logs: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) =>
        vi.spyOn(console, m).mockImplementation((...a) => {
          logs.push(a);
        }),
    );
    const host = "acme.open-artifacts-staging.app";
    const reject = (msg: string) =>
      fakes(MAP, {
        fetch: async () => {
          throw new Error(msg);
        },
      }).env;
    const prodEnv = fakes(MAP).env;
    (prodEnv as { OA_ENV: string }).OA_ENV = "dev";
    try {
      const ok = fakes(MAP);
      await call(ok.env, `https://${host}/`);
      await call(ok.env, "https://nope.open-artifacts-staging.app/");
      await call(fakes({ [host]: "../x" }).env, `https://${host}/`);
      expect(logs).toEqual([]);
      const kinds: [Env, string][] = [
        [fakes(MAP, { kvThrows: true }).env, "kv"],
        [reject(`Worker not found: oa-s-${A} secret detail`), "not_found"],
        [reject("secret detail: uncaught in user Worker"), "exception"],
        [
          fakes(MAP, {
            get: () => {
              throw new Error("Worker not found secret detail");
            },
          }).env,
          "not_found",
        ],
        [prodEnv, "exception"],
      ];
      for (const [env, category] of kinds) {
        logs.length = 0;
        await call(
          env,
          new Request(`https://${host}/p?token=t1`, {
            headers: { cookie: "oa_session=s1", authorization: "Bearer b1" },
          }),
        );
        expect(logs).toEqual([["dispatch failed", category, host]]);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// The server routes and setup compare hosts with @oa/shared's normalizeHost
// (#518). Dispatch keeps its own copy to stay a ~2 KB bundle, so pin that
// both reach the same key for every tenant host a URL can carry.
describe("host normalization matches @oa/shared normalizeHost", () => {
  const urls = [
    "https://acme.open-artifacts-staging.app/",
    "https://ACME.Open-Artifacts-Staging.APP/x",
    "https://acme.open-artifacts-staging.app./",
    "https://acme.open-artifacts-staging.app:443/",
    "https://acme.open-artifacts-staging.page.:8443/a?b=c",
    "https://xn--bcher-kva.open-artifacts.app/",
    "https://a.b.open-artifacts.app/",
  ];
  for (const u of urls)
    it(u, () => {
      expect(hostOf(new Request(u))).toBe(normalizeHost(new URL(u).host));
    });
});

describe("broker gates in props", () => {
  it("a mapped host gets one auth, one directory and one billing gate, for that install only", async () => {
    const f = fakes(MAP);
    gates.length = 0;
    expect(
      (await call(f.env, "https://beta.open-artifacts-staging.app/x")).status,
    ).toBe(200);
    expect(f.args).toEqual([
      {
        props: {
          AUTH_BROKER: { gate: { installId: B, kind: "auth" } },
          DIRECTORY_BROKER: { gate: { installId: B, kind: "directory" } },
          billing: { billingGate: { installId: B } },
        },
      },
    ]);
    expect(gates.map((g) => g.props)).toEqual([
      { installId: B, kind: "auth" },
      { installId: B, kind: "directory" },
      { installId: B },
    ]);
  });

  it("each request builds its own gates: two installs never share one", async () => {
    const f = fakes(MAP);
    gates.length = 0;
    await call(f.env, "https://acme.open-artifacts-staging.app/");
    await call(f.env, "https://beta.open-artifacts-staging.app/");
    expect(
      f.args.map((a) => (a as { props: { billing: unknown } }).props.billing),
    ).toEqual([
      { billingGate: { installId: A } },
      { billingGate: { installId: B } },
    ]);
    expect(gates).toHaveLength(6);
  });

  it("an unmapped host or a bad HOSTS value gets no gate and no dispatch", async () => {
    const f = fakes({ "evil.open-artifacts-staging.app": "../iabc123def45" });
    gates.length = 0;
    for (const u of [
      "https://nobody.open-artifacts-staging.app/",
      "https://evil.open-artifacts-staging.app/",
      "https://open-artifacts-staging.app/",
    ])
      expect((await call(f.env, u)).status).toBe(404);
    expect(gates).toEqual([]);
    expect(f.args).toEqual([]);
  });
});
