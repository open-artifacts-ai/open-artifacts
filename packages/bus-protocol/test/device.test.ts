import { describe, expect, it } from "vitest";
import {
  BUS_ROUTES,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  verificationUriMatches,
} from "../src/device.ts";
import {
  isDeviceSecret,
  isMachineToken,
  newDeviceSecret,
  newMachineToken,
} from "../src/ids.ts";

const ok = {
  device_code: newDeviceSecret(),
  user_code: "AB2C-D3E4",
  verification_uri: "https://oa.example.com/bus/approve",
  expires_in: 600,
  interval: 5,
};
const p = (verification_uri: string) =>
  DeviceCodeResponseSchema.safeParse({ ...ok, verification_uri }).success;

/** Every way a verification URI could carry the user code (RFC 8628 section 5.4). */
const WITH_CODE = [
  "https://oa.example.com/bus/approve/AB2C-D3E4",
  "https://oa.example.com/bus/approve/AB2CD3E4",
  "https://oa.example.com/bus/approve/ab2c-d3e4",
  "https://oa.example.com/bus/approve?user_code=AB2C-D3E4",
  "https://oa.example.com/bus/approve?code=AB2CD3E4",
  "https://oa.example.com/bus/approve#AB2C-D3E4",
  "https://oa.example.com/bus/approve/",
  "https://oa.example.com/AB2C-D3E4/bus/approve",
];

describe("routes", () => {
  it("pins the instance routes (design: Contracts)", () => {
    expect(BUS_ROUTES.page).toBe("/bus");
    expect(BUS_ROUTES.device).toBe("/bus/device");
    expect(BUS_ROUTES.deviceToken).toBe("/bus/device/token");
    expect(BUS_ROUTES.connect).toBe("/bus/connect");
    // The approval page takes no code: the person types it there.
    expect(BUS_ROUTES.approve).toBe("/bus/approve");
  });
});

describe("device code response", () => {
  it("accepts exactly the instance's approval page, with the code apart", () => {
    expect(DeviceCodeResponseSchema.safeParse(ok).success).toBe(true);
    expect(p("http://localhost:8787/bus/approve")).toBe(true);
    expect(p("http://127.0.0.1/bus/approve")).toBe(true);
    expect(p("http://[::1]:8787/bus/approve")).toBe(true);
  });
  it("refuses a URI that carries the code, in any form", () => {
    for (const u of WITH_CODE) expect(p(u), u).toBe(false);
  });
  it("refuses a verification_uri_complete", () => {
    expect(
      DeviceCodeResponseSchema.safeParse({
        ...ok,
        verification_uri_complete:
          "https://oa.example.com/bus/approve?user_code=AB2C-D3E4",
      }).success,
    ).toBe(false);
  });
  it("rejects unsafe or wrong verification URIs", () => {
    for (const u of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://oa.example.com/bus/approve",
      "https://oa.example.com/approve",
      "https://oa.example.com/bus/approve?x",
      "https://oa.example.com/bus/approve#x",
      "https://oa.example.com@evil.com/bus/approve",
      "https://oa/x/../bus/approve",
      "https://oa/bus/approve\u0007",
      "https://o\na/bus/approve",
      "http://localhost.evil.com/bus/approve",
      "http://[::2]/bus/approve",
      `https://${"a".repeat(3000)}/bus/approve`,
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
  it("the client accepts only its own instance's approval page", () => {
    const origin = "https://oa.example.com";
    expect(verificationUriMatches(ok.verification_uri, origin)).toBe(true);
    expect(verificationUriMatches(ok.verification_uri, `${origin}/`)).toBe(
      true,
    );
    expect(
      verificationUriMatches(ok.verification_uri, "https://evil.example.com"),
    ).toBe(false);
    expect(
      verificationUriMatches(ok.verification_uri, "http://oa.example.com"),
    ).toBe(false);
    expect(verificationUriMatches("nope", origin)).toBe(false);
    for (const u of WITH_CODE)
      expect(verificationUriMatches(u, origin), u).toBe(false);
    for (const u of [
      "https://oa.example.com/bus",
      "https://oa.example.com/bus/approvex",
      "https://oa.example.com:8443/bus/approve",
      "https://user@oa.example.com/bus/approve",
    ])
      expect(verificationUriMatches(u, origin), u).toBe(false);
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
