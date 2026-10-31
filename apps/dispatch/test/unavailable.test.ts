import { hostsValue } from "@oa/provision/names";
import { describe, expect, it } from "vitest";
import dispatch, { CLOSED_COPY, type Env, PAUSED_COPY } from "../src/index.js";

// Design v7 5.5: a paused or closing install answers a 503 page from
// dispatch itself; its script is never called. Every other HOSTS value that
// parseHostsValue refuses is the one 404.

const A = "iabc123def45";
const HOST = "acme.open-artifacts-staging.app";

function fakes(value: string) {
  const scripts: string[] = [];
  const env = {
    OA_ENV: "staging",
    HOSTS: { get: async (k: string) => (k === HOST ? value : null) },
    DISPATCHER: {
      get: (name: string) => {
        scripts.push(name);
        return { fetch: async () => new Response(`hello from ${name}`) };
      },
    },
  } as unknown as Env;
  return { env, scripts };
}

const ctx = {
  exports: { BrokerGate: (o: { props: unknown }) => ({ gate: o.props }) },
} as unknown as ExecutionContext;

type In = Parameters<typeof dispatch.fetch>[0];
const call = (env: Env, path: string, init?: RequestInit) =>
  dispatch.fetch(new Request(`https://${HOST}${path}`, init) as In, env, ctx);

const HTML = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" };

const MODES = [
  ["paused", PAUSED_COPY],
  ["closed", CLOSED_COPY],
] as const;

