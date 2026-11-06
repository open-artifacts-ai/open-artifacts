// Sharing is free on every plan (user decision: "Sharing should not be paid
// as it is a mechanism to make OA viral"). With the BILLING gate bound, on
// free (solo) and under every lock, an artifact's owner can share it and
// change who can open it, REST and MCP; so can a plan-capped member for their
// own artifacts; and a person receiving a share is never refused. Everything
// else stays gated (invites, spaces, other writes by a capped member).
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
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
import { connect, textOf, tool } from "./mcp-helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const { s: fake, props } = fakeBilling();
let seq = 0;
const uniq = () => `${tag}${++seq}`;
const html = { format: "html", content: "<p>x</p>" };

const base = { trialEndsAt: 1, graceUntil: null, version: 1 };
const LOCKS: Record<string, BillingRow> = {
  "free (solo)": { ...base, tier: "free", status: "active" },
  trial_ended: { ...base, tier: "trial", status: "active" },
  lapsed: { ...base, tier: "team", status: "lapsed" },
  payment_failed: {
    ...base,
    tier: "team",
    status: "past_due",
    graceUntil: 1,
  },
  suspended: { ...base, tier: "team", status: "suspended" },
};

type U = { cookie: string; userId: string };
let owner: U;
let member: U;
let guest: U;
let mid = 0;

