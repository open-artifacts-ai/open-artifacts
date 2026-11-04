import { describe, expect, it } from "vitest";
import {
  BusNameSchema,
  candidateName,
  isReservedBusName,
  suffixName,
} from "../src/names.js";

describe("bus names", () => {
  it("accepts human names with spaces", () => {
    for (const n of ["OpenBus Backend", "agent-2", "Pi", "a.b_c"]) {
      expect(BusNameSchema.safeParse(n).success).toBe(true);
    }
  });
  it("rejects address-shaped, control or oversized names", () => {
    for (const n of [
      "a@b.com",
      "host:1234",
      "a/b",
      "a\\b",
      "",
      " lead",
      "trail ",
      "..",
      ".",
      "x".repeat(65),
      "tab\there",
      "<script>",
    ]) {
      expect(BusNameSchema.safeParse(n).success).toBe(false);
    }
  });
  it("suffixes without exceeding 64 chars", () => {
    expect(suffixName("Artifacts Manager", 2)).toBe("Artifacts Manager-2");
    const long = "n".repeat(64);
    const out = suffixName(long, 12);
    expect(out.length).toBe(64);
    expect(out.endsWith("-12")).toBe(true);
  });
  it("turns any proposal into a usable candidate", () => {
    expect(candidateName("  My  Agent ")).toBe("My Agent");
    expect(candidateName("a@b.com")).toBe("agent");
    expect(candidateName("")).toBe("agent");
    expect(candidateName("x".repeat(80)).length).toBe(64);
  });
});

describe("bus name hardening", () => {
  it("K: rejects names ending in a dot", () => {
    for (const x of ["a.", "agent..", "lead."]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(false);
    }
    expect(candidateName("lead.")).toBe("lead");
  });
  it("L: rejects IPv4-shaped names but keeps domain-shaped ones", () => {
    for (const x of ["10.0.0.1", "127.0.0.1"]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(false);
    }
    for (const x of ["example.com", "api.openai.com"]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(true);
    }
  });
  it("M: suffixName throws on an invalid base or counter", () => {
    const bad: [string, number][] = [
      ["a@b.com", 2],
      ["-", 2],
      ["x".repeat(64), 1e21],
      ["agent", Number.NaN],
      ["agent", -1],
      ["agent", 1],
      ["agent", 2.5],
    ];
    for (const [b, k] of bad) {
      expect(() => suffixName(b, k), `${b},${k}`).toThrow();
    }
  });
  it("M: suffixName results are always valid bus names", () => {
    for (const b of ["agent", "a.b", "x".repeat(64), "a b."].filter(
      (x) => BusNameSchema.safeParse(x).success,
    )) {
      for (const k of [2, 3, 12, 999999]) {
        const out = suffixName(b, k);
        expect(BusNameSchema.safeParse(out).success, out).toBe(true);
        expect(out.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("reserved bus names", () => {
  const reserved = [
    "openbus",
    "open-bus",
    "OpenBus",
    "OPENBUS",
    "Open-Bus",
    "openbus-2",
    "OpenBus-17",
    "open-bus-3",
    "openbus-2-3",
    "open bus",
    "Open Bus",
    "open.bus",
    "open_bus",
    "open bus-4",
    "open--bus",
    "open__bus",
    "open - bus",
    "open._bus",
    "openbus-",
    "openbus_",
    "open-bus-",
    "openbus--2",
    "openbus_-2",
  ];
  const allowed = [
    "openbusy",
    "my-openbus",
    "openbus2",
    "open_bus2",
    "openbus-x",
    "open-buses",
    "openbus-2a",
    "open",
  ];

  it("rejects exact, case, suffixed, space and dot forms", () => {
    for (const n of reserved) {
      expect(isReservedBusName(n), n).toBe(true);
      expect(BusNameSchema.safeParse(n).success, n).toBe(false);
    }
  });
  it("keeps near-misses allowed (openbus2 without a hyphen is NOT reserved)", () => {
    for (const n of allowed) {
      expect(isReservedBusName(n), n).toBe(false);
      expect(BusNameSchema.safeParse(n).success, n).toBe(true);
    }
  });
  it("gives a clear message", () => {
    const r = BusNameSchema.safeParse("openbus");
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("reserved");
  });
  it("candidateName never returns a reserved name", () => {
    for (const n of reserved) {
      const out = candidateName(n);
      expect(out, n).toBe("agent");
      expect(BusNameSchema.safeParse(out).success).toBe(true);
    }
    expect(candidateName("OpenBus.")).toBe("agent");
    expect(candidateName("openbusy")).toBe("openbusy");
  });
  it("suffixName throws on a reserved base", () => {
    expect(() => suffixName("openbus", 2)).toThrow();
    expect(() => suffixName("Open Bus", 3)).toThrow();
  });
  it("every candidateName output is valid and unreserved", () => {
    for (const x of [
      ...reserved,
      ...allowed,
      "",
      "a@b",
      "  OpenBus  ",
      "x".repeat(90),
    ]) {
      const out = candidateName(x);
      expect(BusNameSchema.safeParse(out).success, x).toBe(true);
      expect(isReservedBusName(out), x).toBe(false);
    }
  });
});
