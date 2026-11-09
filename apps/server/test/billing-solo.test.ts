// Solo plan, public half (#1568). The tier mapping (effectivePlan), and with
// the BILLING gate bound, the unpaid-Solo view-only lock: it binds everyone,
// the org owner included, and pauses publishing and live-data writes only.
// Without the gate there is no plan at all (as on self-host).
import { env } from "cloudflare:workers";
import { newId, PLAN_STALE_MS, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { effectivePlan, type StoredPlan } from "../src/billing/plan.js";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { login } from "./helpers.js";
import { connect, tool } from "./mcp-helpers.js";
import { pinMiddayUtc } from "./midday.js";

const mid = Date.UTC(2026, 10, 7, 12);
const at = (r: Partial<StoredPlan>): StoredPlan => ({
  tier: "solo",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  version: 1,
  asOf: mid,
  ...r,
});
const plan = (r: Partial<StoredPlan>) =>
  effectivePlan(at(r), null, undefined, mid);

describe("effectivePlan: solo", () => {
  it("active, and past_due within grace, are the solo lock (only active is trial eligible)", () => {
    for (const p of [
      plan({}),
      plan({ status: "past_due", graceUntil: mid + DAY }),
    ]) {
      expect(p.lock).toEqual({ mode: "solo", tier: "solo", reason: "solo" });
      expect(p.readOnly).toBe(false);
      expect(p.trialEligible).toBe(p.status === "active");
    }
    expect(plan({ trialEndsAt: mid - DAY }).trialEligible).toBe(false);
  });

  it("soloTrialEndsAt rides along and never touches trialEligible", () => {
    const p = plan({ soloTrialEndsAt: mid + DAY });
    expect(p.soloTrialEndsAt).toBe(mid + DAY);
    expect(p.trialEndsAt).toBeNull();
    expect(p.trialEligible).toBe(true);
    expect(plan({}).soloTrialEndsAt).toBeUndefined();
  });

  it("lapsed, and past_due after grace, are view-only: solo_unpaid", () => {
    for (const p of [
      plan({ status: "lapsed" }),
      plan({ status: "past_due", graceUntil: mid - 1 }),
    ]) {
      expect(p.lock).toEqual({
        mode: "viewOnly",
        tier: "solo",
        reason: "solo_unpaid",
      });
      expect(p.readOnly).toBe(true);
      expect(p.trialEligible).toBe(false);
    }
  });

  it("tier free is the pre-Solo tier: today's rules, never view-only", () => {
    const p = plan({ tier: "free", status: "active" });
    expect(p.lock).toEqual({ mode: "solo", tier: "free", reason: "solo" });
    expect(plan({ tier: "free", status: "active" }).trialEligible).toBe(true);
    expect(
      plan({ tier: "free", status: "active", trialEndsAt: 1 }).trialEligible,
    ).toBe(false);
    expect(plan({ tier: "free", status: "lapsed" }).lock).toMatchObject({
      mode: "readOnly",
      reason: "lapsed",
    });
    expect(plan({ tier: "free", status: "suspended" }).lock).toMatchObject({
      mode: "readOnly",
      reason: "suspended",
    });
  });

  it("suspended and billing_unreachable stay read-only; no answer is solo", () => {
    expect(plan({ status: "suspended" }).lock).toMatchObject({
      mode: "readOnly",
      reason: "suspended",
    });
    expect(
      effectivePlan(at({ asOf: mid - PLAN_STALE_MS - 1 }), null, undefined, mid)
        .lock,
    ).toMatchObject({ mode: "readOnly", reason: "billing_unreachable" });
    expect(effectivePlan(null, null, undefined, mid).lock).toMatchObject({
      mode: "solo",
    });
  });

  it("team and business rules are unchanged", () => {
    expect(plan({ tier: "team", status: "lapsed" }).lock).toMatchObject({
      mode: "readOnly",
      reason: "lapsed",
    });
    expect(plan({ tier: "business" }).lock).toBeNull();
  });
});

const tag = newId().slice(0, 6).toLowerCase();
const { s: fake, props } = fakeBilling();
let seq = 0;
const uniq = () => `${tag}${++seq}`;
const html = { format: "html", content: "<p>x</p>" };
const base = { trialEndsAt: 1, graceUntil: null, version: 1 };
const UNPAID: BillingRow = { ...base, tier: "solo", status: "lapsed" };
const SOLO: BillingRow = { ...base, tier: "solo", status: "active" };

type U = { cookie: string; userId: string };
let owner: U;
let member: U;
let t0 = 0;

const post = (u: U, body: Record<string, unknown> = {}) =>
  send(props, R.artifacts, u.cookie, {
    method: "POST",
    body: { title: `t ${uniq()}`, ...html, ...body },
  });
const errCode = async (r: Response) =>
  ((await r.json()) as { error?: { code: string; details?: unknown } }).error;

async function setPlan(row: BillingRow | null) {
  await clearBilling();
  if (row) await cachePlan({ ...row, version: 2 }, t0);
}

beforeAll(async () => {
  t0 = pinMiddayUtc();
  owner = await login(`owner-${tag}@a.com`, "owner");
  member = await login(`member-${tag}@a.com`, "member");
});
afterAll(async () => {
  vi.useRealTimers();
  await clearBilling();
});

describe.each([
  ["the org owner", () => owner],
  ["a member", () => member],
])("view-only (solo_unpaid): %s", (_n, who) => {
  const pool = { id: "", data: "" };
  beforeAll(async () => {
    await setPlan({ ...base, tier: "business", status: "active" });
    const u = who();
    const a = await post(u);
    pool.id = ((await a.json()) as { id: string }).id;
    const d = await post(u, { capabilities: { db: true } });
    pool.data = ((await d.json()) as { id: string }).id;
    await setPlan(UNPAID);
  });

  it("publishing is refused with 403 and the plan error: new artifact, new version", async () => {
    const u = who();
    const c = await post(u);
    expect(c.status).toBe(403);
    expect(await errCode(c)).toMatchObject({
      code: "plan_read_only",
      details: { tier: "solo", reason: "solo_unpaid" },
    });
    const v = await send(props, R.artifacts, u.cookie, {
      method: "POST",
      body: { id: pool.id, title: "v2", ...html },
    });
    expect(v.status).toBe(403);
    expect((await errCode(v))?.code).toBe("plan_read_only");
    const p = await send(props, R.artifact(pool.id), u.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(p.status).toBe(403);
  });

  it("MCP publish_artifact is refused too", async () => {
    const u = who();
    const { token } = await createPat(env, u.userId, `v ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const r = await tool(client, "publish_artifact", {
        title: "m",
        format: "html",
        content: "<p>m</p>",
      });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toContain("plan_read_only");
    } finally {
      await client.close();
    }
  });

  it("live-data writes are refused with 403: set, update, delete", async () => {
    const u = who();
    const doc = R.dataDoc(pool.data, "c", "d1");
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const r = await send(props, doc, u.cookie, {
        method,
        body: method === "DELETE" ? undefined : { a: 1 },
      });
      expect(r.status).toBe(403);
      expect((await errCode(r))?.code).toBe("plan_read_only");
    }
  });

  it("reads, sharing, visibility and comments keep working", async () => {
    const u = who();
    expect((await send(props, R.artifact(pool.id), u.cookie)).status).toBe(200);
    expect(
      (
        await send(props, R.shares(pool.id), u.cookie, {
          method: "PUT",
          body: { email: `out-${uniq()}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(props, R.artifact(pool.id), u.cookie, {
          method: "PATCH",
          body: { visibility: "team" },
        })
      ).status,
    ).toBe(200);
    const c = await send(props, R.comments(pool.id), u.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "hello" },
    });
    // The plan cap (non-owners, as under solo and free today) keeps a member
    // from comments; the owner is not capped and comments.
    if (_n === "the org owner") expect(c.status).toBeLessThan(300);
    else expect(c.status).toBe(403);
  });

  it("MCP set_visibility and share_artifact keep working", async () => {
    const u = who();
    const { token } = await createPat(env, u.userId, `s ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const v = await tool(client, "set_visibility", {
        id: pool.id,
        visibility: "private",
      });
      expect(v.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("revoking a token and the profile edit keep working", async () => {
    const u = who();
    expect(
      (
        await send(props, R.me, u.cookie, {
          method: "PATCH",
          body: { displayName: `n${uniq()}` },
        })
      ).status,
    ).toBe(200);
  });
});

describe("view-only: the solo team rules still apply", () => {
  const ids = { inSpace: "", mine: "", spaceId: "", memberOwn: "" };
  beforeAll(async () => {
    await setPlan({ ...base, tier: "business", status: "active" });
    const sp = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `vo-${uniq()}` },
    });
    ids.spaceId = ((await sp.json()) as { id: string }).id;
    ids.inSpace = (
      (await (await post(owner, { spaceId: ids.spaceId })).json()) as {
        id: string;
      }
    ).id;
    ids.mine = ((await (await post(owner)).json()) as { id: string }).id;
    ids.memberOwn = ((await (await post(member)).json()) as { id: string }).id;
    await setPlan(UNPAID);
  });

  it("the owner can't move or transfer, nor write to an artifact in a shared space", async () => {
    for (const r of [
      await send(props, R.moveArtifact(ids.mine), owner.cookie, {
        method: "POST",
        body: { spaceId: ids.spaceId },
      }),
      await send(props, R.transferArtifact(ids.mine), owner.cookie, {
        method: "POST",
        body: { userId: member.userId },
      }),
      await send(props, R.artifact(ids.inSpace), owner.cookie, {
        method: "PATCH",
        body: { title: "renamed" },
      }),
    ]) {
      expect(r.status).toBe(403);
      expect((await errCode(r))?.code).toMatch(/^plan_/);
    }
  });

  it("a member is plan-capped: a token is refused; sharing, visibility and revoking pass", async () => {
    const t = await send(props, R.tokens, member.cookie, {
      method: "POST",
      body: { label: `x ${uniq()}` },
    });
    expect(t.status).toBe(403);
    expect((await errCode(t))?.code).toBe("plan_read_only");
    expect(
      (
        await send(props, R.shares(ids.memberOwn), member.cookie, {
          method: "PUT",
          body: { email: `o-${uniq()}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(props, R.artifact(ids.memberOwn), member.cookie, {
          method: "PATCH",
          body: { visibility: "team" },
        })
      ).status,
    ).toBe(200);
    // Anything but visibility in the PATCH is refused.
    const p = await send(props, R.artifact(ids.memberOwn), member.cookie, {
      method: "PATCH",
      body: { title: "nope" },
    });
    expect(p.status).toBe(403);
  });
});

