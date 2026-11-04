// #1372 role proposals: an AI agent proposes a role change over MCP
// (bus_role_propose) and nothing changes until the member confirms it on its
// one-time link, in a browser (GET/POST /bus/roles/confirm/:token). The
// user's guardrail ("Let's do B", then "1, propose via MCP, I confirm by
// link"): no MCP tool, no REST credential (PAT, OAuth grant, machine token)
// and no bus frame can confirm one.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BUS_CAPS } from "@oa/bus-protocol";
import {
  BUS_ROLE_PROPOSALS_PENDING_MAX,
  type BusRole,
  type BusRoleProposal,
  type BusRoles,
  R,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import type { BusHub } from "../../src/bus/hub.js";
import { ROLE_CONFIRM_SCOPE } from "../../src/bus/role-confirm.js";
import { formCsrf } from "../../src/http/pages.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { trial } from "../auth-helpers.js";
import { accessSignIn } from "../fake-access.js";
import { api, fetchAndWait, login } from "../helpers.js";
import {
  connect,
  E,
  oauthToken,
  type ToolResult,
  textOf,
  tool,
} from "../mcp-helpers.js";
import {
  type Daemon,
  daemon,
  hubOf,
  machine,
  member,
  ns,
  waitFor,
} from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

type Who = { userId: string; cookie: string };

/** A member with a connected machine (a daemon that said hello with the roles cap). */
async function withBus(who?: Who) {
  const base = who ?? (await member());
  // A browser that just went through a forced sign-in (the re-auth marker):
  // what the confirm page needs (#1372).
  const now = Date.now();
  const m = {
    ...base,
    cookie: await sessionAt(base.userId, now, "access", now),
  };
  const mach = await machine("MacBook", m.userId);
  const d = await daemon(mach.token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    caps: [BUS_CAPS.roles, BUS_CAPS.rename],
  });
  await waitFor(d, "hello_ok");
  const pat = (await createPat(env, m.userId, "agent")).token;
  return { who: m, d, machineToken: mach.token, pat };
}

let refSeq = 0;
/** Opens an agent named like `name` in `namespace`; returns its bus name and id. */
async function open(
  uid: string,
  d: Daemon,
  namespace: string,
  name = uniq("agent"),
  nameKind?: "default" | "chosen",
) {
  const ref = `r${++refSeq}`;
  d.send({
    v: 1,
    id: `u${refSeq}`,
    type: "agent_up",
    agent_ref: ref,
    kind: "opencode",
    proposed_name: name,
    namespace,
    global: false,
    ...(nameKind ? { name_kind: nameKind } : {}),
  });
  const ok = await waitFor(d, "agent_ok");
  const a = (await (await hubOf(uid)).snapshot()).agents.find(
    (x) => x.name === ok.bus_name,
  );
  if (!a) throw new Error("agent not listed");
  return { ref, name: ok.bus_name, id: a.id };
}

/** One MCP call of bus_role_propose as `token`. */
async function propose(
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const c = await connect(token, { env: E() });
  try {
    return await tool(c, "bus_role_propose", args);
  } finally {
    await c.close();
  }
}

type Proposed = { proposal: BusRoleProposal; confirmUrl: string };
const proposed = (r: ToolResult): Proposed & { secret: string } => {
  expect(r.isError, textOf(r)).toBeFalsy();
  const sc = r.structuredContent as Proposed;
  const m = /\/bus\/roles\/confirm\/([A-Za-z0-9_-]{43})$/.exec(sc.confirmUrl);
  if (!m?.[1]) throw new Error(`no confirm link: ${sc.confirmUrl}`);
  return { ...sc, secret: m[1] };
};

const path = (secret: string) => `/bus/roles/confirm/${secret}`;

const get = (
  secret: string,
  headers: Record<string, string>,
  e: unknown = env,
) => fetchAndWait(app, new Request(`${APP}${path(secret)}`, { headers }), e);

