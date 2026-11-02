import { AUDIT_REFUSAL_WINDOW_MS } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmac16 } from "../src/auth/crypto.js";
import worker from "../src/index.js";
import { ADMIN, API, ctx, db, fakeEnv, migrate } from "./fakes.js";

// Every HTTP-adapter refusal lands in its 4.9 audit_refusals bucket, with
// the code it answered, keyed by the HMAC of the caller's ipKey (never the
// raw IP), end to end through worker.fetch.

const T = 1_800_000_000_000 + 7; // inside one 10-minute window
let n = 0;
// Each case uses its own address so cases never share rows (or the pre
// bucket's per-isolate first-seen set).
const ip = () => `203.0.113.${(n++ % 250) + 1}`;

beforeEach(async () => {
  await migrate();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

async function hit(
  url: string,
  init: RequestInit,
  addr: string,
  e = fakeEnv(),
) {
  const headers = new Headers(init.headers);
  if (addr) headers.set("cf-connecting-ip", addr);
  const req = new Request(url, { ...init, headers }) as Parameters<
    typeof worker.fetch
  >[0];
  const res = await worker.fetch(req, e.env, ctx());
  return { res, e };
}

async function rowsFor(key: string) {
  const h = await hmac16("k".repeat(32), key);
  return (
    await db
      .prepare(
        "SELECT bucket, code, window_start, count FROM audit_refusals WHERE ip_hmac = ?1 ORDER BY bucket, code",
      )
      .bind(h)
      .all<{
        bucket: string;
        code: string;
        window_start: number;
        count: number;
      }>()
  ).results;
}

const W = T - (T % AUDIT_REFUSAL_WINDOW_MS);

describe("refusal buckets (4.9)", () => {
  it("auth: Authorization on the admin host", async () => {
    const a = ip();
    const { res } = await hit(
      `${ADMIN}/api/v1/me`,
      { headers: { authorization: "Bearer x" } },
      a,
    );
    expect(res.status).toBe(401);
    expect(await rowsFor(a)).toEqual([
      { bucket: "auth", code: "unauthenticated", window_start: W, count: 1 },
    ]);
  });

  it("auth: a bad bearer on the api host, counted per call", async () => {
    const a = ip();
    for (let i = 0; i < 3; i++) {
      const { res } = await hit(
        `${API}/v1/installs`,
        { headers: { authorization: `Bearer oat_${"x".repeat(43)}` } },
        a,
      );
      expect(res.status).toBe(401);
    }
    expect(await rowsFor(a)).toEqual([
      { bucket: "auth", code: "unauthenticated", window_start: W, count: 3 },
    ]);
  });

  it("pre: over RL_PV_PRE_IP is rate_limited, one row however long the flood", async () => {
    const a = ip();
    const e = fakeEnv();
    e.limits.RL_PV_PRE_IP.allow = false;
    for (let i = 0; i < 5; i++) {
      const { res } = await hit(`${API}/v1/me`, {}, a, e);
      expect(res.status).toBe(429);
    }
    expect(await rowsFor(a)).toEqual([
      { bucket: "pre", code: "rate_limited", window_start: W, count: 1 },
    ]);
  });

  it("csrf: an admin-host write without Origin", async () => {
    const a = ip();
    const { res } = await hit(
      `${ADMIN}/api/v1/installs`,
      { method: "POST" },
      a,
    );
    expect(res.status).toBe(403);
    expect(await rowsFor(a)).toEqual([
      { bucket: "csrf", code: "csrf_failed", window_start: W, count: 1 },
    ]);
  });

  it("the raw IP is never stored", async () => {
    const a = ip();
    await hit(`${ADMIN}/api/v1/me`, { headers: { authorization: "x" } }, a);
    const raw = await db
      .prepare("SELECT count(*) AS n FROM audit_refusals WHERE ip_hmac = ?1")
      .bind(a)
      .first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });
});
