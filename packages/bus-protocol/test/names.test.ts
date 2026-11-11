import { describe, expect, it } from "vitest";
import {
  BusNameSchema,
  candidateName,
  droppedRefusedChars,
  impersonates,
  isReservedBusName,
  looksLikeProse,
  suffixName,
} from "../src/names.ts";

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
    expect(candidateName("a@b.com")).toBe("ab.com"); // #1480: refused chars are dropped
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

  it("keeps what it can of a name with refused characters (#1480)", () => {
    const table: Array<[string, string]> = [
      ["OA Owner (2)", "OA Owner 2"],
      ["(lead)", "lead"],
      ["a/b\\c:d", "abcd"],
      ["Owner  (  2 )", "Owner 2"],
      ["  --Lead--  ", "Lead--"],
      ["_x", "x"],
      ["R&D team", "RD team"],
      ["Owner \u{1F680}", "Owner"],
      ["Own\u0007er (2)", "Owner 2"],
      ["a.b (c)", "a.b c"],
      ["Lead (", "Lead"],
      // nothing usable left
      ["()", "agent"],
      ["@@@", "agent"],
      ["...", "agent"],
      // letters or digits outside ASCII: no half-names
      ["\u65e5\u672c\u8a9e", "agent"],
      ["caf\u00e9 (2)", "agent"],
      ["\u65e5\u672c Owner", "agent"],
      // still refused after cleaning
      ["(1.2.3.4)", "agent"],
      ["Open(Bus)", "agent"],
      ["(openbus)", "agent"],
      ["open (bus) 2", "agent"],
    ];
    for (const [raw, want] of table) expect(candidateName(raw), raw).toBe(want);
    // the length cap applies after cleaning
    const long = candidateName(`${"x".repeat(63)} (y) z`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(BusNameSchema.safeParse(long).success).toBe(true);
    expect(candidateName(`(${"x".repeat(70)})`)).toBe("x".repeat(64));
  });
  it("candidateName is idempotent and never reaches a reserved name", () => {
    for (const x of [
      "OA Owner (2)",
      "Open(Bus)",
      "a (b) c",
      "(1.2.3.4)",
      "-- x --",
    ]) {
      const once = candidateName(x);
      expect(candidateName(once), x).toBe(once);
      expect(isReservedBusName(once), x).toBe(false);
    }
  });
  it("droppedRefusedChars: only a name kept by dropping refused characters (#1480)", () => {
    for (const x of [
      "OA Manager!",
      "OA Owner (2)",
      "a@b.com",
      "Owner \u{1F680}",
    ])
      expect(droppedRefusedChars(x), x).toBe(true);
    for (const x of [
      "Lead ",
      "Two  Words",
      "lead.",
      "Own\u0007er",
      "x".repeat(80),
      "OA Owner",
      "()",
      "caf\u00e9",
    ])
      expect(droppedRefusedChars(x), x).toBe(false);
  });
});

describe("fork session names (#1916)", () => {
  it("names a fork by its parent plus fork", () => {
    expect(
      candidateName(
        "OA Manager \u2442 One thing I noticed If I -mention an agent",
      ),
    ).toBe("OA Manager fork");
    expect(candidateName("OA Manager\u2442x")).toBe("OA Manager fork");
    expect(candidateName("a \u2442 b \u2442 c")).toBe("a fork");
  });
  it("falls back on an empty parent", () => {
    expect(candidateName("\u2442 hello")).toBe("agent");
    expect(candidateName("  \u2442 hello")).toBe("agent");
  });
  it("trims the parent so fork survives the cap", () => {
    const out = candidateName(`${"x".repeat(80)} \u2442 hi`);
    expect(out.length).toBe(64);
    expect(out.endsWith("x fork")).toBe(true);
    expect(BusNameSchema.safeParse(out).success).toBe(true);
  });
  it("never lets a fork reclaim the parent's address", () => {
    expect(droppedRefusedChars("OA Manager \u2442 hello")).toBe(true);
    expect(droppedRefusedChars("\u2442 hello")).toBe(true);
    expect(droppedRefusedChars("OA Manager")).toBe(false);
  });
});

describe("prose harness titles (#1916)", () => {
  const h = { harness: true };
  it("the real case becomes the fallback, cleaned or raw", () => {
    expect(
      candidateName(
        "OA Manager One thing I noticed If I -mention an agent in a c",
        h,
      ),
    ).toBe("agent");
    expect(
      candidateName(
        "OA Manager One thing I noticed: If I @-mention an agent in a c",
        h,
      ),
    ).toBe("agent");
    expect(
      droppedRefusedChars(
        "OA Manager One thing I noticed: If I @-mention an agent in a c",
        h,
      ),
    ).toBe(false);
  });
  it("real names stay", () => {
    for (const n of [
      "OA Hermes",
      "OA Agent Experience",
      "OA Platform B",
      "Pi Permissions",
      "oa-wt-overlay-signup-r2-ac",
      "OA Manager fork",
      "open-artifacts-e6",
    ])
      expect(candidateName(n, h)).toBe(n);
  });
  it("edges: 4 vs 5 words, 32 vs 33 chars", () => {
    expect(candidateName("a b c d", h)).toBe("a b c d");
    expect(candidateName("a b c d e", h)).toBe("agent");
    expect(candidateName("x".repeat(32), h)).toBe("x".repeat(32));
    expect(candidateName("x".repeat(33), h)).toBe("agent");
    expect(looksLikeProse("x".repeat(33))).toBe(true);
    expect(looksLikeProse("x".repeat(32))).toBe(false);
  });
  it("without harness the name is kept (a user's rename)", () => {
    expect(candidateName("a b c d e f g")).toBe("a b c d e f g");
    expect(candidateName("x".repeat(40))).toBe("x".repeat(40));
  });
  it("a fork keeps its handling", () => {
    expect(
      candidateName("OA Manager \u2442 do a long thing here now please", h),
    ).toBe("OA Manager fork");
  });
  it("impersonates: another name plus more than one word", () => {
    expect(impersonates("OA Platform B", "OA Platform")).toBe(false);
    expect(impersonates("OA Platform-2", "OA Platform")).toBe(false);
    expect(impersonates("OA Platform fork", "OA Platform")).toBe(false);
    expect(impersonates("oa platform one two", "OA Platform")).toBe(true);
    expect(impersonates("OA Platformer one two", "OA Platform")).toBe(false);
    expect(impersonates("OA Platform", "OA Platform")).toBe(false);
  });
});
