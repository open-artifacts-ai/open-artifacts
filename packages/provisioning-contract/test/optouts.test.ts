// The shapes the install and the platform's opt-out list share (#2652). Both
// repos run this: the cloud routes' bodies and answers must parse as these,
// and nothing looser.
import { describe, expect, it } from "vitest";
import {
  OPTOUT_CHECK_PATH,
  OPTOUT_H1_RE,
  OPTOUT_MINT_PATH,
  OPTOUT_NONCE_RE,
  OPTOUT_TOKEN_RE,
  OPTOUT_UNSUBSCRIBE_PATH,
  OptoutBodySchema,
  OptoutCheckResponseSchema,
  OptoutMintResponseSchema,
} from "../src/index.js";

const H1 = "a".repeat(64);
const NONCE = "abcdefghijklmnop_-0123";
const TOKEN = `${"A".repeat(40)}.${"b".repeat(43)}`;

describe("opt-out list contract", () => {
  it("the fixed paths", () => {
    expect(OPTOUT_CHECK_PATH).toBe("/optouts/check");
    expect(OPTOUT_MINT_PATH).toBe("/optouts/mint");
    expect(OPTOUT_UNSUBSCRIBE_PATH).toBe("/unsubscribe");
  });

  it("the body is exactly { ts, nonce, h1 }, whatever the key order", () => {
    const ok = { ts: 1_794_000_000_000, nonce: NONCE, h1: H1 };
    expect(OptoutBodySchema.parse(ok)).toEqual(ok);
    expect(OptoutBodySchema.parse({ h1: H1, nonce: NONCE, ts: ok.ts })).toEqual(
      ok,
    );
    for (const bad of [
      { ...ok, install: "iabc123456789" },
      { ...ok, address: "a@b.co" },
      { nonce: NONCE, h1: H1 },
      { ...ok, ts: "1" },
      { ...ok, ts: Number.POSITIVE_INFINITY },
      { ...ok, nonce: "short" },
      { ...ok, nonce: "x".repeat(65) },
      { ...ok, nonce: `${"a".repeat(16)}!` },
      { ...ok, h1: H1.toUpperCase() },
      { ...ok, h1: "a".repeat(63) },
      { ...ok, h1: "a@b.co" },
    ])
      expect(OptoutBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it("check answers { optedOut: boolean } and nothing else", () => {
    expect(OptoutCheckResponseSchema.parse({ optedOut: true })).toEqual({
      optedOut: true,
    });
    expect(OptoutCheckResponseSchema.parse({ optedOut: false })).toEqual({
      optedOut: false,
    });
    for (const bad of [
      {},
      { optedOut: "no" },
      { optedOut: false, token: "x" },
      [],
      null,
    ])
      expect(OptoutCheckResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("mint answers { token } in the minted shape", () => {
    expect(OptoutMintResponseSchema.parse({ token: TOKEN })).toEqual({
      token: TOKEN,
    });
    for (const bad of [
      {},
      { token: "" },
      { token: "no-dot" },
      { token: `${"A".repeat(513)}.${"b".repeat(43)}` },
      { token: `${"A".repeat(10)}.${"b".repeat(42)}` },
      { token: TOKEN, extra: 1 },
    ])
      expect(OptoutMintResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("the patterns", () => {
    expect(OPTOUT_H1_RE.test(H1)).toBe(true);
    expect(OPTOUT_NONCE_RE.test(NONCE)).toBe(true);
    expect(OPTOUT_TOKEN_RE.test(TOKEN)).toBe(true);
  });
});
