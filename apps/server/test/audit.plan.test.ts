// #2458: the audit log is Business only on hosted; self-hosted always reads.
import { env } from "cloudflare:workers";
import {
  AUDIT_NEXT_CURSOR_HEADER,
  AUDIT_WINDOW_HEADER,
  newId,
  R,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
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

const seed = async (id: string, ageDays: number) => {
  await env.DB.prepare(
    "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, 'user', ?, 'space.create', 'space', ?, '{}')",
  )
    .bind(newId(), Date.now() - ageDays * DAY, owner.userId, id)
    .run();
};
/** Every target id the route reaches, walking the cursor (page of 1). */
async function reach(route: string, e?: Env): Promise<string[]> {
  const out: string[] = [];
  const list = route === R.audit;
  let cursor = "";
  for (let n = 0; n < 200; n++) {
    const q = list ? `?limit=1${cursor}` : cursor ? `?${cursor.slice(1)}` : "";
    const r = await send(props, `${route}${q}`, owner.cookie, e ? { e } : {});
    expect(r.status).toBe(200);
    let next: string | null;
    if (list) {
      const b = (await r.json()) as {
        items: { target: { id: string } }[];
        nextCursor: string | null;
      };
      out.push(...b.items.map((x) => x.target.id));
      next = b.nextCursor;
    } else {
      out.push(
        ...(await r.text())
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { target: { id: string } }).target.id),
      );
      next = r.headers.get(AUDIT_NEXT_CURSOR_HEADER);
    }
    if (!next) break;
    cursor = `&cursor=${next}`;
  }
  return out;
}

describe("hosted audit log plan rule", () => {
  beforeAll(async () => {
    await seed(`new-${tag}`, 29);
    await seed(`old-${tag}`, 31);
  });

  it.each([
    ["solo", { tier: "solo", trialEndsAt: mid + DAY }],
    ["free", { tier: "free", trialEndsAt: 1 }],
  ] as [string, Partial<BillingRow>][])(
    "%s: 403 plan_required naming business",
    async (_n, r) => {
      await clearBilling();
      await cachePlan({ ...row(r), version: 2 }, mid);
      for (const route of [R.audit, R.auditExport]) {
        const res = await send(props, route, owner.cookie);
        expect(res.status).toBe(403);
        const e = await errOf(res);
        expect(e.code).toBe("plan_required");
        expect(e.details).toMatchObject({ requires: "business" });
      }
    },
  );

  it.each([
    ["team", { tier: "team" }],
    ["team trial", { tier: "trial", trialEndsAt: mid + DAY }],
    ["lapsed team", { tier: "team", status: "lapsed" }],
  ] as [string, Partial<BillingRow>][])(
    "%s: the last 30 days only, on both routes, through the cursor",
    async (_n, r) => {
      await clearBilling();
      await cachePlan({ ...row(r), version: 4 }, mid);
      for (const route of [R.audit, R.auditExport]) {
        const ids = await reach(route);
        expect(ids).toContain(`new-${tag}`);
        expect(ids).not.toContain(`old-${tag}`);
        const res = await send(props, route, owner.cookie);
        expect(res.headers.get(AUDIT_WINDOW_HEADER)).toBe("30");
        await res.arrayBuffer();
      }
    },
  );

  it("business (also lapsed): all of it, no window header", async () => {
    for (const r of [row({}), row({ status: "lapsed" })]) {
      await clearBilling();
      await cachePlan({ ...r, version: 3 }, mid);
      for (const route of [R.audit, R.auditExport]) {
        const ids = await reach(route);
        expect(ids).toContain(`new-${tag}`);
        expect(ids).toContain(`old-${tag}`);
        const res = await send(props, route, owner.cookie);
        expect(res.headers.get(AUDIT_WINDOW_HEADER)).toBeNull();
        await res.arrayBuffer();
      }
    }
  });
});

describe("the audit.export row counts only what the plan exported", () => {
  const exported = async () => {
    const seen = new Set(
      (
        await env.DB.prepare(
          "select id from audit_events where action = 'audit.export'",
        ).all<{ id: string }>()
      ).results.map((r) => r.id),
    );
    const res = await send(props, R.auditExport, owner.cookie);
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter(Boolean).length;
    // The clock is pinned, so pick the new row by id, not by time.
    const made = (
      await env.DB.prepare(
        "select id, detail from audit_events where action = 'audit.export'",
      ).all<{ id: string; detail: string }>()
    ).results.filter((r) => !seen.has(r.id));
    expect(made).toHaveLength(1);
    return {
      lines,
      rows: (JSON.parse(made[0]?.detail ?? "{}") as { rows: number }).rows,
    };
  };
  it("Team's count excludes the rows past 30 days; Business's includes them", async () => {
    await seed(`old2-${tag}`, 31);
    await clearBilling();
    await cachePlan({ ...row({ tier: "team" }), version: 6 }, mid);
    const team = await exported();
    // The export reads its own row too (newest): lines = rows + 1.
    expect(team.lines).toBe(team.rows + 1);
    await clearBilling();
    await cachePlan({ ...row({}), version: 7 }, mid);
    const biz = await exported();
    expect(biz.lines).toBe(biz.rows + 1);
    // Business sees the 31-day rows (two seeded) plus Team's export row.
    expect(biz.rows - team.rows).toBeGreaterThanOrEqual(3);
  });
});

describe("self-hosted", () => {
  it("always reads the audit log", async () => {
    for (const route of [R.audit, R.auditExport]) {
      const ids = await reach(route, env as unknown as Env);
      expect(ids).toContain(`old-${tag}`);
    }
  });
});
