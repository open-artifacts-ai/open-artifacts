import { env } from "cloudflare:workers";
import { HealthzSchema, TEST_HOOKS } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

// P2 T14 release guard: with TEST_HOOKS_ALLOWED false (a release build's
// value), TEST_HOOKS=1, a valid key and a TEST_DOMAIN still answer the
// standard 404 on every hook path, and /healthz omits testHooks.
const KEY = "k".repeat(48);
const rl = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const e = {
  ...env,
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: KEY,
  TEST_DOMAIN: "p5.test",
  RL_ANON: rl,
} as Env;

afterEach(() => {
  vi.doUnmock("@oa/shared");
  vi.resetModules();
});

async function load(allowed: boolean) {
  vi.resetModules();
  vi.doMock("@oa/shared", async (orig) => ({
    ...(await orig<typeof import("@oa/shared")>()),
    TEST_HOOKS_ALLOWED: allowed,
  }));
  return (await import("../src/index.js")).default;
}

const fetchVia = (
  worker: Awaited<ReturnType<typeof load>>,
  path: string,
  method = "POST",
) =>
  worker.fetch(
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.201",
        authorization: `Bearer ${KEY}`,
      },
      body:
        method === "GET"
          ? undefined
          : JSON.stringify({ email: "a@p5.test", role: "member" }),
    }) as never,
    e,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );

describe("release guard (TEST_HOOKS_ALLOWED)", () => {
  it("false: every hook path is the standard 404 and /healthz has no testHooks", async () => {
    const worker = await load(false);
    const ref = await fetchVia(worker, "/__test/nothing-here", "GET");
    const refBody = await ref.text();
    expect(ref.status).toBe(404);
    for (const p of [...Object.values(TEST_HOOKS), "/__test/x"])
      for (const m of ["GET", "POST"]) {
        const r = await fetchVia(worker, p, m);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe(refBody);
      }
    const h = HealthzSchema.parse(
      await (await fetchVia(worker, "/healthz", "GET")).json(),
    );
    expect(h.testHooks).toBeUndefined();
  });

  it("true (control): the same env gets a session", async () => {
    const worker = await load(true);
    expect((await fetchVia(worker, TEST_HOOKS.session)).status).toBe(200);
  });

  it("audit: a valid read is the 404 when false, 200 when true", async () => {
    const audit = (worker: Awaited<ReturnType<typeof load>>) =>
      worker.fetch(
        new Request(`http://app.localhost${TEST_HOOKS.audit}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.201",
            authorization: `Bearer ${KEY}`,
          },
          body: JSON.stringify({ since: 0 }),
        }) as never,
        e,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
    expect((await audit(await load(false))).status).toBe(404);
    expect((await audit(await load(true))).status).toBe(200);
  });
});
