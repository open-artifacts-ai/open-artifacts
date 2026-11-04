// The daemon dials one Open Artifacts instance (design: Contracts, Local client to instance).
import { afterEach, describe, expect, it } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

describe("the instance link", () => {
  it("upgrades at /bus/connect on the instance origin, with the machine token as Bearer", async () => {
    const h = await daemonHarness();
    expect(h.upgrades[0]).toEqual({
      path: "/bus/connect",
      auth: "Bearer oa_machine_SECRETSECRETSECRET",
    });
  });
});
