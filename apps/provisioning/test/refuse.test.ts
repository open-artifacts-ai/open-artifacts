import {
  API_ERROR_STATUS,
  AUDIT_REFUSAL_WINDOW_MS,
} from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmac16 } from "../src/hmac.js";
import { refuse } from "../src/refuse.js";
import { platformDb } from "./db.js";
import { API, fakeEnv } from "./fakes.js";

const T = 1_800_000_000_000; // a whole 10-minute window
const req = (ip: string) =>
  new Request(`${API}/v1/me`, { headers: { "cf-connecting-ip": ip } });

type Row = {
  bucket: string;
  code: string;
  ip_hmac: string;
  window_start: number;
  count: number;
};

describe("refuse (4.9)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the envelope with the code's one status, no-store", async () => {
    const { env } = fakeEnv();
    for (const code of [
      "unauthenticated",
      "rate_limited",
      "unavailable",
    ] as const) {
      const res = await refuse(env, "pre", code, new Request(`${API}/v1/me`));
      expect(res.status).toBe(API_ERROR_STATUS[code]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
    }
  });

  it("still answers when the count cannot be written (D1 down)", async () => {
    const { env } = fakeEnv();
    const res = await refuse(env, "auth", "unauthenticated", req("192.0.2.1"));
    expect(res.status).toBe(401);
  });

  describe("aggregates into audit_refusals", () => {
    const rows = async (db: D1Database, ipHmac: string) =>
      (
        await db
          .prepare(
            "SELECT bucket, code, ip_hmac, window_start, count FROM audit_refusals WHERE ip_hmac = ?1 ORDER BY bucket, code, window_start",
          )
          .bind(ipHmac)
          .all<Row>()
      ).results;
    // Each case uses its own address so cases never share rows.
    const ip4 = () =>
      `198.51.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    it("one row per bucket, code, IP and window, with a count", async () => {
      const db = await platformDb();
      const { env } = fakeEnv({ PLATFORM_DB: db });
      const ip = ip4();
      for (let i = 0; i < 3; i++)
        await refuse(env, "auth", "unauthenticated", req(ip));
      await refuse(env, "csrf", "csrf_failed", req(ip));
      const h = await hmac16(env, ip);
      expect(await rows(db, h)).toEqual([
        {
          bucket: "auth",
          code: "unauthenticated",
          ip_hmac: h,
          window_start: T,
          count: 3,
        },
        {
          bucket: "csrf",
          code: "csrf_failed",
          ip_hmac: h,
          window_start: T,
          count: 1,
        },
      ]);
    });

    it("never stores the raw IP; the key is the 16-byte HMAC", async () => {
      const db = await platformDb();
      const { env } = fakeEnv({ PLATFORM_DB: db });
      const ip = ip4();
      await refuse(env, "pre", "rate_limited", req(ip));
      const h = await hmac16(env, ip);
      expect(h).toMatch(/^[0-9a-f]{32}$/);
      const all = await db
        .prepare("SELECT * FROM audit_refusals")
        .all<Record<string, unknown>>();
      expect(JSON.stringify(all.results)).not.toContain(ip);
    });

    it("a new 10-minute window starts a new row", async () => {
      const db = await platformDb();
      const { env } = fakeEnv({ PLATFORM_DB: db });
      const ip = ip4();
      await refuse(env, "auth", "unauthenticated", req(ip));
      vi.setSystemTime(T + AUDIT_REFUSAL_WINDOW_MS - 1);
      await refuse(env, "auth", "unauthenticated", req(ip));
      vi.setSystemTime(T + AUDIT_REFUSAL_WINDOW_MS);
      await refuse(env, "auth", "unauthenticated", req(ip));
      const r = await rows(db, await hmac16(env, ip));
      expect(r.map((x) => [x.window_start, x.count])).toEqual([
        [T, 2],
        [T + AUDIT_REFUSAL_WINDOW_MS, 1],
      ]);
    });

    it("an IPv6 flood inside one /64 is one row", async () => {
      const db = await platformDb();
      const { env } = fakeEnv({ PLATFORM_DB: db });
      const p = `2001:db8:${Math.floor(Math.random() * 65535).toString(16)}:7`;
      for (const s of ["::1", "::2", ":ffff:ffff:ffff:ffff"])
        await refuse(env, "pre", "rate_limited", req(`${p}${s}`));
      const r = await rows(db, await hmac16(env, `${p}::/64`));
      expect(r.map((x) => x.count)).toEqual([3]);
    });
  });
});
