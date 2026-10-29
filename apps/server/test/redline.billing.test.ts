// Red lines for self-serve billing, in-server: an install only ever speaks
// for itself to billing (its own id, its own key), billing being unreachable
// never unlocks anything (the last good tier for 7 days, then read-only),
// a real lapse applies at once, HOSTED=1 only tightens, and the billing logs
// carry fixed categories only. Each case first proves the good path works,
// so a server that refuses everything can't pass.
import { env } from "cloudflare:workers";
import { newId, PLAN_STALE_MS, R } from "@oa/shared";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { readPlan } from "../src/billing/plan.js";
import { refreshPlan, startTrial } from "../src/billing/store.js";
import type { Env } from "../src/env.js";
import {
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
/** Another install's broker key (valid Ed25519 PKCS#8, not this install's). */
const OTHER_KEY =
  "MC4CAQAwBQYDK2VwBCIEIB8eHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA";

let owner: { cookie: string; userId: string };
let mid: number;
beforeAll(async () => {
  owner = await login(`rl-owner-${tag}@a.com`, "owner");
});
beforeEach(async () => {
  mid = pinMiddayUtc();
  await clearBilling();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await clearBilling();
});

const FREE = {
  tier: "free",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  version: 0,
} as const;

describe("red line: an install speaks to billing only for itself", () => {
  it("the trial start carries this install's id and key; a gate for another install refuses it and nothing changes", async () => {
    const mine = fakeBilling();
    mine.s.row = { ...FREE };
    await cachePlan(mine.s.row);
    expect(
      await withBrokerProps({ props: mine.props }, () => startTrial(H, mid)),
    ).toBe(true);
    expect((await readPlan(H, mid))?.tier).toBe("trial");
    // The same request to a gate stamped with another install: refused.
    await clearBilling();
    const other = fakeBilling("iotherinst001");
    other.s.row = { ...FREE };
    await cachePlan(other.s.row);
    expect(
      await withBrokerProps({ props: other.props }, () => startTrial(H, mid)),
    ).toBe(false);
    expect(other.s.calls.map((c) => c.status)).toEqual([403]);
    expect(other.s.row.tier).toBe("free");
    expect((await readPlan(H, mid))?.tier).toBe("free");
  });

  it("another install's key never verifies: 401, no trial, no usage written", async () => {
    const b = fakeBilling();
    b.s.row = { ...FREE };
    await cachePlan(b.s.row);
    const forged = { ...H, BROKER_SIGNING_KEY: OTHER_KEY } as Env;
    expect(
      await withBrokerProps({ props: b.props }, () => startTrial(forged, mid)),
    ).toBe(false);
    expect(b.s.calls.map((c) => [c.path, c.status])).toEqual([
      ["/trial/start", 401],
    ]);
    expect(b.s.row.tier).toBe("free");
    const r = await send(b.props, R.billingUsage, owner.cookie, {
      method: "POST",
      body: {},
      e: forged,
    });
    expect(r.status).toBe(503);
  });
});

describe("red line: billing unreachable never unlocks", () => {
  it("free stays solo while billing is down, then read-only after 7 days; never paid", async () => {
    const b = fakeBilling();
    await cachePlan({ ...FREE, trialEndsAt: mid - DAY, version: 1 }, mid);
    b.s.down = true;
    for (const t of [mid + DAY, mid + PLAN_STALE_MS]) {
      vi.setSystemTime(t);
      expect(
        await withBrokerProps({ props: b.props }, () => refreshPlan(H, t)),
      ).toBe("failed");
      expect((await readPlan(H, t))?.lock).toMatchObject({ mode: "solo" });
    }
    const after = mid + PLAN_STALE_MS + 1;
    vi.setSystemTime(after);
    expect((await readPlan(H, after))?.lock).toEqual({
      mode: "readOnly",
      tier: "free",
      reason: "billing_unreachable",
    });
    // A session signed now (the first one is past its lifetime).
    const fresh = await login(`rl-owner2-${tag}@a.com`, "owner");
    const r = await send(b.props, R.members, fresh.cookie, {
      method: "POST",
      body: { email: `rl-${tag}@a.com`, role: "member" },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "plan_read_only",
    );
  });

  it("a real lapse is read-only at once, and an outage after it keeps it read-only", async () => {
    const b = fakeBilling();
    await cachePlan({ ...b.s.row, version: 1 }, mid);
    expect((await readPlan(H, mid))?.lock).toBeNull();
    b.s.row = { ...b.s.row, status: "lapsed", version: 2 };
    expect(
      await withBrokerProps({ props: b.props }, () => refreshPlan(H, mid)),
    ).toBe("stored");
    expect((await readPlan(H, mid))?.readOnly).toBe(true);
    b.s.down = true;
    expect(
      await withBrokerProps({ props: b.props }, () => refreshPlan(H, mid + 1)),
    ).toBe("failed");
    expect((await readPlan(H, mid + 1))?.reason).toBe("lapsed");
  });

  it("HOSTED=1 only tightens: a self-hosted install ignores a cached lapse and calls nobody", async () => {
    const b = fakeBilling();
    await cachePlan({ ...b.s.row, status: "lapsed", version: 5 }, mid);
    const self = { ...H, HOSTED: undefined } as Env;
    expect(await readPlan(self, mid)).toBeNull();
    const r = await send(b.props, R.artifacts, owner.cookie, {
      method: "POST",
      e: self,
      body: { title: "t", format: "html", content: "<p>x</p>" },
    });
    expect(r.status).toBe(201);
    expect(b.s.calls).toEqual([]);
  });
});

describe("red line: billing logs carry fixed categories only", () => {
  it("no body, header, URL or key text reaches a log line", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(
          a
            .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
            .join(" "),
        );
      });
    const b = fakeBilling();
    b.s.row = { ...FREE };
    await cachePlan(b.s.row);
    const forged = { ...H, BROKER_SIGNING_KEY: OTHER_KEY } as Env;
    await withBrokerProps({ props: b.props }, () => startTrial(forged, mid));
    b.s.down = true;
    await withBrokerProps({ props: b.props }, () => refreshPlan(H, mid));
    await send(b.props, R.billingCheckout, owner.cookie, {
      method: "POST",
      body: { tier: "team" },
    });
    const all = lines.join("\n");
    expect(all).toContain("billing_trial_failed");
    expect(all).toContain("billing_tier_failed");
    for (const secret of [
      OTHER_KEY,
      String(H.BROKER_SIGNING_KEY),
      "billing.oa.internal",
      "x-oa-sig",
      '"install"',
    ])
      expect(all).not.toContain(secret);
  });
});