describe("view-only: the owner's other write paths", () => {
  const ids = { art: "", data: "", pub: "" };
  beforeAll(async () => {
    await setPlan({ ...base, tier: "business", status: "active" });
    const mk = async (b: Record<string, unknown> = {}) =>
      ((await (await post(owner, b)).json()) as { id: string }).id;
    ids.art = await mk();
    ids.data = await mk({ capabilities: { db: true, storage: true } });
    ids.pub = await mk({
      capabilities: { db: true },
      visibility: "public",
      dataWriters: "viewers",
    });
    await setPlan(UNPAID);
  });
  const refused = async (r: Response) => {
    expect(r.status).toBe(403);
    expect((await errCode(r))?.code).toBe("plan_read_only");
  };

  it("an anonymous data write on a public artifact is refused", async () => {
    await refused(
      await send(props, R.dataDoc(ids.pub, "votes", uniq()), null, {
        method: "PUT",
        raw: '{"v":1}',
      }),
    );
  });

  it("restore, uploads, data reset and storage writes are refused; storage reads pass", async () => {
    await refused(
      await send(props, R.restoreVersion(ids.art, 1), owner.cookie, {
        method: "POST",
      }),
    );
    await refused(
      await send(props, R.uploads, owner.cookie, {
        method: "POST",
        body: { path: "a.png", size: 3, contentType: "image/png" },
      }),
    );
    await refused(
      await send(props, R.uploads, owner.cookie, {
        method: "POST",
        body: {
          artifactId: ids.art,
          path: "a.png",
          size: 3,
          contentType: "image/png",
        },
      }),
    );
    await refused(
      await send(props, R.dataReset(ids.data), owner.cookie, {
        method: "PUT",
        body: { collections: {} },
      }),
    );
    const key = R.storageKey(ids.data, "k");
    await refused(
      await send(props, key, owner.cookie, { method: "PUT", raw: "{}" }),
    );
    await refused(await send(props, key, owner.cookie, { method: "DELETE" }));
    const get = await send(props, key, owner.cookie);
    expect([200, 404]).toContain(get.status);
    expect((await errCode(get))?.code).not.toBe("plan_read_only");
  });

  it("MCP publish_artifact {id, visibility} passes", async () => {
    const { token } = await createPat(env, owner.userId, `vis ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const r = await tool(client, "publish_artifact", {
        id: ids.art,
        visibility: "private",
      });
      expect(r.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("a member revoking their own token passes", async () => {
    await setPlan({ ...base, tier: "business", status: "active" });
    const t = await send(props, R.tokens, member.cookie, {
      method: "POST",
      body: { label: `r ${uniq()}` },
    });
    const tokenId = ((await t.json()) as { id: string }).id;
    await setPlan(UNPAID);
    expect(
      (await send(props, R.token(tokenId), member.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });
});

describe("tier free behaves as before Solo", () => {
  const FREE: BillingRow = {
    ...base,
    trialEndsAt: null,
    tier: "free",
    status: "active",
  };
  it("the solo lock; the first invite starts the trial; the owner can publish", async () => {
    await setPlan(FREE);
    expect((await post(owner)).status).toBe(201);
    const sp = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `sp-${uniq()}` },
    });
    expect((await errCode(sp))?.code).toBe("plan_required");
    const inv = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv-${uniq()}@a.com`, role: "member" },
    });
    expect(inv.status).toBeLessThan(300);
    expect(fake.calls.some((c) => c.path === "/trial/start")).toBe(true);
  });
});

