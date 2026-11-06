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
};
// An operator's abuse stop, not a payment state: sharing is NOT free here.
const SUSPENDED: BillingRow = {
  ...base,
  tier: "team",
  status: "suspended",
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
    // An allow-list: visibility plus any other field is refused.
    for (const extra of [
      { comments: true },
      { dataWriters: "editors" },
      { allowAnonymousWrites: false },
      { capabilities: {} },
    ])
      expect(
        (
          await send(props, R.artifact(mine), member.cookie, {
            method: "PATCH",
            body: { visibility: "team", ...extra },
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

describe("a plan-capped member's agent", () => {
  const pool = { mine: [] as string[], theirs: "" };
  beforeAll(async () => {
    fake.down = false;
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    for (let i = 0; i < 3; i++) pool.mine.push(await publish(member));
    pool.theirs = await publish(owner, { visibility: "team" });
    await clearBilling();
    await cachePlan({ ...LOCKS.lapsed, version: 2 } as BillingRow);
  });

  const agent = async (u: U) => {
    const { token } = await createPat(env, u.userId, `agent ${uniq()}`);
    return connect(token, { env: H, props });
  };

  it("connects, and shares and sets visibility on their own artifact", async () => {
    const client = await agent(member);
    try {
      const id = pool.mine[0] as string;
      const email = `ag-${uniq()}@a.com`;
      const sh = await tool(client, "share_artifact", {
        id,
        email,
        role: "viewer",
      });
      expect(sh.isError ?? false).toBe(false);
      const v = await tool(client, "set_visibility", {
        id,
        visibility: "team",
      });
      expect(v.isError ?? false).toBe(false);
      const un = await tool(client, "unshare_artifact", {
        id,
        email,
      });
      expect(un.isError ?? false).toBe(false);
      expect((await tool(client, "get_artifact", { id })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("publish_artifact with only visibility goes through the same exception", async () => {
    const client = await agent(member);
    try {
      const id = pool.mine[2] as string;
      const ok = await tool(client, "publish_artifact", {
        id,
        visibility: "team",
      });
      expect([ok.isError ?? false, textOf(ok)]).toEqual([
        false,
        expect.any(String),
      ]);
      const more = await tool(client, "publish_artifact", {
        id,
        visibility: "private",
        title: "renamed",
      });
      expect(more.isError).toBe(true);
      const caps = await tool(client, "publish_artifact", {
        id,
        visibility: "private",
        dataWriters: "editors",
      });
      expect(caps.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("every other write still gets the plan error, and another member's artifact is refused", async () => {
    const client = await agent(member);
    try {
      const mine = pool.mine[1] as string;
      const publishNew = await tool(client, "publish_artifact", {
        id: mine,
        format: "html",
        content: "<p>2</p>",
      });
      expect(publishNew.isError).toBe(true);
      expect(textOf(publishNew)).toMatch(/read-only/i);
      const rename = await tool(client, "publish_artifact", {
        id: mine,
        title: "renamed",
      });
      expect(rename.isError).toBe(true);
      expect(textOf(rename)).toMatch(/read-only/i);
      const create = await tool(client, "publish_artifact", {
        title: "new",
        format: "html",
        content: "<p>x</p>",
      });
      expect(create.isError).toBe(true);
      const theirs = await tool(client, "share_artifact", {
        id: pool.theirs,
        email: `x-${uniq()}@a.com`,
        role: "viewer",
      });
      expect(theirs.isError).toBe(true);
      const vis = await tool(client, "set_visibility", {
        id: pool.theirs,
        visibility: "private",
      });
      expect(vis.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("guest- and restricted-capped callers still can't connect", async () => {
    const restricted = await login(`restricted-${tag}@a.com`, "member");
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(restricted.userId)
      .run();
    for (const u of [guest, restricted]) {
      const { token } = await createPat(env, u.userId, `capped ${uniq()}`);
      await expect(connect(token, { env: H, props })).rejects.toThrow(
        /Only members can connect agents/,
      );
    }
  });
});

describe("a plan-capped manager of a shared space", () => {
  it("the server's can and the share route agree: share and visibility on, the rest off", async () => {
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    const sp = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `Mgr ${uniq()}` },
    });
    expect(sp.status).toBe(201);
    const spaceId = ((await sp.json()) as { id: string }).id;
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'manager', 'manual', 1)",
    )
      .bind(spaceId, member.userId)
      .run();
    const editorOnly = await login(`ed-${tag}@a.com`, "member");
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
    )
      .bind(spaceId, editorOnly.userId)
      .run();
    const id = await publish(owner, { spaceId });
    await clearBilling();
    await cachePlan({ ...LOCKS.lapsed, version: 2 } as BillingRow);
    const canOf = async (u: U) =>
      (
        (await (await send(props, R.artifact(id), u.cookie)).json()) as {
          can: Record<string, boolean>;
        }
      ).can;
    expect(await canOf(member)).toMatchObject({
      share: true,
      setVisibility: true,
      edit: false,
      delete: false,
      move: false,
    });
    // An editor (not a manager) can't share, here or on the server.
    expect(await canOf(editorOnly)).toMatchObject({
      share: false,
      setVisibility: false,
    });
    expect(
      (
        await send(props, R.shares(id), member.cookie, {
          method: "PUT",
          body: { email: `mg-${uniq()}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(props, R.shares(id), editorOnly.cookie, {
          method: "PUT",
          body: { email: `eg-${uniq()}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describe("suspended is an operator's stop: sharing is not free there", () => {
  const pool = { mine: "", owners: "" };
  const sharedEmail = `keep-${tag}@a.com`;
  beforeAll(async () => {
    fake.down = false;
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    pool.mine = await publish(member);
    pool.owners = await publish(owner);
    for (const [id, who] of [
      [pool.mine, member],
      [pool.owners, owner],
    ] as const)
      expect(
        (
          await send(props, R.shares(id), who.cookie, {
            method: "PUT",
            body: { email: sharedEmail, role: "viewer" },
          })
        ).status,
      ).toBe(200);
    await clearBilling();
    await cachePlan({ ...SUSPENDED, version: 2 });
  });
  const codeOf = async (r: Response) => (await code(r)).error?.code;

  it("a new share, over REST and MCP, is refused for the owner and a capped member", async () => {
    for (const [id, who] of [
      [pool.owners, owner],
      [pool.mine, member],
    ] as const) {
      const r = await send(props, R.shares(id), who.cookie, {
        method: "PUT",
        body: { email: `n-${uniq()}@a.com`, role: "viewer" },
      });
      expect(r.status).toBe(403);
      expect(await codeOf(r)).toBe("plan_read_only");
    }
    const { token } = await createPat(env, owner.userId, `susp ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const sh = await tool(client, "share_artifact", {
        id: pool.owners,
        email: `m-${uniq()}@a.com`,
        role: "viewer",
      });
      expect(sh.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("a capped member's visibility change is refused; removing a share is allowed", async () => {
    const vis = await send(props, R.artifact(pool.mine), member.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(vis.status).toBe(403);
    expect(await codeOf(vis)).toBe("plan_read_only");
    expect(
      (
        await send(props, R.share(pool.mine, sharedEmail), member.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await send(props, R.share(pool.owners, sharedEmail), owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  it("a capped member's agent can't connect", async () => {
    const { token } = await createPat(env, member.userId, `susp ${uniq()}`);
    await expect(connect(token, { env: H, props })).rejects.toThrow(
      /Only members can connect agents/,
    );
  });
});

describe("a suspension masked by the outage rule is still a suspension", () => {
  const pool = { mine: "", owners: "" };
  beforeAll(async () => {
    fake.down = false;
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    pool.mine = await publish(member);
    pool.owners = await publish(owner);
    await clearBilling();
    // Suspended, and the last good read is over 7 days old: the plan reports
    // billing_unreachable, but the cached status is still suspended.
    await cachePlan({ ...SUSPENDED, version: 2 }, mid - 8 * DAY);
    fake.down = true;
  });
  afterAll(() => {
    fake.down = false;
  });

  it("refuses a new share, a capped member's visibility change and their agent", async () => {
    const r = await send(props, R.shares(pool.owners), owner.cookie, {
      method: "PUT",
      body: { email: `st-${uniq()}@a.com`, role: "viewer" },
    });
    expect(r.status).toBe(403);
    const vis = await send(props, R.artifact(pool.mine), member.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(vis.status).toBe(403);
    const { token } = await createPat(env, member.userId, `stale ${uniq()}`);
    await expect(connect(token, { env: H, props })).rejects.toThrow(
      /Only members can connect agents/,
    );
  });
});

describe("under a suspension the owner can't make anything public", () => {
  const pool = { a: "", b: "", c: "", d: "" };
  const keep = `keep2-${tag}@a.com`;
  beforeAll(async () => {
    fake.down = false;
    await clearBilling();
    await cachePlan({
      ...base,
      tier: "business",
      status: "active",
      version: 1,
    });
    for (const k of ["a", "b", "c", "d"] as const)
      pool[k] = await publish(owner);
    expect(
      (
        await send(props, R.shares(pool.a), owner.cookie, {
          method: "PUT",
          body: { email: keep, role: "viewer" },
        })
      ).status,
    ).toBe(200);
    await clearBilling();
    await cachePlan({ ...SUSPENDED, version: 2 });
  });

  it("refuses public over REST PATCH, set_visibility and publish_artifact settings", async () => {
    const r = await send(props, R.artifact(pool.a), owner.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    expect(r.status).toBe(403);
    expect((await code(r)).error?.code).toBe("plan_read_only");
    const { token } = await createPat(env, owner.userId, `pub ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const sv = await tool(client, "set_visibility", {
        id: pool.b,
        visibility: "public",
      });
      expect(sv.isError).toBe(true);
      const ps = await tool(client, "publish_artifact", {
        id: pool.b,
        visibility: "public",
      });
      expect(ps.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("still allows team and private, and removing a share", async () => {
    for (const visibility of ["team", "private"])
      expect(
        (
          await send(props, R.artifact(pool.c), owner.cookie, {
            method: "PATCH",
            body: { visibility },
          })
        ).status,
      ).toBe(200);
    const { token } = await createPat(env, owner.userId, `priv ${uniq()}`);
    const client = await connect(token, { env: H, props });
    try {
      const sv = await tool(client, "set_visibility", {
        id: pool.d,
        visibility: "team",
      });
      expect(sv.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
    expect(
      (
        await send(props, R.share(pool.a, keep), owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });
});
