import { describe, expect, it } from "vitest";
import { countD1, D1_LIMITS } from "../src/limits.js";
import { ipKeyOf } from "../src/services/counters.js";
import { platformDb } from "./db.js";

// The per-prefix keys of the self-serve create counters (4.7): the same
// answers as W5b's @oa/auth-core ipKeyOf.

describe("ipKeyOf", () => {
  it("keeps IPv4 whole", () => {
    expect(ipKeyOf("192.0.2.1", 64)).toBe("192.0.2.1");
    expect(ipKeyOf("192.0.2.1", 48)).toBe("192.0.2.1");
  });

  it("truncates IPv6 to /64 and /48, any spelling", () => {
    for (const ip of [
      "2001:db8:1:2::5",
      "2001:0db8:0001:0002:0000:0000:0000:0005",
      "2001:DB8:1:2:ffff::1",
    ])
      expect(ipKeyOf(ip, 64), ip).toBe("2001:db8:1:2::/64");
    expect(ipKeyOf("2001:db8:1:2::5", 48)).toBe("2001:db8:1::/48");
    expect(ipKeyOf("::1", 64)).toBe("0:0:0:0::/64");
  });

  it("an IPv4-mapped IPv6 address is its IPv4, not one shared ::/64", () => {
    expect(ipKeyOf("::ffff:192.0.2.1", 64)).toBe("192.0.2.1");
    expect(ipKeyOf("::ffff:c000:201", 48)).toBe("192.0.2.1");
  });

  it("an unparsable address is the one shared key unknown", () => {
    for (const ip of ["1:2:3", "1::2::3", "", "not an ip"])
      expect(ipKeyOf(ip, 64), ip).toBe("unknown");
  });
});

const H = 3_600_000;
const T = 1_800_000_000_000; // a whole hour

describe("countD1 (4.7 D1 counters)", () => {
  it("token mints: 20 per admin per hour", () => {
    expect(D1_LIMITS.mint).toEqual({ limit: 20, windowMs: H });
  });

  it("allows up to the limit in one window, refuses past it", async () => {
    const env = { PLATFORM_DB: await platformDb() };
    const key = `t:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++)
      expect(await countD1(env, key, 3, H, T + i)).toBeNull();
    expect(await countD1(env, key, 3, H, T + H - 1)).toEqual({
      refusal: true,
      code: "rate_limited",
    });
  });

  it("a new window starts at zero; keys are independent", async () => {
    const env = { PLATFORM_DB: await platformDb() };
    const key = `t:${crypto.randomUUID()}`;
    expect(await countD1(env, key, 1, H, T)).toBeNull();
    expect(await countD1(env, key, 1, H, T + 1)).not.toBeNull();
    expect(await countD1(env, key, 1, H, T + H)).toBeNull();
    expect(await countD1(env, `${key}x`, 1, H, T + 1)).toBeNull();
  });

  it("concurrent hits are counted exactly (atomic upsert)", async () => {
    const env = { PLATFORM_DB: await platformDb() };
    const key = `t:${crypto.randomUUID()}`;
    const r = await Promise.all(
      Array.from({ length: 10 }, () => countD1(env, key, 4, H, T)),
    );
    expect(r.filter((x) => x === null)).toHaveLength(4);
  });
});
