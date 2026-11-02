import { describe, expect, it } from "vitest";
import { ipKey, ipKeyOf } from "../src/ip.js";

const req = (ip?: string) =>
  new Request("https://api.example.test/v1/me", {
    headers: ip === undefined ? {} : { "cf-connecting-ip": ip },
  });

describe("ipKey (design v7 4.7)", () => {
  it("IPv4: the full address", () => {
    expect(ipKey(req("203.0.113.7"))).toBe("203.0.113.7");
    expect(ipKey(req(" 203.0.113.7 "))).toBe("203.0.113.7");
  });

  it("IPv6: truncated to the /64", () => {
    expect(ipKey(req("2001:db8:1:2:3:4:5:6"))).toBe("2001:db8:1:2::/64");
    expect(ipKey(req("2001:db8:1:2:ffff:ffff:ffff:ffff"))).toBe(
      "2001:db8:1:2::/64",
    );
  });

  it("IPv6: two addresses in one /64 share a key; another /64 does not", () => {
    const a = ipKey(req("2001:db8:aa:bb::1"));
    expect(ipKey(req("2001:0db8:00aa:00bb:dead:beef:0:1"))).toBe(a);
    expect(ipKey(req("2001:db8:aa:bc::1"))).not.toBe(a);
  });

  it("IPv6: normalizes case, zero padding and :: anywhere", () => {
    expect(ipKey(req("2001:DB8::1"))).toBe("2001:db8:0:0::/64");
    expect(ipKey(req("::1"))).toBe("0:0:0:0::/64");
    expect(ipKey(req("2001:db8:1:2::"))).toBe("2001:db8:1:2::/64");
    expect(ipKey(req("fe80::1%eth0"))).toBe("fe80:0:0:0::/64");
  });

  it("IPv4-mapped IPv6 is the IPv4 address", () => {
    expect(ipKey(req("::ffff:203.0.113.7"))).toBe("203.0.113.7");
  });

  it("no or junk header: one shared 'unknown' key", () => {
    expect(ipKey(req())).toBe("unknown");
    expect(ipKey(req(""))).toBe("unknown");
    expect(ipKey(req("not an ip"))).toBe("unknown");
    expect(ipKey(req("1:2:3:4:5:6:7:8:9"))).toBe("unknown");
    expect(ipKey(req("1::2::3"))).toBe("unknown");
    expect(ipKey(req("300.1.1.1"))).toBe("unknown");
  });

  it("ipKeyOf: other prefix lengths for the D1 counters (/48)", () => {
    expect(ipKeyOf("2001:db8:1:2:3:4:5:6", 48)).toBe("2001:db8:1::/48");
    expect(ipKeyOf("203.0.113.7", 48)).toBe("203.0.113.7");
  });
});
