// The owner's quiet hours (#2759): hello_ok and owner_away set it; status and
// self report it while it lasts.
import { daemonStatus } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_HELLO_CAPS } from "../src/hub.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const FUTURE = "2999-01-01T07:00:00Z";
const LATER = "2999-02-01T07:00:00Z";
const PAST = "2000-01-01T07:00:00Z";

type H = Awaited<ReturnType<typeof daemonHarness>>;
const hello = (h: H, extra: Record<string, unknown> = {}) =>
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "0.106.0",
    ...extra,
  });
const away = async (h: H) =>
  (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 }))
    .owner_away_until;
/** Status after the daemon has read every frame sent so far. */
const settled = async (h: H, want: string | undefined) =>
  vi.waitFor(async () => expect(await away(h)).toBe(want));

describe("owner away", () => {
  it("the daemon lists the cap, within the 16 an older hub takes", () => {
    expect(HUB_HELLO_CAPS).toContain("owner_away");
    expect(HUB_HELLO_CAPS.length).toBeLessThanOrEqual(16);
  });

  it("hello_ok sets it, a frame updates it, null clears it", async () => {
    const h = await daemonHarness({ statusRosterMs: 10 });
    hello(h, { owner_away_until: FUTURE });
    await settled(h, FUTURE);
    h.toDaemon({ id: "o1", type: "owner_away", until: LATER });
    await settled(h, LATER);
    h.toDaemon({ id: "o2", type: "owner_away", until: null });
    await settled(h, undefined);
  });

  it("a reconnect's hello_ok replaces it; no field means not away", async () => {
    const h = await daemonHarness({ statusRosterMs: 10 });
    hello(h, { owner_away_until: FUTURE });
    await settled(h, FUTURE);
    hello(h, { owner_away_until: LATER });
    await settled(h, LATER);
    hello(h);
    await settled(h, undefined);
    hello(h, { owner_away_until: FUTURE });
    await settled(h, FUTURE);
    hello(h, { owner_away_until: null });
    await settled(h, undefined);
  });

  it("a time already past is not away", async () => {
    const h = await daemonHarness({ statusRosterMs: 10 });
    hello(h, { owner_away_until: PAST });
    await vi.waitFor(async () =>
      expect(
        (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 }))
          .hub_version,
      ).toBe("0.106.0"),
    );
    expect(await away(h)).toBeUndefined();
    h.toDaemon({ id: "o1", type: "owner_away", until: PAST });
    expect(await away(h)).toBeUndefined();
  });

  it("self carries it to the owner's own agent, only while it lasts", async () => {
    const h = await daemonHarness({ statusRosterMs: 10 });
    hello(h, { owner_away_until: FUTURE });
    await settled(h, FUTURE);
    const a = await h.adapter("A", {});
    const r = await a.request({ type: "self" });
    expect(r.type === "agent" && r.agent?.owner_away_until).toBe(FUTURE);
    h.toDaemon({ id: "o2", type: "owner_away", until: null });
    await settled(h, undefined);
    const r2 = await a.request({ type: "self" });
    expect(r2.type === "agent" && r2.agent?.owner_away_until).toBeUndefined();
  });
});
