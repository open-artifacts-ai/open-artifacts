// #1608: a pi-like agent_ref belongs to the adapter that claimed it first,
// across reconnects, until that adapter's process is gone.
import { afterEach, describe, expect, it } from "vitest";
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
