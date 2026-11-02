import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimState,
  getState,
  raiseState,
  unclaimState,
} from "../src/provapi/state.js";
import { db, migrate, reset } from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const K = "test_key";

describe("platform_state helpers", () => {
  it("get is null for an unset key", async () => {
    expect(await getState(db, K)).toBeNull();
  });

  it("raise never lowers a newer value", async () => {
    await raiseState(db, K, NOW);
    await raiseState(db, K, NOW - 1);
    expect(await getState(db, K)).toBe(NOW);
    await raiseState(db, K, NOW + 1);
    expect(await getState(db, K)).toBe(NOW + 1);
  });

  it("overlapping claims: exactly one wins", async () => {
    const won = await Promise.all(
      Array.from({ length: 8 }, () => claimState(db, K, NOW, NOW - 10)),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await getState(db, K)).toBe(NOW);
  });

  it("a claim wins again only once the stored value is at or before the cutoff", async () => {
    expect(await claimState(db, K, NOW, NOW - 10)).toBe(true);
    expect(await claimState(db, K, NOW + 5, NOW - 1)).toBe(false);
    expect(await claimState(db, K, NOW + 10, NOW)).toBe(true);
    expect(await getState(db, K)).toBe(NOW + 10);
  });

  it("unclaim restores the previous value or unsets, and only our own claim", async () => {
    await claimState(db, K, NOW, 0);
    await unclaimState(db, K, NOW, null);
    expect(await getState(db, K)).toBeNull();
    await claimState(db, K, NOW, 0);
    await claimState(db, K, NOW + 1, NOW);
    // Not ours any more: left as is.
    await unclaimState(db, K, NOW, null);
    expect(await getState(db, K)).toBe(NOW + 1);
    await unclaimState(db, K, NOW + 1, NOW);
    expect(await getState(db, K)).toBe(NOW);
  });
});
