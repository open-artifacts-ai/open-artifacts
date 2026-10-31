import { describe, expect, test } from "vitest";
import { ipKey, ipKeyOf } from "../src/ipkey.js";

// ipKey (design v7 4.7): IPv4 whole, IPv6 by /64; one helper for the
// Provisioning API, the broker and the D1 counters.

describe("ipKeyOf", () => {
  test.each([
    ["192.0.2.1", "192.0.2.1"],
    [" 192.0.2.1 ", "192.0.2.1"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:DB8:0001:0002:ffff::1", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::ffff:192.0.2.7", "192.0.2.7"],
    ["::ffff:c000:207", "192.0.2.7"],
    ["2001:db8:1:2::192.0.2.1", "2001:db8:1:2::/64"],
  ])("%s -> %s", (ip, key) => {
    expect(ipKeyOf(ip)).toBe(key);
  });

  test("two addresses in one /64 share a key; the next /64 does not", () => {
    expect(ipKeyOf("2001:db8:a:b::1")).toBe(ipKeyOf("2001:db8:a:b:ffff::2"));
    expect(ipKeyOf("2001:db8:a:c::1")).not.toBe(ipKeyOf("2001:db8:a:b::1"));
  });

  test.each([
    [null],
    [""],
    ["junk"],
    ["1.2.3"],
    ["256.1.1.1"],
    ["1:2:3:4:5:6:7:8:9"],
    ["1::2::3"],
    ["gggg::1"],
  ])("%s is unknown", (ip) => {
    expect(ipKeyOf(ip)).toBe("unknown");
  });
});

describe("ipKey", () => {
  test("reads cf-connecting-ip", () => {
    const r = (ip?: string) =>
      new Request("https://x.test/", {
        headers: ip ? { "cf-connecting-ip": ip } : {},
      });
    expect(ipKey(r("198.51.100.4"))).toBe("198.51.100.4");
    expect(ipKey(r("2001:db8:1:2::5"))).toBe("2001:db8:1:2::/64");
    expect(ipKey(r())).toBe("unknown");
  });
});
