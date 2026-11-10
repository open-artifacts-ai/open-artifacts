// #1608: a pi-like agent_ref belongs to the adapter that claimed it first,
// across reconnects, until that adapter's process is gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { REF_BOUND } from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

describe.each(["pi", "omp", "hermes", "openclaw"] as const)(
  "ref binding for %s",
  (kind) => {
    it("issues a token and refuses a second claim without it", async () => {
      const h = await daemonHarness();
      const a = await h.adapter("A", { kind });
      expect(typeof a.welcome.bind_token).toBe("string");
      await expect(
        h.adapter("A", { kind, bind_token: undefined }),
      ).rejects.toThrow(REF_BOUND);
    });

    it("refuses a wrong token", async () => {
      const h = await daemonHarness();
      await h.adapter("A", { kind });
      await expect(
        h.adapter("A", { kind, bind_token: "x".repeat(32) }),
      ).rejects.toThrow(REF_BOUND);
    });

    it("lets the first claimant reconnect after its link closed", async () => {
      const h = await daemonHarness();
      const a = await h.adapter("A", { kind });
      const bind_token = a.welcome.bind_token;
      a.close();
      await h.next("sessions", 2);
      const b = await h.adapter("A", { kind, bind_token });
      expect(b.welcome.bind_token).toBe(bind_token);
    });

    it("refuses a squatter on a closed link: no token, same pid", async () => {
      const h = await daemonHarness();
      const a = await h.adapter("A", { kind });
      a.close();
      await h.next("sessions", 2);
      await expect(
        h.adapter("A", { kind, bind_token: undefined }),
      ).rejects.toThrow(REF_BOUND);
    });

    it("lets the token holder replace a link that is still half-open", async () => {
      const h = await daemonHarness();
      const a = await h.adapter("A", { kind });
      await expect(
        h.adapter("A", { kind, bind_token: a.welcome.bind_token }),
      ).resolves.toBeDefined();
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
  await expect(
    h.adapter("A", { kind: "omp", bind_token: undefined }),
  ).rejects.toThrow(REF_BOUND);
});

it("frees the ref once the claimant's process is gone", async () => {
  let alive = true;
  const h = await daemonHarness({ claude: { isRunning: () => alive } });
  const a = await h.adapter("A", { kind: "pi" });
  a.close();
  await h.next("sessions", 2);
  await expect(
    h.adapter("A", { kind: "pi", bind_token: undefined }),
  ).rejects.toThrow(REF_BOUND);
  alive = false;
  await expect(
    h.adapter("A", { kind: "pi", bind_token: undefined }),
  ).resolves.toBeDefined();
});

it.each(["claude-code", "opencode"] as const)(
  "refuses a %s hello on a bound pi ref",
  async (kind) => {
    const h = await daemonHarness();
    const a = await h.adapter("A", { kind: "pi" });
    a.close();
    await h.next("sessions", 2);
    await expect(h.adapter("A", { kind })).rejects.toThrow(REF_BOUND);
    await expect(
      h.adapter("A", { kind: "pi", bind_token: a.welcome.bind_token }),
    ).resolves.toBeDefined();
  },
);

it("frees the ref when the claimant's pid is reused by another process", async () => {
  let start = "Mon Nov  9 10:00:00 2026";
  const h = await daemonHarness({
    claude: { isRunning: () => true, procStart: () => start },
  });
  const a = await h.adapter("A", { kind: "pi" });
  a.close();
  await h.next("sessions", 2);
  await expect(
    h.adapter("A", { kind: "pi", bind_token: undefined }),
  ).rejects.toThrow(REF_BOUND);
  start = "Tue Nov 10 09:00:00 2026";
  await expect(
    h.adapter("A", { kind: "pi", bind_token: undefined }),
  ).resolves.toBeDefined();
});

// #1956: bindings lapse after BINDING_IDLE_MS closed, and the map is swept.
describe("binding expiry (#1956)", () => {
  const HOUR = 60 * 60_000;
  const harness = (state: { t: number; alive: boolean }) =>
    daemonHarness({
      bindingNow: () => state.t,
      claude: {
        isRunning: () => state.alive,
        procStart: () => null,
        syncMs: 10,
      },
    });
  const squat = (h: Awaited<ReturnType<typeof daemonHarness>>) =>
    h.adapter("A", { kind: "pi", bind_token: undefined });

  it("never lapses while the link is open", async () => {
    const st = { t: 0, alive: true };
    const h = await harness(st);
    await h.adapter("A", { kind: "pi" });
    st.t = 1000 * HOUR;
    h.daemon.bindings.sweep();
    await expect(squat(h)).rejects.toThrow(REF_BOUND);
  });

  it("lapses a long-lived pid's closed binding after the idle window", async () => {
    const st = { t: 0, alive: true };
    const h = await harness(st);
    const a = await h.adapter("A", { kind: "pi" });
    a.close();
    await h.next("sessions", 2);
    st.t = 23 * HOUR;
    await expect(squat(h)).rejects.toThrow(REF_BOUND);
    st.t = 25 * HOUR;
    await expect(squat(h)).resolves.toBeDefined();
  });

  it("sweeps dead and idle bindings with no hello, and keeps an open one", async () => {
    const st = { t: 0, alive: true };
    const h = await harness(st);
    await h.adapter("open", { kind: "pi" });
    const idle = await h.adapter("idle", { kind: "pi" });
    idle.close();
    await h.next("sessions", 2);
    expect(h.daemon.bindings.count()).toBe(2);
    st.t = 25 * HOUR;
    h.daemon.bindings.sweep();
    expect(h.daemon.bindings.count()).toBe(1);
    const dead = await h.adapter("dead", { kind: "pi" });
    dead.close();
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("dead")?.live).toBe(false),
    );
    expect(h.daemon.bindings.count()).toBe(2);
    st.alive = false;
    st.t += 2 * 60_000;
    h.daemon.bindings.sweep();
    // The open link stays bound even with its pid gone.
    expect(h.daemon.bindings.count()).toBe(1);
  });

  it("sweeps without a fresh procStart read per run", async () => {
    const st = { t: 0, alive: true };
    const procStart = vi.fn(() => "Mon Nov  9 10:00:00 2026");
    const h = await daemonHarness({
      bindingNow: () => st.t,
      claude: { isRunning: () => st.alive, procStart, syncMs: 10 },
    });
    const a = await h.adapter("A", { kind: "pi" });
    a.close();
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("A")?.live).toBe(false),
    );
    st.t = HOUR;
    h.daemon.bindings.sweep();
    const calls = procStart.mock.calls.length;
    for (let i = 2; i < 6; i++) {
      st.t = i * 2 * 60_000 + HOUR;
      h.daemon.bindings.sweep();
    }
    expect(procStart.mock.calls.length).toBe(calls);
    expect(h.daemon.bindings.count()).toBe(1);
  });
});
