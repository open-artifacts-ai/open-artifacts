// P3 T18 on the per-request hot path (Free plan: 10 ms per request): the
// session read with the customer_mismatch denial and the 24 h cap. Runs
// serially via vitest.cpu.config.ts (median of 7); absolute bounds are
// reports, asserted only under test:cpu:strict (see budget()).
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { seedUser, uniq } from "./auth-helpers.js";
import { budget, medianMs as time } from "./cpu-time.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const me = (cookie: string) =>
  app.fetch(
    new Request(`http://app.localhost${R.me}`, { headers: { cookie } }),
    env,
    ctx,
  );
const state = (k: string, v: string) =>
  env.DB.prepare(
    "insert or replace into directory_state (key, value) values (?, ?)",
  )
    .bind(k, v)
    .run();

afterAll(() => env.DB.prepare("delete from directory_state").run());

describe("getUser with the T18 checks (Free: 10 ms)", () => {
  it("synced cookie session: healthy, unhealthy (capped) and customer_mismatch (denied)", async ({
    annotate,
  }) => {
    const id = await seedUser(uniq("cpu-t18"), "member", {
      googleSub: `cpu-t18-${crypto.randomUUID()}`,
    });
    await env.DB.prepare(
      "update identities set directory_bound = 1 where user_id = ?",
    )
      .bind(id)
      .run();
    const cookie = `${sessionCookieName(env)}=${await signSession(
      env,
      id,
      Date.now() - 25 * 3600_000,
      { provider: "google", epoch: 0 },
    )}`;
    await state("sync.state", "ok");
    await state("sync.health", JSON.stringify({ unhealthySince: null }));
    expect((await me(cookie)).status).toBe(200);
    const ok = await time(async () => (await me(cookie)).text());
    await state("sync.state", "backoff");
    await state(
      "sync.health",
      JSON.stringify({ unhealthySince: Date.now() - 2 * 3600_000 }),
    );
    expect((await me(cookie)).status).toBe(401);
    const capped = await time(async () => (await me(cookie)).text());
    await state("sync.state", "customer_mismatch");
    expect((await me(cookie)).status).toBe(401);
    const denied = await time(async () => (await me(cookie)).text());
    await budget(annotate, "GET me, synced, healthy", ok, 10);
    await budget(annotate, "GET me, synced, 24 h cap", capped, 10);
    await budget(annotate, "GET me, synced, customer_mismatch", denied, 10);
    expect(Math.max(ok, capped, denied)).toBeLessThan(100);
  });
});
