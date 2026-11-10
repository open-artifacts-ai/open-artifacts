// #1608: a pi-like agent_ref belongs to the first link that claimed it.
import { afterEach, describe, expect, it } from "vitest";
import { REF_BOUND } from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

describe.each(["pi", "omp", "hermes", "openclaw"] as const)(
  "ref binding for %s",
  (kind) => {
    it("refuses a second concurrent claim with the fixed code", async () => {
      const h = await daemonHarness();
      await h.adapter("A", { kind });
      await expect(h.adapter("A", { kind })).rejects.toThrow(REF_BOUND);
    });

    it("lets the ref reconnect once the first link closed", async () => {
      const h = await daemonHarness();
      const a = await h.adapter("A", { kind });
      a.close();
      await h.next("sessions", 2);
      await expect(h.adapter("A", { kind })).resolves.toBeDefined();
    });

    it("leaves other refs alone", async () => {
      const h = await daemonHarness();
      await h.adapter("A", { kind });
      await expect(h.adapter("B", { kind })).resolves.toBeDefined();
    });
  },
);

it("refuses a different kind claiming a bound ref", async () => {
  const h = await daemonHarness();
  await h.adapter("A", { kind: "pi" });
  await expect(h.adapter("A", { kind: "omp" })).rejects.toThrow();
});