async function publish(u: U, extra: Record<string, unknown> = {}) {
  const r = await send(props, R.artifacts, u.cookie, {
    method: "POST",
    body: { title: `t ${uniq()}`, ...html, ...extra },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const code = async (r: Response) =>
  (await r.json().catch(() => ({}))) as { error?: { code: string } };

beforeAll(async () => {
  mid = pinMiddayUtc();
  owner = await login(`owner-${tag}@a.com`, "owner");
  member = await login(`member-${tag}@a.com`, "member");
  guest = await login(`guest-${tag}@a.com`, "guest");
});
afterAll(async () => {
  vi.useRealTimers();
  await clearBilling();
});

const locks = Object.entries(LOCKS);
// billing_unreachable: the last good read is over 7 days old and billing is down.
const unreachable = async () => {
  await clearBilling();
  await cachePlan(
    { ...base, tier: "team", status: "active", version: 5 },
    mid - 8 * DAY,
  );
  fake.down = true;
};

describe.each([
  ...locks.map(([name, row]) => [name, row] as const),
  ["billing_unreachable", null] as const,
])("sharing under %s", (_name, row) => {
  // Artifacts made before the lock lands (a capped member can't publish).
  const pool: { owner: string[]; member: string[]; theirs: string } = {
    owner: [],
    member: [],
    theirs: "",
  };
  beforeAll(async () => {
    fake.down = false;
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    for (let i = 0; i < 3; i++) pool.owner.push(await publish(owner));
    for (let i = 0; i < 3; i++) pool.member.push(await publish(member));
    pool.theirs = await publish(owner, { visibility: "team" });
    if (row) {
      await clearBilling();
      await cachePlan({ ...row, version: 2 });
    } else await unreachable();
  });
  afterAll(() => {
    fake.down = false;
  });

  it("the owner shares over REST, to a non-member and to a member, and sets visibility", async () => {
    const id = pool.owner[0] as string;
    const outsider = `out-${uniq()}@a.com`;
    const r = await send(props, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: outsider, role: "viewer" },
    });
    expect(r.status).toBe(200);
    const m = await send(props, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: `member-${tag}@a.com`, role: "editor" },
    });
    expect(m.status).toBe(200);
    expect(
      (
        await send(props, R.artifact(id), owner.cookie, {
          method: "PATCH",
          body: { visibility: "team" },
        })
      ).status,
    ).toBe(200);
    // The recipient member and a guest-by-share read it.
    expect((await send(props, R.artifact(id), member.cookie)).status).toBe(200);
  });

  it("the share_artifact and set_visibility MCP tools succeed for the owner", async () => {
    const id = pool.owner[1] as string;
    const { token } = await createPat(env, owner.userId, `owner ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const sh = await tool(client, "share_artifact", {
        id,
        email: `m-${uniq()}@a.com`,
        role: "viewer",
      });
      expect([sh.isError ?? false, textOf(sh)]).toEqual([
        false,
        expect.any(String),
      ]);
      const v = await tool(client, "set_visibility", {
        id,
        visibility: "team",
      });
      expect(v.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("a plan-capped member shares, unshares and sets visibility on their own artifact", async () => {
    const id = pool.member[0] as string;
    // The dashboard reads `can`: share and visibility on, the rest off.
    const got = (await (
      await send(props, R.artifact(id), member.cookie)
    ).json()) as { can: Record<string, boolean> };
    expect(got.can).toMatchObject({
      share: true,
      setVisibility: true,
      edit: false,
      delete: false,
      move: false,
    });
    const email = `mm-${uniq()}@a.com`;
    const put = await send(props, R.shares(id), member.cookie, {
      method: "PUT",
      body: { email, role: "viewer" },
    });
    expect(put.status).toBe(200);
    expect((await send(props, R.shares(id), member.cookie)).status).toBe(200);
    expect(
      (
        await send(props, R.artifact(id), member.cookie, {
          method: "PATCH",
          body: { visibility: "public" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(props, R.share(id, email), member.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    // A capped member's agent cannot connect at all (mcp.connect, policy.ts),
    // so MCP is no route to sharing for them; the owner's agent is above.
  });

  it("a capped member still can't do other writes, and can't share what isn't theirs", async () => {
    const mine = pool.member[1] as string;
    const theirs = pool.theirs;
    const rename = await send(props, R.artifact(mine), member.cookie, {
      method: "PATCH",
      body: { title: "renamed" },
    });
    expect(rename.status).toBe(403);
    expect(
      (
        await send(props, R.artifact(mine), member.cookie, {
          method: "PATCH",
          body: { title: "renamed", visibility: "team" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(props, R.versions(mine), member.cookie, {
          method: "POST",
          body: html,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(props, R.shares(theirs), member.cookie, {
          method: "PUT",
          body: { email: `x-${uniq()}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBe(404);
  });

  it("the rest of the gate stays: invites and space creation are refused", async () => {
    const invite = await send(props, R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv-${uniq()}@a.com`, role: "member" },
    });
    expect(invite.status).toBe(403);
    expect((await code(invite)).error?.code).toMatch(/^plan_/);
    const space = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `S ${uniq()}` },
    });
    expect(space.status).toBe(403);
    expect((await code(space)).error?.code).toMatch(/^plan_/);
  });

  it("receiving a share is never refused: a guest and a member read what was shared with them", async () => {
    const id = pool.owner[2] as string;
    for (const [who, email] of [
      [guest, `guest-${tag}@a.com`],
      [member, `member-${tag}@a.com`],
    ] as const) {
      expect(
        (
          await send(props, R.shares(id), owner.cookie, {
            method: "PUT",
            body: { email, role: "viewer" },
          })
        ).status,
      ).toBe(200);
      expect((await send(props, R.artifact(id), who.cookie)).status).toBe(200);
    }
    // A non-member on an install with no account yet: the guest is accepted.
    const r = await send(props, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: `new-${uniq()}@a.com`, role: "viewer" },
    });
    expect(r.status).toBe(200);
  });
});

describe("self-host and a hosted install with no gate are unchanged", () => {
  it("share and visibility work with no BILLING gate bound", async () => {
    await clearBilling();
    const created = await send({}, R.artifacts, member.cookie, {
      method: "POST",
      body: { title: "ng", ...html },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    // Hosted without the gate (H), and self-hosted (HOSTED unset).
    const SELF = { ...H, HOSTED: undefined } as unknown as typeof H;
    for (const e of [H, SELF]) {
      const r = await send({}, R.shares(id), member.cookie, {
        e,
        method: "PUT",
        body: { email: `ng-${uniq()}@a.com`, role: "viewer" },
      });
      expect(r.status).toBe(200);
    }
    expect(
      (
        await send({}, R.artifact(id), member.cookie, {
          method: "PATCH",
          body: { visibility: "team" },
        })
      ).status,
    ).toBe(200);
  });
});
