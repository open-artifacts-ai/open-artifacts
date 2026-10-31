import { describe, expect, it } from "vitest";
import { ipPrefix } from "../src/services/counters.js";

// The per-prefix keys of the self-serve create counters (4.7).

describe("ipPrefix", () => {
  it("keeps IPv4 whole", () => {
    expect(ipPrefix("192.0.2.1", 64)).toBe("192.0.2.1");
    expect(ipPrefix("192.0.2.1", 48)).toBe("192.0.2.1");
  });

  it("truncates IPv6 to /64 and /48, any spelling", () => {
    for (const ip of [
      "2001:db8:1:2::5",
      "2001:0db8:0001:0002:0000:0000:0000:0005",
      "2001:DB8:1:2:ffff::1",
    ])
      expect(ipPrefix(ip, 64), ip).toBe("2001:db8:1:2::/64");
    expect(ipPrefix("2001:db8:1:2::5", 48)).toBe("2001:db8:1::/48");
    expect(ipPrefix("::1", 64)).toBe("0:0:0:0::/64");
    expect(ipPrefix("::ffff:192.0.2.1", 64)).toBe("0:0:0:0::/64");
  });

  it("an unparsable address is its own key", () => {
    expect(ipPrefix("1:2:3", 64)).toBe("1:2:3");
    expect(ipPrefix("1::2::3", 64)).toBe("1::2::3");
  });
});
