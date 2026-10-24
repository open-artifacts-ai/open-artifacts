import { describe, expect, it } from "vitest";
import { callWorker, E } from "./mcp-helpers.js";

// P1 Task 6b: the Worker answers its own hosts only. Under a Workers for
// Platforms wildcard route, another install's hostname must not reach this
// one. Test env: APP_HOST=app.localhost, CONTENT_HOST=content.localhost,
// ENVIRONMENT=dev.

const get = (
  url: string,
  over: Record<string, unknown> = {},
  init: RequestInit = {},
) => callWorker(new Request(url, init), E(over));

describe("the Worker answers only its own hosts", () => {
  it("serves APP_HOST", async () => {
    expect((await get("http://app.localhost/healthz")).status).toBe(200);
  });

  it("normalizes case, a trailing dot and an explicit port", async () => {
    for (const host of [
      "APP.LOCALHOST",
      "app.localhost.",
      "app.localhost:8787",
    ])
      expect((await get(`http://${host}/healthz`)).status).toBe(200);
  });

  it("keeps serving the content host", async () => {
    // /healthz is not a content route. The content app's JSON not_found (not
    // the app's 200, and not the bare foreign-host "Not found") proves the
    // request was routed there.
    const r = await get("http://content.localhost/healthz");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await r.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers a foreign host with a plain 404 before auth", async () => {
    const r = await get(
      "https://other-install.example/healthz",
      {},
      {
        headers: {
          authorization: "Bearer oa_pat_0123456789abcdef",
          cookie: "oa_session=whatever",
          "x-forwarded-host": "app.localhost",
        },
      },
    );
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
    // Nothing from the app's error shape or its security headers.
    expect(r.headers.get("content-security-policy")).toBeNull();
  });

  it("ignores X-Forwarded-Host in the other direction too", async () => {
    const r = await get(
      "http://app.localhost/healthz",
      {},
      {
        headers: { "x-forwarded-host": "other-install.example" },
      },
    );
    expect(r.status).toBe(200);
  });

  it("dev also answers localhost and 127.0.0.1", async () => {
    for (const host of ["localhost", "127.0.0.1", "localhost:8788"])
      expect((await get(`http://${host}/healthz`)).status).toBe(200);
  });

  it("production does not answer localhost", async () => {
    for (const host of ["localhost", "127.0.0.1"])
      expect(
        (await get(`http://${host}/healthz`, { ENVIRONMENT: "production" }))
          .status,
      ).toBe(404);
  });

  it("APP_HOST unset fails closed for every install, self-host included", async () => {
    // Setup always renders APP_HOST (scripts/setup refuses an empty one), so
    // a missing value is a broken config: answer nothing, hosted or not.
    for (const over of [
      { APP_HOST: undefined, ENVIRONMENT: "production" },
      { APP_HOST: "", ENVIRONMENT: "production" },
      { APP_HOST: undefined, HOSTED: "1" },
      { APP_HOST: undefined },
      { APP_HOST: undefined, CONTENT_HOST: undefined },
      { APP_HOST: "", CONTENT_HOST: "" },
    ])
      for (const host of ["app.localhost", "anything.example", "localhost"]) {
        const r = await get(`http://${host}/healthz`, over);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Not found");
      }
  });

  it("CONTENT_HOST unset: the app host still answers, the content host is foreign", async () => {
    for (const CONTENT_HOST of [undefined, ""]) {
      expect(
        (await get("http://app.localhost/healthz", { CONTENT_HOST })).status,
      ).toBe(200);
      for (const url of [
        "http://content.localhost/healthz",
        "http://anything.example/healthz",
      ]) {
        const r = await get(url, { CONTENT_HOST, ENVIRONMENT: "production" });
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Not found");
      }
    }
  });

  it("self-host answers a foreign host with the same 404 as hosted", async () => {
    for (const HOSTED of [undefined, "0", "1"]) {
      const r = await get("https://other-install.example/healthz", {
        HOSTED,
        ENVIRONMENT: "production",
      });
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
      expect([...r.headers]).toEqual([
        ["content-type", "text/plain;charset=UTF-8"],
      ]);
    }
  });

  it("refuses foreign hosts on every pre-auth surface", async () => {
    const foreign = "https://other-install.example";
    const cases: [string, RequestInit][] = [
      [
        `${foreign}/mcp`,
        { method: "POST", headers: { authorization: "Bearer oa_pat_x" } },
      ],
      [`${foreign}/.well-known/oauth-authorization-server`, {}],
      [`${foreign}/oauth/token`, { method: "POST" }],
      [`${foreign}/oauth/register`, { method: "POST" }],
      [
        `${foreign}/api/v1/artifacts/x/data/topics`,
        {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        },
      ],
    ];
    for (const [url, init] of cases) {
      const r = await get(url, {}, init);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
  });

  it("another install's content host is foreign too", async () => {
    const r = await get("http://content.other-install.example/healthz");
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
  });

  it("dev answers [::1]; production does not", async () => {
    expect((await get("http://[::1]:8787/healthz")).status).toBe(200);
    expect(
      (
        await get("http://[::1]:8787/healthz", {
          ENVIRONMENT: "production",
        })
      ).status,
    ).toBe(404);
  });
});