describe("HOSTS modes", () => {
  it("serving forwards to the install", async () => {
    const f = fakes(hostsValue(A, "serving"));
    const r = await call(f.env, "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(`hello from oa-s-${A}`);
    expect(f.scripts).toEqual([`oa-s-${A}`]);
  });

  for (const [mode, copy] of MODES) {
    describe(mode, () => {
      const value = hostsValue(A, mode);

      it("an HTML GET gets the page, and the install is never called", async () => {
        const f = fakes(value);
        const r = await call(f.env, "/", { headers: HTML });
        expect(r.status).toBe(503);
        expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const body = await r.text();
        expect(body).toContain(`<title>${copy.title}</title>`);
        expect(body).toContain(`<h1>${copy.title}</h1>`);
        expect(body).toContain(copy.body);
        // Design's footer: the product name, nothing clickable (no href below).
        expect(body).toContain("<footer>Open Artifacts</footer>");
        expect(body).toContain("prefers-color-scheme: dark");
        expect(body).toContain('name="viewport"');
        // Self-contained: nothing for the browser to fetch.
        expect(body).not.toMatch(/src=|href=|url\(|@import/i);
        expect(f.scripts).toEqual([]);
      });

      it("every method and path gets the 503 and never reaches the install", async () => {
        const f = fakes(value);
        const reqs: [string, RequestInit][] = [
          ["/", {}],
          [
            "/mcp",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"jsonrpc":"2.0"}',
            },
          ],
          ["/healthz", {}],
          ["/api/v1/me", { headers: { accept: "application/json" } }],
          ["/assets/app.js", { headers: { accept: "*/*" } }],
          ["/a/x", { method: "DELETE" }],
          ["/", { method: "HEAD", headers: HTML }],
        ];
        for (const [path, init] of reqs)
          expect((await call(f.env, path, init)).status).toBe(503);
        expect(f.scripts).toEqual([]);
      });

      it("a non-HTML Accept gets a short text/plain body with the same meaning", async () => {
        for (const init of [
          { headers: { accept: "application/json" } },
          { method: "POST", body: "{}" },
          {},
        ]) {
          const f = fakes(value);
          const r = await call(f.env, "/mcp", init);
          expect(r.status).toBe(503);
          expect(r.headers.get("content-type")).toBe(
            "text/plain; charset=utf-8",
          );
          expect(await r.text()).toBe(`${copy.title}. ${copy.body}\n`);
          expect(f.scripts).toEqual([]);
        }
      });

      it("HEAD gets the 503 headers and no body", async () => {
        for (const headers of [HTML, { accept: "application/json" }]) {
          const f = fakes(value);
          const r = await call(f.env, "/", { method: "HEAD", headers });
          expect(r.status).toBe(503);
          expect(r.headers.get("cache-control")).toBe("no-store");
          expect(r.headers.get("x-robots-tag")).toBe("noindex");
          expect(r.body).toBeNull();
          expect(f.scripts).toEqual([]);
        }
      });

      it("sends no-store, a restrictive CSP, nosniff, no-referrer and no Retry-After", async () => {
        for (const headers of [HTML, { accept: "application/json" }]) {
          const r = await call(fakes(value).env, "/", { headers });
          expect(r.headers.get("cache-control")).toBe("no-store");
          expect(r.headers.get("content-security-policy")).toBe(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          );
          expect(r.headers.get("x-content-type-options")).toBe("nosniff");
          expect(r.headers.get("referrer-policy")).toBe("no-referrer");
          expect(r.headers.get("x-robots-tag")).toBe("noindex");
          expect(r.headers.has("retry-after")).toBe(false);
          expect(r.headers.has("set-cookie")).toBe(false);
        }
      });

      it("reveals no install id, script name or env", async () => {
        for (const headers of [HTML, { accept: "text/plain" }]) {
          const r = await call(fakes(value).env, "/", { headers });
          const all = `${[...r.headers].join("\n")}\n${await r.text()}`;
          for (const secret of [A, `oa-s-${A}`, "oa-s-", "staging", "prod"])
            expect(all).not.toContain(secret);
        }
      });
    });
  }

  it("a WebSocket upgrade and /__oa/* get the 503 too, never the install", async () => {
    for (const mode of ["paused", "closed"] as const) {
      for (const [path, init] of [
        ["/ws", { headers: { upgrade: "websocket", connection: "Upgrade" } }],
        ["/__oa/health", {}],
      ] as const) {
        const f = fakes(hostsValue(A, mode));
        const r = await call(f.env, path, init);
        expect(r.status).toBe(503);
        expect(f.scripts).toEqual([]);
      }
    }
  });

  it("a HOSTS value with a trailing newline is the 404", async () => {
    for (const mode of ["serving", "paused", "closed"] as const) {
      const f = fakes(`${hostsValue(A, mode)}\n`);
      const r = await call(f.env, "/", { headers: HTML });
      expect(r.status).toBe(404);
      expect(f.scripts).toEqual([]);
    }
  });

  it("paused and closed pages differ", async () => {
    const page = async (mode: "paused" | "closed") =>
      (
        await call(fakes(hostsValue(A, mode)).env, "/", { headers: HTML })
      ).text();
    expect(await page("paused")).not.toBe(await page("closed"));
  });

  it("values parseHostsValue refuses → the one 404, nothing dispatched", async () => {
    for (const v of [
      "i000000admin", // a platform principal
      "i00000signup",
      "paused:i000000admin",
      "closed:i00000signup",
      "paused:",
      "paused:../x",
      "paused:IABC123DEF45",
      "closed:iabc123def4",
      `foo:${A}`,
      `serving:${A}`,
      `PAUSED:${A}`,
      `paused:${A}:x`,
      `paused: ${A}`,
      ` paused:${A}`,
      "",
      " ",
      "\t\n",
    ]) {
      const f = fakes(v);
      const r = await call(f.env, "/", { headers: HTML });
      expect({ v, status: r.status, body: await r.text() }).toEqual({
        v,
        status: 404,
        body: "Not found",
      });
      expect(f.scripts).toEqual([]);
    }
  });
});

describe("copy", () => {
  it("is Design's W11 copy", () => {
    expect(PAUSED_COPY).toEqual({
      title: "This workspace is paused",
      body: "Nothing in it has been deleted. If you use this workspace, ask its admin when it will be back.",
    });
    expect(CLOSED_COPY).toEqual({
      title: "This workspace is closed",
      body: "If you use this workspace, ask its admin about it.",
    });
  });

  it("has no em dash or en dash", () => {
    for (const c of [PAUSED_COPY, CLOSED_COPY])
      expect(`${c.title}${c.body}`).not.toMatch(/[–—]/);
  });

  it("is plain text, safe to put in HTML unescaped", () => {
    for (const c of [PAUSED_COPY, CLOSED_COPY])
      expect(`${c.title}${c.body}`).not.toMatch(/[<>&"']/);
  });
});