describe("view-only: billing and plan state", () => {
  it("the owner opens Checkout, and Me reports the plan", async () => {
    await setPlan(UNPAID);
    const r = await send(props, R.billingCheckout, owner.cookie, {
      method: "POST",
      body: { tier: "team" },
    });
    expect(r.status).toBe(200);
    const me = (await (await send(props, R.me, owner.cookie)).json()) as {
      instance: { billing: Record<string, unknown> };
      auth: { cap: unknown };
    };
    expect(me.instance.billing).toMatchObject({
      tier: "solo",
      readOnly: true,
      reason: "solo_unpaid",
    });
    // No cap: nobody is capped by the view-only lock.
    expect(me.auth.cap).toBeNull();
  });

  it("team features are refused for the owner, and the Business trial does not start", async () => {
    await setPlan(UNPAID);
    const r = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv-${uniq()}@a.com`, role: "member" },
    });
    expect(r.status).toBe(403);
    expect((await errCode(r))?.code).toBe("plan_read_only");
  });
});

describe("solo active behaves as free did", () => {
  it("team features answer plan_required; the first invite starts the trial", async () => {
    await setPlan({ ...SOLO, trialEndsAt: null });
    const spaces = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `sp-${uniq()}` },
    });
    expect(spaces.status).toBe(403);
    expect((await errCode(spaces))?.code).toBe("plan_required");
    const inv = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv-${uniq()}@a.com`, role: "member" },
    });
    expect(inv.status).toBeLessThan(300);
    expect(fake.calls.some((c) => c.path === "/trial/start")).toBe(true);
  });

  it("publishing and data writes still work for the owner", async () => {
    await setPlan(SOLO);
    const r = await post(owner, { capabilities: { db: true } });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    const w = await send(props, R.dataDoc(id, "c", "d1"), owner.cookie, {
      method: "PUT",
      body: { a: 1 },
    });
    expect(w.status).toBeLessThan(300);
  });
});

