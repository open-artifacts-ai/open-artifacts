import { describe, expect, it } from "vitest";
import { ipKeyOf } from "../src/services/counters.js";

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
