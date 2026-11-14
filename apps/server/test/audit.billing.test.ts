import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredPlan } from "../src/billing/plan.js";
import { storePlan } from "../src/billing/store.js";
import type { Env } from "../src/env.js";
import { DAY, H } from "./billing-helpers.js";

// #2458: a stored billing answer that moves the plan is audited in the same
// batch as the store: ids and enums only, actor system.

type Row = {
  action: string;
  actor_kind: string;
  target_type: string;
  target_id: string;
  detail: string;
};
const rows = async () =>
  (
    await env.DB.prepare(
      "select action, actor_kind, target_type, target_id, detail from audit_events where action like 'plan.%' order by action, detail",
    ).all<Row>()
  ).results;

const t0 = 1_800_000_000_000;
const answer = (o: Partial<StoredPlan> & { version: number }): StoredPlan => ({
  tier: "solo",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  asOf: t0 + o.version,
  ...o,
});
const put = (a: StoredPlan, e: Env = H) => storePlan(e, a, a.asOf);

beforeEach(async () => {
  await env.DB.prepare("delete from settings where key like 'billing.%'").run();
  await env.DB.prepare(
    "delete from audit_events where action like 'plan.%'",
  ).run();
});

describe("billing audit rows (#2458)", () => {
  it("plan.change on a tier move, with the interval; not on a same-tier answer", async () => {
    await put(answer({ version: 1, tier: "team", interval: "year" }));
    await put(answer({ version: 2, tier: "team", interval: "year" }));
    const r = await rows();
    expect(r.map((x) => x.action)).toEqual(["plan.change"]);
    expect(r[0]).toMatchObject({
      actor_kind: "system",
      target_type: "settings",
      target_id: "billing",
    });
    expect(JSON.parse(r[0]?.detail ?? "{}")).toEqual({
      from: "solo",
      to: "team",
      interval: "year",
    });
  });

  it("trial start and trial end back to Solo are plan.change", async () => {
    await put(answer({ version: 1, tier: "trial", trialEndsAt: t0 + DAY }));
    // Past the trial's date, billing answers solo: still a move from trial.
    await storePlan(
      H,
      answer({ version: 2, tier: "solo", trialEndsAt: t0 + DAY }),
      t0 + 3 * DAY,
    );
    const r = (await rows()).map((x) => JSON.parse(x.detail));
    expect(r).toEqual([
      { from: "solo", to: "trial" },
      { from: "trial", to: "solo" },
    ]);
  });

  it("plan.payment_failed once, on entering past_due", async () => {
    await put(answer({ version: 1, tier: "team" }));
    await put(
      answer({
        version: 2,
        tier: "team",
        status: "past_due",
        graceUntil: t0 + DAY,
      }),
    );
    await put(
      answer({
        version: 3,
        tier: "team",
        status: "past_due",
        graceUntil: t0 + DAY,
      }),
    );
    expect((await rows()).map((x) => x.action)).toEqual([
      "plan.change",
      "plan.payment_failed",
    ]);
  });

  it("plan.lapse when the status becomes lapsed", async () => {
    await put(answer({ version: 1, tier: "team" }));
    await put(answer({ version: 2, tier: "team", status: "lapsed" }));
    expect((await rows()).map((x) => x.action)).toEqual([
      "plan.change",
      "plan.lapse",
    ]);
  });

  it("plan.cancel when a scheduled cancel newly appears, not when it stays", async () => {
    await put(answer({ version: 1, tier: "team", cancelsAt: null }));
    await put(answer({ version: 2, tier: "team", cancelsAt: t0 + 5 * DAY }));
    await put(answer({ version: 3, tier: "team", cancelsAt: t0 + 5 * DAY }));
    expect((await rows()).map((x) => x.action)).toEqual([
      "plan.cancel",
      "plan.change",
    ]);
  });

  it("an unapplied (older) answer writes no row", async () => {
    await put(answer({ version: 5, tier: "team" }));
    await env.DB.prepare(
      "delete from audit_events where action like 'plan.%'",
    ).run();
    expect(
      await put(answer({ version: 4, tier: "business", asOf: t0 + 99 })),
    ).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("the first answer writes no row when the tier matches the provisioned TIER", async () => {
    const team = { ...H, TIER: "team" } as Env;
    await put(answer({ version: 0, tier: "solo" }), team);
    await put(answer({ version: 1, tier: "team" }), team);
    expect(await rows()).toEqual([]);
  });

  it("stores ids and enums only: no address, customer or subscription id", async () => {
    await put(
      answer({
        version: 1,
        tier: "team",
        interval: "month",
        cancelsAt: t0 + DAY,
        hasCustomer: true,
      }),
    );
    await put(
      answer({
        version: 2,
        tier: "team",
        status: "past_due",
        graceUntil: t0 + DAY,
      }),
    );
    const all = JSON.stringify(await rows());
    expect(all).not.toMatch(/@|cus_|sub_/);
    expect(all).not.toMatch(/amount|cents/i);
  });
});
