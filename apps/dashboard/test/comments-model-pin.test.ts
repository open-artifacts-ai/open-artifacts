import { describe, expect, it } from "vitest";
import { frameThreads, pinChanged } from "../src/viewer/comments/model";

describe("pinChanged (#1490)", () => {
  const h = "a".repeat(64);
  it("is true only when both hashes are known and differ", () => {
    expect(pinChanged(h, "b".repeat(64))).toBe(true);
    expect(pinChanged(h, h)).toBe(false);
  });
  it("is false when either side is empty or null", () => {
    expect(pinChanged(null, h)).toBe(false);
    expect(pinChanged(h, null)).toBe(false);
    expect(pinChanged(null, null)).toBe(false);
    expect(pinChanged("", h)).toBe(false);
    expect(pinChanged(h, "")).toBe(false);
  });
});

describe("a pin whose page changed (#1657)", () => {
  const h = "a".repeat(64);
  const pin = (hash: string) => ({
    id: "p1",
    version: 1,
    status: "open" as const,
    anchor: { kind: "pin" as const, x: 0.5, y: 0.5, contentHash: hash },
    createdAt: "2026-11-05T10:00:00Z",
  });
  const wire = (thread: ReturnType<typeof pin>, versionHash: string) =>
    frameThreads([thread as never], null, versionHash)[0];

  it("carries changed:true when the shown version's hash moved on", () => {
    const out = wire(pin(h), "b".repeat(64));
    expect(out?.changed).toBe(true);
  });

  it("says nothing when the hashes match or are unknown", () => {
    expect(wire(pin(h), h)?.changed).toBeUndefined();
    expect(wire(pin(h), "")?.changed).toBeUndefined();
  });

  it("never marks a text thread, even one carrying a hash the frame could see", () => {
    const text = {
      id: "t1",
      version: 1,
      status: "open" as const,
      // Not part of a text anchor's shape; the guard, not the type, must stop it.
      anchor: {
        kind: "text" as const,
        quote: "x",
        prefix: "",
        suffix: "",
        contentHash: h,
      },
      createdAt: "2026-11-05T10:00:00Z",
    };
    const out = frameThreads([text as never], null, "b".repeat(64))[0];
    expect(out?.changed).toBeUndefined();
  });
});
