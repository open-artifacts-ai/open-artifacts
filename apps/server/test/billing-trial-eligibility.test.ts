// #1851: who the billing tick's trial retry counts, and when trialEligible
// holds. A guest (code sign-in) never starts the Business trial; a past_due
// Solo in grace is not eligible, because billing starts a trial only from
// active.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { effectivePlan, type StoredPlan } from "../src/billing/plan.js";
import { billingTick } from "../src/billing/store.js";
import {
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { login } from "./helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const { s: fake, props } = fakeBilling();
const SOLO = {
  tier: "solo",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  version: 1,
} as const;
let owner: { cookie: string; userId: string };
let seq = 0;
const trialStarts = () =>
  fake.calls.filter((c) => c.path === "/trial/start").length;
const tick = () => withBrokerProps({ props }, () => billingTick(H, Date.now()));
const setStatus = (id: string, status: string) =>
  env.DB.prepare("update users set status = ? where id = ?")
    .bind(status, id)
    .run();

beforeAll(async () => {
  owner = await login(`owner-${tag}@a.com`, "owner");
});
beforeEach(async () => {
  fake.row = { ...SOLO };
  fake.calls = [];
  fake.down = false;
  await clearBilling();
  await env.DB.prepare("delete from users where role != 'owner'").run();
  await cachePlan(SOLO);
});

const errCode = async (r: Response) =>
  ((await r.json()) as { error: { code: string } }).error.code;

describe("the tick never starts the Business trial", () => {
  it("posts no /trial/start for a guest", async () => {
    await login(`g${++seq}-${tag}@a.com`, "guest");
    await tick();
    expect(trialStarts()).toBe(0);
  });

  it("posts none for a guest promoted to member (Google login) or for a domain-joined member or admin", async () => {
    const g = await login(`p${++seq}-${tag}@a.com`, "guest");
    await env.DB.prepare("update users set role = 'member' where id = ?")
      .bind(g.userId)
      .run();
    await login(`d${++seq}-${tag}@a.com`, "member");
    await login(`a${++seq}-${tag}@a.com`, "admin");
    await tick();
    expect(trialStarts()).toBe(0);
  });

  it("an invite starts the trial once; a later tick adds no second start", async () => {
    const r = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv${++seq}-${tag}@a.com`, role: "member" },
    });
    expect(r.status).toBe(201);
    expect(trialStarts()).toBe(1);
    await tick();
    expect(trialStarts()).toBe(1);
  });

  it("a restore starts the trial; the tick posts nothing before it", async () => {
    const m = await login(`r${++seq}-${tag}@a.com`, "member");
    await setStatus(m.userId, "removed");
    await tick();
    expect(trialStarts()).toBe(0);
    const r = await send(props, R.memberRestore(m.userId), owner.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    expect(trialStarts()).toBe(1);
  });
});

describe("trialEligible needs status active", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const at = (r: Partial<StoredPlan>): StoredPlan => ({
    ...SOLO,
    asOf: now,
    ...r,
  });

  it("a past_due Solo in grace keeps the solo lock but is not eligible", () => {
    const p = effectivePlan(
      at({ status: "past_due", graceUntil: now + DAY }),
      null,
      undefined,
      now,
    );
    expect(p.lock?.mode).toBe("solo");
    expect(p.trialEligible).toBe(false);
    expect(effectivePlan(at({}), null, undefined, now).trialEligible).toBe(
      true,
    );
  });

  it("under a past_due Solo in grace, an invite and a restore answer plan_required and no trial starts", async () => {
    const now = Date.now();
    await clearBilling();
    await cachePlan(
      { ...SOLO, status: "past_due", graceUntil: now + DAY, version: 2 },
      now,
    );
    await login(`pd${++seq}-${tag}@a.com`, "member");
    await tick();
    const inv = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `pdinv-${tag}@a.com`, role: "member" },
    });
    expect(inv.status).toBe(403);
    expect(await errCode(inv)).toBe("plan_required");
    const gone = await login(`pdgone-${tag}@a.com`, "member");
    await setStatus(gone.userId, "removed");
    const res = await send(props, R.memberRestore(gone.userId), owner.cookie, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("plan_required");
    expect(trialStarts()).toBe(0);
  });
});
