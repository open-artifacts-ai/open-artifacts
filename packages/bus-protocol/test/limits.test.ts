import { describe, expect, it } from "vitest";
import { LIMITS, utf8Bytes, utf8Exceeds } from "../src/limits.js";

describe("limits", () => {
  it("pins the spec values", () => {
    expect(LIMITS.inlineBodyBytes).toBe(32 * 1024);
    expect(LIMITS.maxMessageBytes).toBe(1024 * 1024);
    expect(LIMITS.mailTtlSec).toBe(3600);
    expect(LIMITS.inboxCap).toBe(50);
    expect(LIMITS.ackTimeoutMs).toBe(10_000);
    expect(LIMITS.deviceCodeTtlSec).toBe(600);
    expect(LIMITS.devicePollIntervalSec).toBe(5);
    expect(LIMITS.revokeCloseCode).toBe(4403);
  });
  it("measures UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("🙂")).toBe(4);
    expect(utf8Exceeds("🙂".repeat(9000), LIMITS.inlineBodyBytes)).toBe(true);
    expect(
      utf8Exceeds("a".repeat(LIMITS.inlineBodyBytes), LIMITS.inlineBodyBytes),
    ).toBe(false);
    expect(
      utf8Exceeds(
        "a".repeat(LIMITS.inlineBodyBytes + 1),
        LIMITS.inlineBodyBytes,
      ),
    ).toBe(true);
  });
});

it("pins the roster cap", () => {
  expect(LIMITS.maxRosterAgents).toBe(1000);
  expect(LIMITS.maxAgentsPerMachine).toBe(200);
  expect(LIMITS.rateLimitCloseCode).toBe(4429);
  expect(LIMITS.rateLimitCooldownMs).toBe(10_000);
});
