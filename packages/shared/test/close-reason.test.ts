import { describe, expect, it } from "vitest";
import { accessChangedCloseReason, retryAfterFromClose } from "../src/index.js";

// #816 F1: the 4403 close reason a socket opened as access changed gets.
describe("access-changed close reason", () => {
  it("pins the format", () => {
    expect(accessChangedCloseReason(1750)).toBe(
      "access changed; retry after 1750 ms",
    );
    expect(accessChangedCloseReason(12.6)).toBe(
      "access changed; retry after 13 ms",
    );
  });

  it("round-trips through retryAfterFromClose", () => {
    for (const ms of [0, 250, 2250])
      expect(retryAfterFromClose(accessChangedCloseReason(ms))).toBe(ms);
  });

  it("is null for any other reason", () => {
    for (const r of [
      "access revoked",
      "",
      "access changed; retry after ms",
      "access changed; retry after -5 ms",
      "access changed; retry after 99999999 ms",
      " access changed; retry after 5 ms",
      undefined,
      4403,
    ])
      expect(retryAfterFromClose(r)).toBeNull();
  });
});
