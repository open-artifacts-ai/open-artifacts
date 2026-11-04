import { describe, expect, it } from "vitest";
import {
  BUS_ROUTES,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  verificationUriMatches,
} from "../src/device.js";
import {
  isDeviceSecret,
  isMachineToken,
  newDeviceSecret,
  newMachineToken,
} from "../src/ids.js";

const ok = {
  device_code: newDeviceSecret(),
  user_code: "AB2C-D3E4",
  verification_uri: "https://oa.example.com/bus/approve/AB2C-D3E4",
  expires_in: 600,
  interval: 5,
};
const p = (verification_uri: string) =>
  DeviceCodeResponseSchema.safeParse({ ...ok, verification_uri }).success;

describe("routes", () => {
  it("pins the instance routes (design: Contracts)", () => {
    expect(BUS_ROUTES.device).toBe("/bus/device");
    expect(BUS_ROUTES.deviceToken).toBe("/bus/device/token");
    expect(BUS_ROUTES.connect).toBe("/bus/connect");
    expect(BUS_ROUTES.approve("AB2C-D3E4")).toBe("/bus/approve/AB2C-D3E4");
    expect(BUS_ROUTES.approve("AB2CD3E4")).toBe("/bus/approve/AB2CD3E4");
  });
  it("approve rejects anything but a user code", () => {
    for (const x of [
      "",
      ".",
      "..",
      "AB2C-D3E",
      "ab2c-d3e4",
      "AB2C D3E4",
      "IIII-OOOO",
      "../x",
    ])
      expect(() => BUS_ROUTES.approve(x), x).toThrow();
  });
});

describe("device code response", () => {
  it("accepts the instance's approve page", () => {
    expect(DeviceCodeResponseSchema.safeParse(ok).success).toBe(true);
    expect(p("http://localhost:8787/bus/approve/AB2C-D3E4")).toBe(true);
    expect(p("http://127.0.0.1/bus/approve/AB2C-D3E4")).toBe(true);
    expect(p("http://[::1]:8787/bus/approve/AB2C-D3E4")).toBe(true);
  });
  it("rejects unsafe or wrong verification URIs", () => {
    for (const u of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://oa.example.com/bus/approve/AB2C-D3E4",
      "https://oa.example.com/approve/AB2C-D3E4",
      "https://oa.example.com/bus/approve/ZZZZ-ZZZZ",
      "https://oa.example.com/bus/approve/AB2C-D3E4/",
      "https://oa.example.com/bus/approve/ab2c-d3e4",
      "https://oa.example.com/bus/approve/AB2C-D3E4?x",
      "https://oa.example.com/bus/approve/AB2C-D3E4#x",
      "https://oa.example.com/bus/approve/AB2CD3E4",
      "https://oa.example.com@evil.com/bus/approve/AB2C-D3E4",
      "https://oa/x/../bus/approve/AB2C-D3E4",
      "https://oa/bus/approve/AB2C-D3E4\u0007",
      "https://o\na/bus/approve/AB2C-D3E4",
      "http://localhost.evil.com/bus/approve/AB2C-D3E4",
      "http://[::2]/bus/approve/AB2C-D3E4",
      `https://${"a".repeat(3000)}/bus/approve/AB2C-D3E4`,
    ])
      expect(p(u), u).toBe(false);
  });
  it("pins expiry and interval", () => {
    expect(
      DeviceCodeResponseSchema.safeParse({ ...ok, expires_in: 601 }).success,
    ).toBe(false);
    expect(
      DeviceCodeResponseSchema.safeParse({ ...ok, interval: 1 }).success,
    ).toBe(false);
  });
  it("device_code is pinned to the generator format", () => {
    for (const d of [
      "0".repeat(32),
      "_".repeat(43),
      "O".repeat(43),
      `${newDeviceSecret()}a`,
      newDeviceSecret().slice(1),
    ]) {
      expect(isDeviceSecret(d)).toBe(false);
      expect(
        DeviceTokenRequestSchema.safeParse({ device_code: d }).success,
        d,
      ).toBe(false);
      expect(
        DeviceCodeResponseSchema.safeParse({ ...ok, device_code: d }).success,
        d,
      ).toBe(false);
    }
  });
  it("the client checks the URI is on its own instance", () => {
    expect(
      verificationUriMatches(ok.verification_uri, "https://oa.example.com"),
    ).toBe(true);
    expect(
      verificationUriMatches(ok.verification_uri, "https://oa.example.com/"),
    ).toBe(true);
    expect(
      verificationUriMatches(ok.verification_uri, "https://evil.example.com"),
    ).toBe(false);
    expect(
      verificationUriMatches(ok.verification_uri, "http://oa.example.com"),
    ).toBe(false);
    expect(verificationUriMatches("nope", "https://oa.example.com")).toBe(
      false,
    );
  });
});

describe("device token response", () => {
  it("approved carries a machine token, and only that", () => {
    const machine_token = newMachineToken();
    expect(isMachineToken(machine_token)).toBe(true);
    expect(
      DeviceTokenResponseSchema.parse({ status: "approved", machine_token }),
    ).toEqual({ status: "approved", machine_token });
    for (const bad of [
      { status: "approved" },
      { status: "approved", machine_token: "oa_pat_x" },
      {
        status: "approved",
        machine_token: machine_token.replace("oa_machine_", "ob_machine_"),
      },
      { status: "approved", machine_token, extra: 1 },
      { status: "pending", machine_token },
    ])
      expect(
        DeviceTokenResponseSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
  it("other states carry nothing", () => {
    for (const status of ["pending", "denied", "expired"])
      expect(DeviceTokenResponseSchema.safeParse({ status }).success).toBe(
        true,
      );
    expect(
      DeviceTokenResponseSchema.safeParse({ status: "slow_down" }).success,
    ).toBe(false);
  });
});
