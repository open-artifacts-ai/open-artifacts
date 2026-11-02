import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { API, ctx, fakeEnv, requestId, resetDb, tokenP } from "./fakes.js";

// The HTTP adapter's body step (3.1) in front of invokeRoute, with authn
// stubbed to a token principal (W5b builds the real one).

const as = vi.hoisted(() => ({
  scopes: null as null | string[],
}));
vi.mock("../src/auth/authenticate.js", () => ({
  authenticate: async () =>
    tokenP(
      (as.scopes ?? [
        "installs:read",
        "installs:write",
        "installs:delete",
      ]) as Parameters<typeof tokenP>[0],
    ),
}));

beforeEach(() => {
  as.scopes = null;
  return resetDb();
});
afterEach(() => vi.restoreAllMocks());

const post = (path: string, body: string, type = "application/json") =>
  new Request(`${API}/v1${path}`, {
    method: "POST",
    body,
    headers: { "content-type": type, "cf-connecting-ip": "192.0.2.1" },
  }) as unknown as Parameters<typeof worker.fetch>[0];

const create = (rid: string) =>
  JSON.stringify({
    requestId: rid,
    slug: "httpx",
    ownerEmail: "a@acme.test",
    tier: "team",
    auth: { providers: ["google"], domains: ["acme.test"] },
  });

describe("POST /v1/installs over HTTP", () => {
  it("202 with the job; a replay carries oa-idempotent-replay", async () => {
    const e = fakeEnv();
    const rid = requestId();
    const a = await worker.fetch(post("/installs", create(rid)), e.env, ctx());
    expect(a.status).toBe(202);
    expect(a.headers.get("content-type")).toBe("application/json");
    const b = await worker.fetch(post("/installs", create(rid)), e.env, ctx());
    expect(b.headers.get("oa-idempotent-replay")).toBe("1");
    expect(((await b.json()) as { job: { id: string } }).job.id).toBe(
      ((await a.json()) as { job: { id: string } }).job.id,
    );
  });

  it("415, 413 and 400 before any handler", async () => {
    const e = fakeEnv();
    const codeOf = async (r: Parameters<typeof worker.fetch>[0]) => {
      const res = await worker.fetch(r, e.env, ctx());
      return [
        res.status,
        ((await res.json()) as { error: { code: string } }).error.code,
      ];
    };
    expect(await codeOf(post("/installs", "{}", "text/plain"))).toEqual([
      415,
      "unsupported_media_type",
    ]);
    expect(
      await codeOf(post("/installs", `{"a":"${"x".repeat(17 * 1024)}"}`)),
    ).toEqual([413, "payload_too_large"]);
    expect(await codeOf(post("/installs", "{nope"))).toEqual([
      400,
      "invalid_input",
    ]);
  });

  it("the body step runs after the rate limit and authz (4.2): an unscoped token gets 403, not 415", async () => {
    const e = fakeEnv();
    as.scopes = ["installs:read"];
    const res = await worker.fetch(
      post("/installs", "{}", "text/plain"),
      e.env,
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(e.limits.RL_PV_WRITE.keys).toHaveLength(1);
    as.scopes = null;
    e.limits.RL_PV_WRITE.allow = false;
    const limited = await worker.fetch(
      post("/installs", `{"a":"${"x".repeat(17 * 1024)}"}`),
      e.env,
      ctx(),
    );
    expect(limited.status).toBe(429);
  });

  it("GET routes read no body", async () => {
    const e = fakeEnv();
    const res = await worker.fetch(
      new Request(`${API}/v1/installs`, {
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }) as unknown as Parameters<typeof worker.fetch>[0],
      e.env,
      ctx(),
    );
    expect(res.status).toBe(200);
  });
});
