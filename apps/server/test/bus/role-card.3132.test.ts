// #3132 slice 2b part 2: the handover card. A take-over request is a role
// proposal (bus_role_propose set by a session that does not hold the role).
// The member answers it with one click in their own browser session
// (POST R.busRoleProposal(id)), from For you or Agents > Roles; no token
// answers for them. The card stays open for a day while the one-time link
// works only 15 minutes. Real hub and daemon sockets; time is
// BusHub.setTestClock; waits are frames.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_ROLE_PROPOSAL_CARD_TTL_MS,
  BUS_ROLE_PROPOSAL_TTL_MS,
  type BusRole,
  type BusRoleProposal,
  type BusRoles,
  type Inbox,
  type Me,
  R,
} from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { BusHub } from "../../src/bus/hub.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { api, errOf } from "../helpers.js";
import { oauthToken } from "../mcp-helpers.js";
import {
  daemon,
  e,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const app = createApp();
let seq = 0;
const uniq = (t: string) => `${t}${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

const clocked = new Set<string>();
afterEach(async () => {
  for (const u of clocked)
    await runInDurableObject(await hubOf(u), (i: BusHub) =>
      BusHub.setTestClock(i, null),
    );
  clocked.clear();
});
const setClock = async (userId: string, ms: number) => {
  clocked.add(userId);
  await runInDurableObject(await hubOf(userId), (i: BusHub) =>
    BusHub.setTestClock(i, ms),
  );
};

/** A member with two open sessions in one namespace; the first holds the role "platform". */
async function setup() {
  const who = await member();
  const mach = await machine("Laptop", who.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello("h"), caps: ["roles", "rename"] } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("card");
  const names: string[] = [];
  for (const [i, n] of [uniq("PlatL"), uniq("PlatW")].entries()) {
    d.send(up(`u${i}`, `ref${i}`, n, namespace));
    names.push((await waitFor(d, "agent_ok")).bus_name);
  }
  const hub = await hubOf(who.userId);
  const agents = (await hub.snapshot()).agents;
  const idOf = (name: string) => agents.find((a) => a.name === name)?.id ?? "";
  const put = await api(app, R.busRoles, who.cookie, {
    method: "PUT",
    body: { namespace, name: "platform", agentId: idOf(names[0] as string) },
  });
  expect(put.status).toBe(200);
  const secret = `s${uniq("x")}`;
  const propose = async (name = "platform", agent = names[1] as string) => {
    const r = await hub.proposeRole(
      { action: "set", namespace, name, agent, credential: null },
      await sha256Hex(secret + name + agent),
    );
    if (!r.ok) throw new Error(`propose refused: ${r.reason}`);
    return {
      proposal: r.proposal,
      hash: await sha256Hex(secret + name + agent),
    };
  };
  return {
    who,
    d,
    hub,
    namespace,
    names,
    idOf,
    propose,
    machineToken: mach.token,
  };
}

async function makeAway(s: Awaited<ReturnType<typeof setup>>) {
  // Away holder: since the hub's own away_since.
  const t = base();
  await runInDurableObject(s.hub, (_: BusHub, st) =>
    st.storage.sql.exec(
      "update agents set live = 0, away_since = ? where name = ?",
      t,
      s.names[0] as string,
    ),
  );
  return t;
}

const decide = (
  auth: string | null,
  id: string,
  decision: "confirm" | "reject" | "bogus" = "confirm",
) =>
  api(app, R.busRoleProposal(id), auth, {
    method: "POST",
    body: { decision },
  });
const rolesOf = async (cookie: string) =>
  ((await (await api(app, R.busRoles, cookie)).json()) as BusRoles).roles;
const inboxOf = async (cookie: string) =>
  (await (await api(app, R.meInbox, cookie)).json()) as Inbox;
const rows = async (userId: string) =>
  (
    await e.DB.prepare(
      "select action, detail from audit_events where target_id = ? and action like 'bus.role.%' order by at",
    )
      .bind(userId)
      .all<{ action: string; detail: string }>()
  ).results.map((r) => r.action);

describe("the handover card (#3132)", () => {
  it("a take-over request is a Needs-you item with who asks, who holds it and its count; it goes once decided", async () => {
    const s = await setup();
    const { proposal } = await s.propose();
    expect(proposal.action).toBe("repoint");
    // Live holder.
    let box = await inboxOf(s.who.cookie);
    expect(box.counts.needsYou).toBe(0);
    expect((await decide(s.who.cookie, proposal.id)).status).toBe(404);
    const ordinary = await s.propose("unheld");
    expect((await inboxOf(s.who.cookie)).needsYou.map((i) => i.id)).toEqual([
      `role:${ordinary.proposal.id}`,
    ]);
    expect(
      (await decide(s.who.cookie, ordinary.proposal.id, "reject")).status,
    ).toBe(200);
    const t = await makeAway(s);
    box = await inboxOf(s.who.cookie);
    const item = box.needsYou.find((i) => i.id === `role:${proposal.id}`);
    expect(item).toMatchObject({
      kind: "role",
      level: "needs_you",
      artifact: null,
      href: "/agents/roles",
      role: {
        proposalId: proposal.id,
        action: "repoint",
        name: "platform",
        namespace: s.namespace,
        agentName: s.names[1],
        priorHolderName: s.names[0],
        holder: { state: "away", since: new Date(t).toISOString() },
        expiresAt: proposal.expiresAt,
      },
      text: expect.stringContaining("(away"),
    });
    expect(box.counts.needsYou).toBe(1);
    expect(
      ((await (await api(app, R.me, s.who.cookie)).json()) as Me).inbox
        ?.needsYou,
    ).toBe(1);
    box = await inboxOf(s.who.cookie);
    expect(box.needsYou[0]?.role?.holder).toEqual({
      state: "away",
      since: new Date(t).toISOString(),
    });
    // Another member sees nothing of it.
    const other = await member();
    expect((await inboxOf(other.cookie)).needsYou).toEqual([]);

    expect((await decide(s.who.cookie, proposal.id, "reject")).status).toBe(
      200,
    );
    box = await inboxOf(s.who.cookie);
    expect(box.needsYou.filter((i) => i.kind === "role")).toEqual([]);
    expect(box.counts.needsYou).toBe(0);
    s.d.close();
  });

  it("no token answers for the member: a PAT, an OAuth grant or a machine token; guests and anonymous get nothing", async () => {
    const s = await setup();
    const { proposal } = await s.propose();
    const pat = (await createPat(e, s.who.userId, "agent")).token;
    const { accessToken } = await oauthToken("", "Agent", s.who);
    expect((await decide(pat, proposal.id)).status).toBe(404);
    // An OAuth grant or a machine token isn't a REST credential at all.
    for (const token of [accessToken, s.machineToken])
      expect((await decide(token, proposal.id)).status).toBe(401);
    expect((await decide(null, proposal.id)).status).toBe(401);
    const guest = await member("guest");
    expect((await decide(guest.cookie, proposal.id)).status).toBe(404);
    // Another member's browser finds no such proposal in their own hub.
    const other = await member();
    expect((await decide(other.cookie, proposal.id)).status).toBe(404);
    expect((await decide(s.who.cookie, "bad id!")).status).toBe(400);
    expect((await decide(s.who.cookie, proposal.id, "bogus")).status).toBe(400);
    const roles = await rolesOf(s.who.cookie);
    expect(roles[0]?.holderName).toBe(s.names[0]);
    s.d.close();
  });

  it("Yes moves the role to the asking session and audits confirmed and moved; it is single use", async () => {
    const s = await setup();
    const { proposal } = await s.propose();
    await makeAway(s);
    const r = await decide(s.who.cookie, proposal.id, "confirm");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      proposal: BusRoleProposal;
      role: BusRole | null;
    };
    expect(body.proposal).toMatchObject({ id: proposal.id, status: "applied" });
    expect(body.role).toMatchObject({
      name: "platform",
      agentId: s.idOf(s.names[1] as string),
    });
    const roles = await rolesOf(s.who.cookie);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.holderName).toBe(s.names[1]);
    expect(await rows(s.who.userId)).toEqual(
      expect.arrayContaining(["bus.role.confirmed", "bus.role.moved"]),
    );
    const again = await decide(s.who.cookie, proposal.id, "confirm");
    expect(again.status).toBe(409);
    expect((await errOf(again)).details).toEqual({ reason: "used" });
    s.d.close();
  });

  it("No refuses it, changes nothing and audits refused", async () => {
    const s = await setup();
    const { proposal } = await s.propose();
    await makeAway(s);
    const r = await decide(s.who.cookie, proposal.id, "reject");
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { proposal: BusRoleProposal }).proposal,
    ).toMatchObject({
      status: "refused",
      reason: "rejected",
    });
    expect((await rolesOf(s.who.cookie))[0]?.holderName).toBe(s.names[0]);
    const a = await rows(s.who.userId);
    expect(a).toContain("bus.role.refused");
    expect(a).not.toContain("bus.role.moved");
    s.d.close();
  });

  it("if the role moved since it was asked, Yes refuses `changed` and moves nothing", async () => {
    const s = await setup();
    const { proposal } = await s.propose();
    // The member re-points the role themself first.
    await api(app, R.busRoles, s.who.cookie, {
      method: "PUT",
      body: {
        namespace: s.namespace,
        name: "platform",
        agentId: s.idOf(s.names[1] as string),
      },
    });
    const r = await decide(s.who.cookie, proposal.id);
    expect(r.status).toBe(409);
    expect((await errOf(r)).details).toEqual({ reason: "changed" });
    expect(await rows(s.who.userId)).toContain("bus.role.refused");
    s.d.close();
  });

  it("the link works 15 minutes; the card works a day", async () => {
    expect(BUS_ROLE_PROPOSAL_TTL_MS).toBe(15 * 60_000);
    expect(BUS_ROLE_PROPOSAL_CARD_TTL_MS).toBe(24 * 3_600_000);
    const s = await setup();
    const t0 = base();
    await setClock(s.who.userId, t0);
    const a = await s.propose();
    await makeAway(s);
    expect(
      Date.parse(a.proposal.expiresAt) - Date.parse(a.proposal.createdAt),
    ).toBe(BUS_ROLE_PROPOSAL_CARD_TTL_MS);
    // Just inside 15 minutes: the link still shows it.
    await setClock(s.who.userId, t0 + BUS_ROLE_PROPOSAL_TTL_MS - 1);
    expect((await s.hub.viewRoleProposal(a.hash)).ok).toBe(true);
    // Past 15 minutes: the link says expired (view and decide), nothing is decided, the card still shows and decides.
    await setClock(s.who.userId, t0 + BUS_ROLE_PROPOSAL_TTL_MS);
    expect(await s.hub.viewRoleProposal(a.hash)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await s.hub.decideRoleProposal(a.hash, "confirm")).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(
      (await inboxOf(s.who.cookie)).needsYou.some(
        (i) => i.id === `role:${a.proposal.id}`,
      ),
    ).toBe(true);
    const r = await decide(s.who.cookie, a.proposal.id);
    expect(r.status).toBe(200);
    expect((await rolesOf(s.who.cookie))[0]?.holderName).toBe(s.names[1]);

    // A second request, a day on: the card answers expired too, and leaves For you.
    const b = await s.propose("unheld", s.names[1] as string);
    await setClock(
      s.who.userId,
      t0 + BUS_ROLE_PROPOSAL_TTL_MS + BUS_ROLE_PROPOSAL_CARD_TTL_MS,
    );
    expect(
      (await inboxOf(s.who.cookie)).needsYou.filter((i) => i.kind === "role"),
    ).toEqual([]);
    const late = await decide(s.who.cookie, b.proposal.id);
    expect(late.status).toBe(409);
    expect((await errOf(late)).details).toEqual({ reason: "expired" });
    expect((await rolesOf(s.who.cookie))[0]?.holderName).toBe(s.names[1]);
    s.d.close();
  });
});