describe("no BILLING gate: no plan, nothing changes", () => {
  it("an unpaid-looking cached answer does nothing without the gate", async () => {
    await setPlan(UNPAID);
    const noGate = {};
    const r = await send(noGate, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: `t ${uniq()}`, ...html, capabilities: { db: true } },
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    expect(
      (
        await send(noGate, R.dataDoc(id, "c", "d1"), owner.cookie, {
          method: "PUT",
          body: { a: 1 },
        })
      ).status,
    ).toBeLessThan(300);
    const me = (await (await send(noGate, R.me, owner.cookie)).json()) as {
      instance: { billing?: unknown };
    };
    expect(me.instance.billing).toBeUndefined();
  });
});

describe("view-only: an uncapped editor on someone else's artifact", () => {
  const ids = { shared: "", none: "", viewer: "" };
  let stranger: U;
  beforeAll(async () => {
    stranger = await login(`stranger-${tag}@a.com`, "member");
    await setPlan({ ...base, tier: "business", status: "active" });
    ids.shared = ((await (await post(member)).json()) as { id: string }).id;
    const s = await send(props, R.shares(ids.shared), member.cookie, {
      method: "PUT",
      body: { email: `owner-${tag}@a.com`, role: "editor" },
    });
    expect(s.status).toBe(200);
    ids.none = ((await (await post(member)).json()) as { id: string }).id;
    ids.viewer = ((await (await post(member)).json()) as { id: string }).id;
    const v = await send(props, R.shares(ids.viewer), member.cookie, {
      method: "PUT",
      body: { email: `owner-${tag}@a.com`, role: "viewer" },
    });
    expect(v.status).toBe(200);
    await setPlan(UNPAID);
  });

  it("the org owner with no access at all gets 404, not the plan error", async () => {
    const p = await send(props, R.artifact(ids.none), owner.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(p.status).toBe(404);
  });

  it("the org owner with only a viewer share gets 404", async () => {
    const p = await send(props, R.artifact(ids.viewer), owner.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(p.status).toBe(404);
  });

  it("gets the 403 plan error on a non-visibility PATCH, not a 404", async () => {
    const p = await send(props, R.artifact(ids.shared), owner.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(p.status).toBe(403);
    expect((await errCode(p))?.code).toBe("plan_read_only");
  });

  it("someone with no access at all still gets 404", async () => {
    const p = await send(props, R.artifact(ids.shared), stranger.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(p.status).toBe(404);
  });
});
