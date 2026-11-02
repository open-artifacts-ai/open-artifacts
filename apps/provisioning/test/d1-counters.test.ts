import { describe, expect, it } from "vitest";
import { countD1, D1_LIMITS } from "../src/limits.js";
import { platformDb } from "./db.js";

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
