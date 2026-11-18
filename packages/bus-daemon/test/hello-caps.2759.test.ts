import { MAX_CAPS } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { HUB_HELLO_CAPS } from "../src/hub.ts";

describe("daemon hello caps (#2759)", () => {
  it("stay within 16, the limit released hubs decode hello.caps with", () => {
    // MAX_CAPS rose to 32, but an older hub refuses a hello listing more than 16.
    expect(HUB_HELLO_CAPS.length).toBeLessThanOrEqual(16);
    expect(HUB_HELLO_CAPS.length).toBeLessThanOrEqual(MAX_CAPS);
    expect(new Set(HUB_HELLO_CAPS).size).toBe(HUB_HELLO_CAPS.length);
  });
});