const post = (
  secret: string,
  headers: Record<string, string>,
  fields: [string, string][],
  e: unknown = env,
) => {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    app,
    new Request(`${APP}${path(secret)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    }),
    e,
  );
};

const csrfOf = (body: string) => {
  const m = /name="csrf" value="([^"]+)"/.exec(body);
  if (!m?.[1]) throw new Error("no csrf field on the page");
  return m[1];
};

/** Loads the confirm page as `cookie` and posts its own form, as a browser would. */
async function confirmInBrowser(
  cookie: string,
  secret: string,
  decision: "confirm" | "reject" = "confirm",
  e: unknown = env,
) {
  const page = await get(secret, { cookie }, e);
  expect(page.status).toBe(200);
  return post(
    secret,
    { cookie },
    [
      ["csrf", csrfOf(await page.text())],
      ["decision", decision],
    ],
    e,
  );
}

/** A valid form token for `uid` and link `secret`, minted directly (as if the page had been loaded). */
const forgedCsrf = async (uid: string, secret: string) =>
  formCsrf(env, ROLE_CONFIRM_SCOPE, uid, await sha256Hex(secret));

const roles = async (uid: string): Promise<BusRole[]> =>
  (await hubOf(uid)).listRoles();
const proposals = async (uid: string) =>
  (await (await hubOf(uid)).listRoleProposals()).proposals;

type AuditRow = {
  action: string;
  actor_kind: string;
  actor_id: string | null;
  actor_cred_kind: string | null;
  target_type: string;
  target_id: string;
  detail: string;
};
const auditRows = async (uid: string) =>
  (
    await env.DB.prepare(
      "select action, actor_kind, actor_id, actor_cred_kind, target_type, target_id, detail from audit_events where target_id = ? and action like 'bus.role.%' order by at",
    )
      .bind(uid)
      .all<AuditRow>()
  ).results;

describe("role proposals over MCP (#1372)", () => {
  it("a proposal changes nothing until the member confirms it in a browser; then it applies, once", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const r = await propose(pat, {
      action: "set",
      namespace: n,
      name: "backend-lead",
      agent: alice.name,
    });
    const p = proposed(r);
    expect(p.proposal).toMatchObject({
      action: "set",
      namespace: n,
      name: "backend-lead",
      agentId: alice.id,
      agentName: alice.name,
      priorAgentId: null,
      status: "pending",
    });
    expect(textOf(r)).toContain(p.confirmUrl);
    expect(textOf(r)).toMatch(/Nothing has changed/);
    // Nothing changed: no role, and the REST view lists it as pending.
    expect(await roles(who.userId)).toEqual([]);
    const listed = (await (
      await api(app, R.busRoles, who.cookie)
    ).json()) as BusRoles;
    expect(listed.roles).toEqual([]);
    expect(listed.proposals).toEqual([p.proposal]);
    expect(JSON.stringify(listed)).not.toContain(p.secret);

    const page = await get(p.secret, { cookie: who.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("backend-lead");
    expect(html).toContain(n);
    expect(html).toContain(alice.name);
    expect(html).toContain("No role with this name yet");
    expect(await roles(who.userId)).toEqual([]);

    const done = await post(p.secret, { cookie: who.cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Role updated");
    expect(await roles(who.userId)).toMatchObject([
      { namespace: n, name: "backend-lead", agentId: alice.id, vacant: false },
    ]);
    expect((await proposals(who.userId))[0]?.status).toBe("applied");

    // Single use: the same form again, or a fresh load, is refused.
    const again = await post(p.secret, { cookie: who.cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(again.status).toBe(410);
    expect((await get(p.secret, { cookie: who.cookie })).status).toBe(410);
    d.close();
  });

  it("re-point and clear show the displaced and the new holder, and apply through the role's own code path", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const bob = await open(who.userId, d, n);
    const set = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    expect((await confirmInBrowser(who.cookie, set.secret)).status).toBe(200);
    const [role] = await roles(who.userId);
    if (!role) throw new Error("no role");

    const re = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: bob.name.toUpperCase(),
      }),
    );
    expect(re.proposal).toMatchObject({
      action: "repoint",
      roleId: role.id,
      agentId: bob.id,
      agentName: bob.name,
      priorAgentId: alice.id,
      priorHolderName: alice.name,
    });
    const page = await (await get(re.secret, { cookie: who.cookie })).text();
    expect(page).toContain("Re-point this role?");
    expect(page.indexOf(alice.name)).toBeLessThan(page.indexOf(bob.name));
    expect((await roles(who.userId))[0]?.agentId).toBe(alice.id);
    expect((await confirmInBrowser(who.cookie, re.secret)).status).toBe(200);
    expect(await roles(who.userId)).toMatchObject([
      { id: role.id, agentId: bob.id },
    ]);

    const clear = proposed(
      await propose(pat, { action: "clear", namespace: n, name: "LEAD" }),
    );
    expect(clear.proposal).toMatchObject({
      action: "clear",
      roleId: role.id,
      agentId: null,
      priorHolderName: bob.name,
    });
    const cpage = await (
      await get(clear.secret, { cookie: who.cookie })
    ).text();
    expect(cpage).toContain("Remove this role?");
    expect(cpage).toContain(bob.name);
    expect(await roles(who.userId)).toHaveLength(1);
    expect((await confirmInBrowser(who.cookie, clear.secret)).status).toBe(200);
    expect(await roles(who.userId)).toEqual([]);
    d.close();
  });

  it("the member can reject it: nothing changes and the link is spent", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const r = await confirmInBrowser(who.cookie, p.secret, "reject");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Change turned down");
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]).toMatchObject({
      status: "refused",
      reason: "rejected",
    });
    expect((await get(p.secret, { cookie: who.cookie })).status).toBe(410);
    d.close();
  });

  it("an expired link is refused and nothing changes", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const page = await (await get(p.secret, { cookie: who.cookie })).text();
    // The link runs out while the page is open.
    await runInDurableObject(await hubOf(who.userId), (_: BusHub, s) => {
      s.storage.sql.exec("update role_proposals set expires_at = 1");
    });
    const r = await post(p.secret, { cookie: who.cookie }, [
      ["csrf", csrfOf(page)],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("This link expired");
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]?.status).toBe("expired");
    d.close();
  });

  it("an unknown, tampered or malformed link is refused; the real one still works", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const flip = (s: string) =>
      `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    for (const bad of [
      flip(p.secret),
      "A".repeat(43),
      "short",
      `${p.secret}x`,
    ]) {
      expect((await get(bad, { cookie: who.cookie })).status, bad).toBe(404);
      const r = await post(bad, { cookie: who.cookie }, [
        ["csrf", await forgedCsrf(who.userId, bad)],
        ["decision", "confirm"],
      ]);
      expect(r.status, bad).toBe(404);
    }
    // A form token for another link never confirms this one.
    const wrong = await post(p.secret, { cookie: who.cookie }, [
      ["csrf", await forgedCsrf(who.userId, flip(p.secret))],
      ["decision", "confirm"],
    ]);
    expect(wrong.status).toBe(403);
    expect(await roles(who.userId)).toEqual([]);
    expect((await confirmInBrowser(who.cookie, p.secret)).status).toBe(200);
    d.close();
  });

  it("another member's session can't see or confirm it, even with a valid form token of their own", async () => {
    const { who, d, pat } = await withBus();
    const mallory = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    expect((await get(p.secret, { cookie: mallory.who.cookie })).status).toBe(
      404,
    );
    const r = await post(p.secret, { cookie: mallory.who.cookie }, [
      ["csrf", await forgedCsrf(mallory.who.userId, p.secret)],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(404);
    // The owner's form token is bound to the owner: refused for Mallory.
    const stolen = await post(p.secret, { cookie: mallory.who.cookie }, [
      ["csrf", await forgedCsrf(who.userId, p.secret)],
      ["decision", "confirm"],
    ]);
    expect(stolen.status).toBe(403);
    expect(await roles(who.userId)).toEqual([]);
    expect(await roles(mallory.who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]?.status).toBe("pending");
    expect((await confirmInBrowser(who.cookie, p.secret)).status).toBe(200);
    d.close();
    mallory.d.close();
  });

  it("a stale session can't confirm: signed out everywhere, not an interactive sign-in, or a form token past its time", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const csrf = await forgedCsrf(who.userId, p.secret);
    // A dev session (not a person signing in in a browser).
    const dev = `${sessionCookieName(env)}=${await signSession(
      env,
      who.userId,
      Date.now(),
      { provider: "dev", epoch: 0 },
    )}`;
    expect((await get(p.secret, { cookie: dev })).status).toBe(403);
    expect(
      (
        await post(p.secret, { cookie: dev }, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    // A form token past its time (exp in the past, correctly signed or not).
    const expired = await post(p.secret, { cookie: who.cookie }, [
      ["csrf", `1.${"A".repeat(43)}`],
      ["decision", "confirm"],
    ]);
    expect(expired.status).toBe(403);
    // Signed out everywhere: the old cookie is no session at all.
    const old = who.cookie;
    await env.DB.prepare(
      "update users set session_epoch = session_epoch + 1 where id = ?",
    )
      .bind(who.userId)
      .run();
    const r = await post(p.secret, { cookie: old }, [
      ["csrf", csrf],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(401);
    expect((await get(p.secret, { cookie: old })).status).toBe(302);
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]?.status).toBe("pending");
    d.close();
  });

  it("no agent credential confirms: a PAT, an OAuth grant or a machine token, with or without the member's cookie", async () => {
    const { who, d, pat, machineToken } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const { accessToken } = await oauthToken("", "Agent", who);
    const csrf = await forgedCsrf(who.userId, p.secret);
    for (const token of [pat, accessToken, machineToken]) {
      for (const cookie of [undefined, who.cookie]) {
        const headers = {
          authorization: `Bearer ${token}`,
          ...(cookie ? { cookie } : {}),
        };
        const g = await get(p.secret, headers);
        expect(g.status, token.slice(0, 9)).toBe(401);
        expect(await g.text()).not.toContain('name="csrf"');
        const r = await post(p.secret, headers, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ]);
        expect(r.status, token.slice(0, 9)).toBe(401);
      }
    }
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]?.status).toBe("pending");
    expect((await confirmInBrowser(who.cookie, p.secret)).status).toBe(200);
    d.close();
  });

  it("no MCP tool confirms or applies: the only bus tool proposes, and proposing again changes nothing", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const c = await connect(pat, { env: E() });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.filter((t) => /bus|role|confirm/i.test(t))).toEqual([
      "bus_role_propose",
    ]);
    for (const t of ["bus_role_confirm", "bus_role_set", "bus_role_apply"])
      await expect(tool(c, t, {})).rejects.toThrow(/not found/i);
    for (let i = 0; i < 3; i++) {
      const r = await tool(c, "bus_role_propose", {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      });
      expect(r.isError, textOf(r)).toBeFalsy();
    }
    // An agent can't pass a confirm of its own through the proposal input.
    const extra = await tool(c, "bus_role_propose", {
      action: "set",
      namespace: n,
      name: "lead",
      agent: alice.name,
      confirm: true,
    }).catch((e: unknown) => ({ isError: true, content: [], error: e }));
    expect(extra.isError).toBe(true);
    await c.close();
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId)).map((x) => x.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    d.close();
  });

  it("an OAuth grant proposes too; the audit row names its credential", async () => {
    const { who, d } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const { accessToken } = await oauthToken("", "Agent", who);
    proposed(
      await propose(accessToken, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const rows = await auditRows(who.userId);
    expect(rows.map((r) => [r.action, r.actor_cred_kind])).toEqual([
      ["bus.role.proposed", "oauth_grant"],
    ]);
    d.close();
  });

  it("only the caller's own hub and agents: another member's agent can't be targeted", async () => {
    const { who, d, pat } = await withBus();
    const mallory = await withBus();
    const n = ns("rp");
    const theirs = await open(mallory.who.userId, mallory.d, n);
    const r = await propose(pat, {
      action: "set",
      namespace: n,
      name: "lead",
      agent: theirs.name,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^conflict: No open agent/);
    // Nor a role of theirs to clear.
    const mine = await open(mallory.who.userId, mallory.d, n);
    expect(
      (await (await hubOf(mallory.who.userId)).putRole(n, "theirs", mine.id))
        .ok,
    ).toBe(true);
    const clear = await propose(pat, {
      action: "clear",
      namespace: n,
      name: "theirs",
    });
    expect(textOf(clear)).toMatch(/^conflict: There is no role/);
    expect(await proposals(who.userId)).toEqual([]);
    expect(await proposals(mallory.who.userId)).toEqual([]);
    d.close();
    mallory.d.close();
  });

  it("validation matches putRole: live, chosen former and minted names, an agent outside the namespace, a bad shape", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const refused = async (args: Record<string, unknown>, want: RegExp) => {
      const r = await propose(pat, args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r), JSON.stringify(args)).toMatch(want);
    };
    const set = (name: string, agent = alice.name, namespace = n) => ({
      action: "set",
      namespace,
      name,
      agent,
    });
    // A live agent's name there.
    const bob = await open(who.userId, d, n);
    await refused(
      set(bob.name.toUpperCase()),
      /^conflict: An agent or a reserved name/,
    );
    // A chosen former name in its grace.
    const left = uniq("left");
    const carol = await open(who.userId, d, n, left);
    d.send({
      v: 1,
      id: "rn1",
      type: "rename",
      agent_ref: carol.ref,
      proposed_name: uniq("right"),
    });
    await waitFor(d, "renamed");
    await refused(set(left), /^conflict: An agent or a reserved name/);
    // Another agent's minted name.
    const minted = await open(who.userId, d, n, "pi", "default");
    expect(minted.name).toMatch(/^pi-[0-9a-f]{4}$/);
    await refused(set(minted.name), /^conflict: An agent or a reserved name/);
    // The same checks putRole runs, answered the same way.
    for (const name of [bob.name, left, minted.name])
      expect(
        await (await hubOf(who.userId)).putRole(n, name, alice.id),
      ).toEqual({ ok: false, reason: "name_taken" });
    // An agent not open in that namespace; no such agent.
    await refused(
      set("lead", alice.name, ns("other")),
      /^conflict: No open agent/,
    );
    await refused(set("lead", "nobody-here"), /^conflict: No open agent/);
    // Shapes.
    await refused(
      { action: "set", namespace: n, name: "lead" },
      /^bad_request: agent is required/,
    );
    await refused(
      { action: "clear", namespace: n, name: "lead", agent: alice.name },
      /^bad_request: agent is not taken/,
    );
    await refused(set("open-artifacts"), /invalid|reserved|Invalid/i);
    await refused(set("openbus"), /^bad_request: Invalid name/);
    await refused(set("lead", alice.name, "Not Canonical"), /invalid|Invalid/);
    await refused(
      { action: "clear", namespace: n, name: "nope" },
      /^conflict: There is no role/,
    );
    expect(await proposals(who.userId)).toEqual([]);
    d.close();
  });

  it("a proposal whose role moved before the confirm is refused (bound to its content); so is one that would now break putRole's rules", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const bob = await open(who.userId, d, n);
    const hub = await hubOf(who.userId);
    const first = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const page = await (await get(first.secret, { cookie: who.cookie })).text();
    // The member sets the role on the dashboard meanwhile, to Bob.
    expect((await hub.putRole(n, "lead", bob.id)).ok).toBe(true);
    const r = await post(first.secret, { cookie: who.cookie }, [
      ["csrf", csrfOf(page)],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("The role changed");
    expect((await roles(who.userId))[0]?.agentId).toBe(bob.id);
    expect((await proposals(who.userId))[0]).toMatchObject({
      status: "refused",
      reason: "changed",
    });
    // A re-point whose new holder closes before the confirm.
    const re = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    d.send({ v: 1, id: "dn1", type: "agent_down", agent_ref: alice.ref });
    d.send({ v: 1, id: "l1", type: "list", from_ref: bob.ref });
    await waitFor(d, "roster");
    expect((await get(re.secret, { cookie: who.cookie })).status).toBe(409);
    const r2 = await post(re.secret, { cookie: who.cookie }, [
      ["csrf", await forgedCsrf(who.userId, re.secret)],
      ["decision", "confirm"],
    ]);
    expect(r2.status).toBe(409);
    expect((await roles(who.userId))[0]?.agentId).toBe(bob.id);
    expect((await proposals(who.userId))[0]).toMatchObject({
      status: "refused",
      reason: "agent_not_open",
    });
    d.close();
  });

  it("caps pending proposals per member", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const c = await connect(pat, { env: E() });
    for (let i = 0; i < BUS_ROLE_PROPOSALS_PENDING_MAX; i++)
      expect(
        (
          await tool(c, "bus_role_propose", {
            action: "set",
            namespace: n,
            name: `lead-${i}`,
            agent: alice.name,
          })
        ).isError,
      ).toBeFalsy();
    const over = await tool(c, "bus_role_propose", {
      action: "set",
      namespace: n,
      name: "one-more",
      agent: alice.name,
    });
    expect(textOf(over)).toMatch(/^conflict: Too many role changes/);
    await c.close();
    d.close();
  });

  it("every proposal, confirm, refusal and expiry is audited, ids and enums only", async () => {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const mk = async (name: string) =>
      proposed(
        await propose(pat, {
          action: "set",
          namespace: n,
          name,
          agent: alice.name,
        }),
      );
    const a = await mk("lead-a");
    const b = await mk("lead-b");
    const c = await mk("lead-c");
    expect((await confirmInBrowser(who.cookie, a.secret)).status).toBe(200);
    expect(
      (await confirmInBrowser(who.cookie, b.secret, "reject")).status,
    ).toBe(200);
    // A reuse is a refusal too.
    expect(
      (
        await post(a.secret, { cookie: who.cookie }, [
          ["csrf", await forgedCsrf(who.userId, a.secret)],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(410);
    await runInDurableObject(await hubOf(who.userId), (_: BusHub, s) => {
      s.storage.sql.exec(
        "update role_proposals set expires_at = 1 where id = ?",
        c.proposal.id,
      );
    });
    // The dashboard's read notices the expiry.
    const listed = (await (
      await api(app, R.busRoles, who.cookie)
    ).json()) as BusRoles;
    expect(listed.proposals.map((x) => [x.name, x.status])).toEqual([
      ["lead-c", "expired"],
      ["lead-b", "refused"],
      ["lead-a", "applied"],
    ]);
    const rows = await auditRows(who.userId);
    // Rows in the same millisecond have no order: compare them sorted.
    const sorted = (xs: unknown[][]) => xs.map((x) => JSON.stringify(x)).sort();
    expect(
      sorted(
        rows.map((r) => [
          r.action,
          r.actor_kind,
          r.actor_cred_kind,
          JSON.parse(r.detail).proposalId,
          JSON.parse(r.detail).why ?? null,
        ]),
      ),
    ).toEqual(
      sorted([
        ["bus.role.proposed", "user", "pat", a.proposal.id, null],
        ["bus.role.proposed", "user", "pat", b.proposal.id, null],
        ["bus.role.proposed", "user", "pat", c.proposal.id, null],
        ["bus.role.confirmed", "user", "session", a.proposal.id, null],
        ["bus.role.refused", "user", "session", b.proposal.id, "rejected"],
        ["bus.role.refused", "user", "session", a.proposal.id, "used"],
        ["bus.role.expired", "system", "system", c.proposal.id, null],
      ]),
    );
    for (const r of rows) {
      expect(r.target_type).toBe("user");
      expect(r.detail).not.toContain(n);
      expect(r.detail).not.toContain("lead-");
      expect(r.detail).not.toContain(a.secret);
    }
    const first = rows.find((r) => r.detail.includes(a.proposal.id));
    expect(JSON.parse(first?.detail ?? "{}")).toEqual({
      proposalId: a.proposal.id,
      action: "set",
      agentId: alice.id,
    });
    // Through the audit API too (an admin's view).
    const admin = await member("admin");
    const log = (await (await api(app, R.audit, admin.cookie)).json()) as {
      items: { action: string; target: { id: string } }[];
    };
    expect(
      log.items.filter(
        (i) => i.target.id === who.userId && i.action.startsWith("bus.role."),
      ),
    ).toHaveLength(7);
    d.close();
  });

  it("no bus: no_bus before a machine connected; bus off or hosted: no tool and no confirm page", async () => {
    const m = await member();
    const pat = (await createPat(env, m.userId, "agent")).token;
    const r = await propose(pat, {
      action: "set",
      namespace: ns("rp"),
      name: "lead",
      agent: "x",
    });
    expect(textOf(r)).toMatch(/^conflict: Connect a machine/);
    for (const over of [{ BUS_HUB: undefined }, { HOSTED: "1" }]) {
      const c = await connect(pat, { env: E(over) });
      expect((await c.listTools()).tools.map((t) => t.name)).not.toContain(
        "bus_role_propose",
      );
      await c.close();
      const page = await fetchAndWait(
        app,
        new Request(`${APP}${path("A".repeat(43))}`, {
          headers: { cookie: m.cookie },
        }),
        E(over),
      );
      expect(page.status).toBe(404);
    }
  });
});

/** A session cookie for `uid` signed at `iat` (ms), as `provider`, with Google's forced-reauth time. */
async function sessionAt(
  uid: string,
  iat: number,
  provider: "access" | "google" | "code",
  authAt?: number,
): Promise<string> {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(uid)
    .first<{ e: number }>();
  return `${sessionCookieName(env)}=${await signSession(env, uid, iat, {
    provider,
    epoch: row?.e ?? 0,
    // A code session in the verified domains (outside them it is capped).
    ...(provider === "code" ? { tenant: "x.com" } : {}),
    ...(authAt !== undefined ? { authAt } : {}),
  })}`;
}

const MIN = 60_000;
/** Email codes on (and no Google), so a code session in x.com is a session at all. */
const CODES = trial({ AUTH_DOMAINS: "x.com" });
const envOf = (provider: string) => (provider === "code" ? CODES : env);

describe("role proposals: a fresh sign-in, bound names (#1372 review)", () => {
  async function pending() {
    const { who, d, pat } = await withBus();
    const n = ns("rp");
    const alice = await open(who.userId, d, n);
    const p = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    return { who, d, pat, n, alice, p };
  }

  it("a sign-in older than 10 minutes can neither load nor post the form; the page asks for a forced sign-in", async () => {
    const { who, d, p } = await pending();
    const csrf = await forgedCsrf(who.userId, p.secret);
    const next = encodeURIComponent(path(p.secret));
    for (const [provider, link] of [
      ["access", `/auth/login?via=access&amp;reauth=1&amp;next=${next}`],
      ["code", `/sign-in?next=${next}`],
      ["google", `/auth/login/google?reauth=1&amp;next=${next}`],
    ] as const) {
      const old = await sessionAt(
        who.userId,
        Date.now() - 11 * MIN,
        provider,
        Date.now() - 11 * MIN,
      );
      const g = await get(p.secret, { cookie: old }, envOf(provider));
      expect(g.status, provider).toBe(403);
      const body = await g.text();
      expect(body, provider).not.toContain('name="csrf"');
      expect(body, provider).toContain(link);
      const r = await post(
        p.secret,
        { cookie: old },
        [
          ["csrf", csrf],
          ["decision", "confirm"],
        ],
        envOf(provider),
      );
      expect(r.status, provider).toBe(403);
    }
    expect(await roles(who.userId)).toEqual([]);
    expect((await proposals(who.userId))[0]?.status).toBe("pending");
    d.close();
  });

  it("Google: a fresh session also needs a forced re-authentication (auth_time) under 10 minutes", async () => {
    const { who, d, p } = await pending();
    const now = Date.now();
    const silent = await sessionAt(who.userId, now - MIN, "google");
    expect((await get(p.secret, { cookie: silent })).status).toBe(403);
    const stale = await sessionAt(
      who.userId,
      now - MIN,
      "google",
      now - 11 * MIN,
    );
    expect((await get(p.secret, { cookie: stale })).status).toBe(403);
    const forced = await sessionAt(who.userId, now - MIN, "google", now - MIN);
    expect((await confirmInBrowser(forced, p.secret)).status).toBe(200);
    expect(await roles(who.userId)).toHaveLength(1);
    d.close();
  });

  it("a sign-in under 10 minutes old with its re-auth marker confirms (Access, an email code); without the marker it is refused", async () => {
    for (const provider of ["access", "code"] as const) {
      const { who, d, p } = await pending();
      const at = Date.now() - 9 * MIN;
      const bare = await sessionAt(who.userId, at, provider);
      expect(
        (await get(p.secret, { cookie: bare }, envOf(provider))).status,
        provider,
      ).toBe(403);
      const fresh = await sessionAt(who.userId, at, provider, at);
      expect(
        (await confirmInBrowser(fresh, p.secret, "confirm", envOf(provider)))
          .status,
        provider,
      ).toBe(200);
      expect(await roles(who.userId), provider).toHaveLength(1);
      d.close();
    }
  });

  it("the forced sign-in: Access is asked for prompt=login and max_age=0; a plain sign-in isn't", async () => {
    const at = async (q: string) =>
      new URL(
        (
          await fetchAndWait(app, new Request(`${APP}/auth/login?${q}`))
        ).headers.get("location") ?? "",
      ).searchParams;
    const forced = await at("reauth=1&next=%2Fbus");
    expect(forced.get("prompt")).toBe("login");
    expect(forced.get("max_age")).toBe("0");
    const plain = await at("next=%2Fbus");
    expect(plain.get("prompt")).toBeNull();
    expect(plain.get("max_age")).toBeNull();
  });

  it("shows the names as proposed, and refuses `changed` when either agent was renamed before the confirm", async () => {
    // The new holder renames itself after proposing.
    {
      const { who, d, alice, p } = await pending();
      const page = await (await get(p.secret, { cookie: who.cookie })).text();
      d.send({
        v: 1,
        id: "rn-a",
        type: "rename",
        agent_ref: alice.ref,
        proposed_name: uniq("owner-contact"),
      });
      await waitFor(d, "renamed");
      // The page and the list keep the name the proposal was made with.
      expect((await proposals(who.userId))[0]?.agentName).toBe(alice.name);
      const view = await get(p.secret, { cookie: who.cookie });
      expect(view.status).toBe(409);
      const r = await post(p.secret, { cookie: who.cookie }, [
        ["csrf", csrfOf(page)],
        ["decision", "confirm"],
      ]);
      expect(r.status).toBe(409);
      expect(await r.text()).toContain("The role changed");
      expect(await roles(who.userId)).toEqual([]);
      expect((await proposals(who.userId))[0]).toMatchObject({
        status: "refused",
        reason: "changed",
      });
      d.close();
    }
    // The displaced holder renames itself after proposing.
    {
      const { who, d, pat, n, alice } = await pending();
      const bob = await open(who.userId, d, n);
      expect(
        (await (await hubOf(who.userId)).putRole(n, "boss", alice.id)).ok,
      ).toBe(true);
      const re = proposed(
        await propose(pat, {
          action: "set",
          namespace: n,
          name: "boss",
          agent: bob.name,
        }),
      );
      expect(re.proposal.priorHolderName).toBe(alice.name);
      d.send({
        v: 1,
        id: "rn-b",
        type: "rename",
        agent_ref: alice.ref,
        proposed_name: uniq("moved"),
      });
      await waitFor(d, "renamed");
      const r = await post(re.secret, { cookie: who.cookie }, [
        ["csrf", await forgedCsrf(who.userId, re.secret)],
        ["decision", "confirm"],
      ]);
      expect(r.status).toBe(409);
      expect(
        (await roles(who.userId)).find((x) => x.name === "boss")?.agentId,
      ).toBe(alice.id);
      d.close();
    }
  });

  it("a re-point bound to its holder: re-pointed elsewhere after the proposal, the confirm is refused `changed`", async () => {
    const { who, d, pat, n, alice } = await pending();
    const bob = await open(who.userId, d, n);
    const carol = await open(who.userId, d, n);
    const hub = await hubOf(who.userId);
    expect((await hub.putRole(n, "boss", alice.id)).ok).toBe(true);
    const re = proposed(
      await propose(pat, {
        action: "set",
        namespace: n,
        name: "boss",
        agent: bob.name,
      }),
    );
    expect(re.proposal.action).toBe("repoint");
    // The member re-points it to Carol on the dashboard meanwhile.
    expect((await hub.putRole(n, "boss", carol.id)).ok).toBe(true);
    const r = await post(re.secret, { cookie: who.cookie }, [
      ["csrf", await forgedCsrf(who.userId, re.secret)],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(409);
    expect(
      (await roles(who.userId)).find((x) => x.name === "boss")?.agentId,
    ).toBe(carol.id);
    expect(
      (await proposals(who.userId)).find((x) => x.id === re.proposal.id),
    ).toMatchObject({ status: "refused", reason: "changed" });
    d.close();
  });

  it("a cross-site POST is refused before anything is read; the page sends no referrer", async () => {
    const { who, d, p } = await pending();
    const r = await post(
      p.secret,
      { cookie: who.cookie, "sec-fetch-site": "cross-site" },
      [
        ["csrf", await forgedCsrf(who.userId, p.secret)],
        ["decision", "confirm"],
      ],
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("Cross-site request");
    expect(await roles(who.userId)).toEqual([]);
    const g = await get(p.secret, { cookie: who.cookie });
    expect(g.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    d.close();
  });
});

describe("role proposals: the forced sign-in marker, through the real sign-in (#1372 re-review)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A member signed in through Access (fake IdP), with a pending proposal. */
  async function viaAccess(reauth: boolean) {
    const email = `rp-${uniq("acc")}@x.com`;
    const who = await login(email);
    const bus = await withBus(who);
    const n = ns("rp");
    const alice = await open(who.userId, bus.d, n);
    const p = proposed(
      await propose(bus.pat, {
        action: "set",
        namespace: n,
        name: "lead",
        agent: alice.name,
      }),
    );
    const cb = await accessSignIn(email, { reauth, next: path(p.secret) });
    expect(cb.status).toBe(302);
    const set = cb.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${sessionCookieName(env)}=`));
    if (!set) throw new Error("no session cookie");
    return { who, d: bus.d, p, cookie: set.split(";")[0] as string };
  }

  it("a plain Access sign-in (silent SSO, no reauth=1) is refused at confirm", async () => {
    const { who, d, p, cookie } = await viaAccess(false);
    const g = await get(p.secret, { cookie });
    expect(g.status).toBe(403);
    expect(await g.text()).toContain("reauth=1");
    const r = await post(p.secret, { cookie }, [
      ["csrf", await forgedCsrf(who.userId, p.secret)],
      ["decision", "confirm"],
    ]);
    expect(r.status).toBe(403);
    expect(await roles(who.userId)).toEqual([]);
    d.close();
  });

  it("an Access sign-in with reauth=1 confirms", async () => {
    const { who, d, p, cookie } = await viaAccess(true);
    expect((await confirmInBrowser(cookie, p.secret)).status).toBe(200);
    expect(await roles(who.userId)).toHaveLength(1);
    d.close();
  });
});
