import { describe, expect, it } from "vitest";
import { isReleasedAddress } from "../src/index.js";

describe("isReleasedAddress", () => {
  it("matches the address directory sync releases to", () => {
    expect(isReleasedAddress("removed+Pl7tNpQrSt8uVwXy@invalid")).toBe(true);
  });
  it.each([
    "removed+pat@example.com",
    "removed@invalid",
    "xremoved+abc@invalid",
    "removed+abc@invalid.example",
    "pat@example.com",
    "",
    null,
    undefined,
  ])("leaves %s alone", (email) => {
    expect(isReleasedAddress(email)).toBe(false);
  });
});
