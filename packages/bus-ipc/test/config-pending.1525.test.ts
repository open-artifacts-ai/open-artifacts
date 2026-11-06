// #1525: the `pending` config-file state, and how an older strict decoder fares.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ADAPTER_CAPS, ConfigFile, StatusRequest } from "../src/frames.ts";

const pending = {
  file: "/x/.oa-bus.json",
  state: "pending",
  reason: 'sets namespace "team", which you have not approved',
  fix: "oa-bus namespace approve '/x'",
};

describe("pending config files", () => {
  it("decodes", () => {
    expect(ConfigFile.safeParse(pending).success).toBe(true);
  });

  it("an older strict decoder rejects it: the daemon must gate it on the cap", () => {
    const Old = z.object({
      file: z.string(),
      state: z.enum(["refused", "noted"]),
      reason: z.string(),
      fix: z.string(),
    });
    expect(Old.safeParse(pending).success).toBe(false);
    expect(ADAPTER_CAPS.pending).toBe("pending");
  });

  it("a status request carries caps; an older one without caps still parses", () => {
    const base = { v: 1, id: "s", type: "status" };
    expect(StatusRequest.parse({ ...base, caps: ["pending"] }).caps).toEqual([
      "pending",
    ]);
    expect(StatusRequest.safeParse(base).success).toBe(true);
  });
});
