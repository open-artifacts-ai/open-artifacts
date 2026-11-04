// Ported from OpenBus v0.63.0 apps/server/test/hub.unaccepted.test.ts (#1291).
// Dropped: nothing.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BusHub } from "../../src/bus/hub.js";
import { e } from "./helpers.js";

type BusHubStub = DurableObjectStub<BusHub>;
const busNs = () => e.BUS_HUB as DurableObjectNamespace<BusHub>;
const freshHub = (): BusHubStub => busNs().get(busNs().newUniqueId());

// A close or error event for a socket this DO never accepted (getTags throws)
// has nothing to clean up and must not throw out of the handler.
describe("socket events for a socket the hub never accepted", () => {
  for (const event of ["webSocketClose", "webSocketError"] as const)
    it(`${event} returns quietly`, async () => {
      const h = freshHub();
      await runInDurableObject(
        h as unknown as DurableObjectStub<BusHub>,
        async (i: BusHub) => {
          const [, server] = Object.values(new WebSocketPair());
          const run =
            event === "webSocketClose"
              ? i.webSocketClose(server, 1000)
              : i.webSocketError(server, new Error("x"));
          await expect(run).resolves.toBeUndefined();
        },
      );
    });
});
