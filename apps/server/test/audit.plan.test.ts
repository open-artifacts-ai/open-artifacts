// #2458: the audit log is Business only on hosted; self-hosted always reads.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  send,
} from "./billing-helpers.js";
import { errOf, login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const { props } = fakeBilling();
let owner: { cookie: string; userId: string };
let mid: number;

const row = (r: Partial<BillingRow>): BillingRow => ({
  tier: "business",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  version: 1,
  ...r,
});

beforeAll(async () => {
  mid = pinMiddayUtc();
  owner = await login(`audit-plan-${tag}@a.com`, "owner");
});
afterAll(clearBilling);

describe("hosted audit log plan rule", () => {
  const refused: [string, Partial<BillingRow>][] = [
    ["team", { tier: "team" }],
    ["trial", { tier: "trial", trialEndsAt: mid + DAY }],
    ["solo", { tier: "solo", trialEndsAt: mid + DAY }],
    ["free", { tier: "free", trialEndsAt: 1 }],
  ];
  it.each(refused)("%s: 403 plan_required naming business", async (_n, r) => {
    await clearBilling();
    await cachePlan({ ...row(r), version: 2 }, mid);
    for (const route of [R.audit, R.auditExport]) {
      const res = await send(props, route, owner.cookie);
      expect(res.status).toBe(403);
      const e = await errOf(res);
      expect(e.code).toBe("plan_required");
      expect(e.details).toMatchObject({ requires: "business" });
    }
  });

  it("business: allowed, also while lapsed (read-only)", async () => {
    for (const r of [row({}), row({ status: "lapsed" })]) {
      await clearBilling();
      await cachePlan({ ...r, version: 3 }, mid);
      for (const route of [R.audit, R.auditExport])
        expect((await send(props, route, owner.cookie)).status).toBe(200);
    }
  });
});

describe("self-hosted", () => {
  it("always reads the audit log", async () => {
    for (const route of [R.audit, R.auditExport])
      expect((await send(props, route, owner.cookie, { e: env })).status).toBe(
        200,
      );
  });
});
