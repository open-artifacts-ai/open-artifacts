// #1346 reach proposals: the agent holding a role asks, with its machine's
// token (POST R.busReachProposals), that the role reach other namespaces. It
// grants nothing: the member confirms the one-time link in a browser
// (/bus/reach/confirm), with the role confirm page's checks. No agent
// credential proposes with anything but a machine token, and none confirms.
// The role confirm card lists a role's reach, so a re-point can't hand it
// over unseen.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  BUS_REACH_MAX,
  BUS_REACH_PER_ROLE,
  BUS_REACH_PROPOSAL_TTL_MS,
  BUS_REACH_PROPOSALS_PENDING_MAX,
  BUS_REACH_PROPOSALS_PER_MACHINE_HOUR,
  type BusReachProposed,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import type { BusHub } from "../../src/bus/hub.js";
import { OWNER_ORG_ID } from "../../src/bus/hub.js";
import { REACH_CONFIRM_SCOPE } from "../../src/bus/reach-confirm.js";
import { ROLE_CONFIRM_SCOPE } from "../../src/bus/role-confirm.js";
import { migrateHub } from "../../src/bus/schema.js";
import { formCsrf } from "../../src/http/pages.js";
import { revokeBusMachine } from "../../src/services/bus.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { errOf, fetchAndWait } from "../helpers.js";
import { confirmBrowser } from "./confirm-browser.js";
import {
  type Daemon,
  daemon,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const runInHub = async <T>(uid: string, fn: (s: DurableObjectState) => T) =>
  runInDurableObject(await hubOf(uid), (_: BusHub, s: DurableObjectState) =>
    fn(s),
  );

const app = createApp();
const APP = "http://app.localhost";

async function sessionAt(uid: string, iat: number, authAt?: number) {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(uid)
    .first<{ e: number }>();
  return `${sessionCookieName(env)}=${await signSession(env, uid, iat, {
    provider: "access",
    epoch: row?.e ?? 0,
    ...(authAt !== undefined ? { authAt } : {}),
  })}`;
}

async function hello(token: string, label: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: label,
    client_version: "0.0.0",
  });
  await waitFor(d, "hello_ok");
  return d;
}

/** A member (with a freshly signed-in browser) and a connected machine. */
async function withBus() {
  const base = await member();
  const now = Date.now();
  const cookie = await sessionAt(base.userId, now, now);
  const mach = await machine("MacBook", base.userId);
  const d = await hello(mach.token, "MacBook");
  return {
    userId: base.userId,
    cookie,
    d,
    machineToken: mach.token,
    machineId: mach.id,
  };
}
type Bus = Awaited<ReturnType<typeof withBus>>;

let refSeq = 0;
/** Opens an agent in `namespace` on `d`; returns its native ref (the agent_ref), name and id. */
async function open(uid: string, d: Daemon, namespace: string) {
  const ref = `rr${++refSeq}-${Date.now()}`;
  d.send(
    up(`u${refSeq}`, ref, `agent-${refSeq}-${Date.now() % 1e6}`, namespace),
  );
  const ok = await waitFor(d, "agent_ok");
  const a = (await (await hubOf(uid)).snapshot()).agents.find(
    (x) => x.name === ok.bus_name,
  );
  if (!a) throw new Error("agent not listed");
  return { ref, name: ok.bus_name, id: a.id };
}

/** An agent holding role `role` in a fresh namespace. */
async function holder(b: Bus, role = "lead") {
  const home = ns("home");
  const agent = await open(b.userId, b.d, home);
  const r = await (await hubOf(b.userId)).putRole(home, role, agent.id);
  if (!r.ok) throw new Error(`role not set: ${r.reason}`);
  return { home, agent, role };
}

const propose = (
  auth: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.busReachProposals}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const proposed = async (r: Response) => {
  expect(r.status, await r.clone().text()).toBe(200);
  const sc = (await r.json()) as BusReachProposed;
  const m = /\/bus\/reach\/confirm#([A-Za-z0-9_-]{43})$/.exec(sc.confirmUrl);
  if (!m?.[1]) throw new Error(`no confirm link: ${sc.confirmUrl}`);
  return { ...sc, secret: m[1] };
};

const BASE = "/bus/reach/confirm";
const browser = confirmBrowser(app, APP, BASE);
const get = (secret: string, headers: Record<string, string>) =>
  browser.get(secret, headers, env);
const post = (
  secret: string,
  headers: Record<string, string>,
  fields: [string, string][],
) => browser.post(secret, headers, fields, env);
const csrfOf = (body: string) => {
  const m = /name="csrf" value="([^"]+)"/.exec(body);
  if (!m?.[1]) throw new Error("no csrf field on the page");
  return m[1];
};
async function confirmInBrowser(
  cookie: string,
  secret: string,
  decision: "confirm" | "reject" = "confirm",
) {
  const page = await get(secret, { cookie });
  expect(page.status).toBe(200);
  return post(secret, { cookie }, [
    ["csrf", csrfOf(await page.text())],
    ["decision", decision],
  ]);
}

/** The card's own POST without loading the card first (the view refuses a stale proposal; the decide step must too). */
async function decideDirect(b: Bus, secret: string) {
  return post(secret, { cookie: b.cookie }, [
    [
      "csrf",
      await formCsrf(
        env,
        REACH_CONFIRM_SCOPE,
        b.userId,
        await sha256Hex(secret),
      ),
    ],
    ["decision", "confirm"],
  ]);
}

const grants = async (uid: string) => (await hubOf(uid)).listReach();
const grantRows = (uid: string) =>
  runInHub(uid, (s) =>
    s.storage.sql
      .exec<{
        target_ns: string;
        granted_by: string;
        machine_id: string | null;
      }>(
        "select target_ns, granted_by, machine_id from reach_grants order by target_ns",
      )
      .toArray(),
  );

type AuditRow = {
  action: string;
  actor_kind: string;
  actor_id: string | null;
  target_id: string;
  detail: string;
};
const auditRows = async (uid: string) =>
  (
    await env.DB.prepare(
      "select action, actor_kind, actor_id, target_id, detail from audit_events where target_id = ? and action like 'bus.reach.%' order by at",
    )
      .bind(uid)
      .all<AuditRow>()
  ).results;

describe("reach proposals (#1346)", () => {
  it("a machine token proposes and grants nothing; the member confirms once in a browser; the grant is audited", async () => {
    const b = await withBus();
    const { home, agent } = await holder(b);
    const [x, y] = [ns("rx"), ns("ry")];
    const before = Date.now();
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [y, x],
      }),
    );
    // The response carries the URL and its expiry, nothing about the grant.
    expect(Object.keys(p).sort()).toEqual([
      "confirmUrl",
      "expiresAt",
      "secret",
    ]);
    const ttl = Date.parse(p.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(BUS_REACH_PROPOSAL_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(BUS_REACH_PROPOSAL_TTL_MS + 5_000);
    // Proposed: nothing applied yet.
    expect(await grants(b.userId)).toEqual([]);

    // Viewing the card applies nothing either, and it lists the reach.
    const page = await get(p.secret, { cookie: b.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("lead");
    expect(html).toContain(home);
    expect(html).toContain(agent.name);
    expect(html).toContain(x);
    expect(html).toContain(y);
    expect(html).toMatch(/can message agents in[\s\S]*They can reply/);
    expect(await grants(b.userId)).toEqual([]);

    const done = await post(p.secret, { cookie: b.cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("can now message agents in");
    expect((await grants(b.userId)).map((g) => g.namespace).sort()).toEqual(
      [x, y].sort(),
    );
    // Provenance: it came from a request, by this machine.
    expect(await grantRows(b.userId)).toEqual(
      [x, y].sort().map((t) => ({
        target_ns: t,
        granted_by: "request",
        machine_id: b.machineId,
      })),
    );

    // One use: the same form again, or a fresh load, is refused.
    const again = await post(p.secret, { cookie: b.cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(again.status).toBe(410);
    expect((await get(p.secret, { cookie: b.cookie })).status).toBe(410);

    // Audit: proposed, confirmed, then the replay refused. Ids and enums only.
    const rows = await auditRows(b.userId);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "bus.reach.confirmed",
      "bus.reach.proposed",
      "bus.reach.refused",
    ]);
    const refusedRow = rows.find((r) => r.action === "bus.reach.refused");
    for (const r of rows) {
      expect(r.actor_kind).toBe("user");
      expect(r.actor_id).toBe(b.userId);
      const d = JSON.parse(r.detail) as Record<string, string>;
      expect(Object.keys(d).sort()).toEqual(
        r.action === "bus.reach.refused"
          ? ["agentId", "machineId", "proposalId", "roleId", "why"]
          : ["agentId", "machineId", "proposalId", "roleId"],
      );
      expect(d.agentId).toBe(agent.id);
      expect(d.machineId).toBe(b.machineId);
      expect(r.detail).not.toContain(home);
      expect(r.detail).not.toContain(x);
      expect(r.detail).not.toContain(p.secret);
    }
    expect(JSON.parse(refusedRow?.detail ?? "{}").why).toBe("used");
    b.d.close();
  });

  it("rejecting grants nothing, ends the link and is audited as refused", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("j")],
      }),
    );
    const r = await confirmInBrowser(b.cookie, p.secret, "reject");
    expect(r.status).toBe(200);
    expect(await grants(b.userId)).toEqual([]);
    expect((await get(p.secret, { cookie: b.cookie })).status).toBe(410);
    const rows = await auditRows(b.userId);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "bus.reach.proposed",
      "bus.reach.refused",
    ]);
    expect(
      JSON.parse(
        rows.find((r) => r.action === "bus.reach.refused")?.detail ?? "{}",
      ).why,
    ).toBe("rejected");
    b.d.close();
  });

  it("only a machine token proposes: a PAT, a cookie, no credential or a revoked machine is 401; the body is checked", async () => {
    const b = await withBus();
    const { home, agent } = await holder(b);
    const t = ns("t");
    const body = { nativeRef: agent.ref, namespaces: [t] };
    const pat = (await createPat(env, b.userId, "agent")).token;
    expect((await propose(pat, body)).status).toBe(401);
    expect((await propose(null, body)).status).toBe(401);
    expect([401, 403]).toContain(
      (await propose(null, body, { cookie: b.cookie })).status,
    );
    expect((await propose("oa_machine_nope", body)).status).toBe(401);
    for (const bad of [
      {},
      { namespaces: [t] },
      { nativeRef: agent.ref },
      { nativeRef: "", namespaces: [t] },
      { nativeRef: agent.ref, namespaces: [] },
      { nativeRef: agent.ref, namespaces: ["Not Canonical"] },
      { nativeRef: agent.ref, namespaces: [home] }, // its own namespace
      {
        nativeRef: agent.ref,
        namespaces: Array.from({ length: BUS_REACH_PER_ROLE + 1 }, () =>
          ns("m"),
        ),
      },
      { ...body, role: "lead" }, // the role is never named by the caller
      { ...body, extra: 1 },
    ])
      expect(
        (await propose(b.machineToken, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    await env.DB.prepare(
      "update bus_machines set revoked_at = ? where user_id = ?",
    )
      .bind(Date.now(), b.userId)
      .run();
    expect((await propose(b.machineToken, body)).status).toBe(401);
    b.d.close();
  });

  it("the role is the one the hub finds the agent holding: no role, an unknown agent, another machine's agent and several roles are 409", async () => {
    const b = await withBus();
    const home = ns("nr");
    const bare = await open(b.userId, b.d, home);
    const t = [ns("t")];
    const refused = async (ref: string, token = b.machineToken) => {
      const r = await propose(token, { nativeRef: ref, namespaces: t });
      expect(r.status).toBe(409);
      return (await errOf(r)).details;
    };
    expect(await refused(bare.ref)).toEqual({ reason: "no_role" });
    expect(await refused("never-seen")).toEqual({ reason: "no_role" });
    // Another machine of the same member can't ask for this machine's agent.
    const { agent } = await holder(b);
    const other = await machine("Other", b.userId);
    const od = await hello(other.token, "Other");
    expect(await refused(agent.ref, other.token)).toEqual({
      reason: "no_role",
    });
    // A role pointing at a moved agent is vacant: no reach to ask for.
    const hub = await hubOf(b.userId);
    const two = await open(b.userId, b.d, home);
    expect((await hub.putRole(home, "second", two.id)).ok).toBe(true);
    expect((await hub.putRole(home, "third", two.id)).ok).toBe(true);
    expect(await refused(two.ref)).toEqual({ reason: "ambiguous" });
    expect(await grants(b.userId)).toEqual([]);
    b.d.close();
    od.close();
  });

  it("no agent credential confirms: a machine token or a PAT, with or without the member's cookie; another member finds nothing", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("c")],
      }),
    );
    const pat = (await createPat(env, b.userId, "agent")).token;
    const csrf = await formCsrf(
      env,
      REACH_CONFIRM_SCOPE,
      b.userId,
      await sha256Hex(p.secret),
    );
    for (const token of [b.machineToken, pat])
      for (const withCookie of [false, true]) {
        const h = {
          authorization: `Bearer ${token}`,
          ...(withCookie ? { cookie: b.cookie } : {}),
        };
        const g = await get(p.secret, h);
        expect([401, 302, 404]).toContain(g.status);
        const r = await post(p.secret, h, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ]);
        expect([401, 403, 404]).toContain(r.status);
      }
    expect(await grants(b.userId)).toEqual([]);
    const other = await member();
    const oc = await sessionAt(other.userId, Date.now(), Date.now());
    expect((await get(p.secret, { cookie: oc })).status).toBe(404);
    expect(await grants(b.userId)).toEqual([]);
    b.d.close();
  });

  it("another member's session can't decide this URL; a role-scope form token is refused", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("k")],
      }),
    );
    const o = await withBus();
    const oCsrf = await formCsrf(
      env,
      REACH_CONFIRM_SCOPE,
      o.userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie: o.cookie }, [
          ["csrf", oCsrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(404);
    const roleCsrf = await formCsrf(
      env,
      ROLE_CONFIRM_SCOPE,
      b.userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie: b.cookie }, [
          ["csrf", roleCsrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    expect(await grants(b.userId)).toEqual([]);
    expect(await grants(o.userId)).toEqual([]);
    b.d.close();
    o.d.close();
  });

  it("a stale session, a missing, foreign or other-link form token and a cross-site post can't confirm", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("s")],
      }),
    );
    const old = Date.now() - 11 * 60_000;
    const stale = await sessionAt(b.userId, old, old);
    const g = await get(p.secret, { cookie: stale });
    expect(g.status).toBe(403);
    expect(await g.text()).toContain("Sign in again");
    const csrf = await formCsrf(
      env,
      REACH_CONFIRM_SCOPE,
      b.userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie: stale }, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    expect(
      (await post(p.secret, { cookie: b.cookie }, [["decision", "confirm"]]))
        .status,
    ).toBe(403);
    expect(
      (
        await post(p.secret, { cookie: b.cookie }, [
          ["csrf", `1.${"A".repeat(43)}`],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    const otherLink = await formCsrf(
      env,
      REACH_CONFIRM_SCOPE,
      b.userId,
      await sha256Hex("x".repeat(43)),
    );
    expect(
      (
        await post(p.secret, { cookie: b.cookie }, [
          ["csrf", otherLink],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchAndWait(
          app,
          new Request(`${APP}${BASE}`, {
            method: "POST",
            headers: {
              cookie: b.cookie,
              "sec-fetch-site": "cross-site",
              "content-type": "application/x-www-form-urlencoded",
              "content-length": "0",
            },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(await grants(b.userId)).toEqual([]);
    // The right form still works.
    expect((await confirmInBrowser(b.cookie, p.secret)).status).toBe(200);
    expect(await grants(b.userId)).toHaveLength(1);
    b.d.close();
  });

  it("the card names the machine that proposed, escaped; a namespace never seen on the member's machines is flagged", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const known = ns("known");
    await open(b.userId, b.d, known);
    const never = ns("never");
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [known, never],
      }),
    );
    const html = await (await get(p.secret, { cookie: b.cookie })).text();
    expect(html).toMatch(/Proposed from[\s\S]{0,40}MacBook/);
    const flagged =
      /Never seen on your machines:([\s\S]*?)<\/span><\/div>/.exec(html)?.[1];
    expect(flagged).toContain(never);
    expect(flagged).not.toContain(known);
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec("update machines set label = ?", "<b>evil</b>");
    });
    const h2 = await (await get(p.secret, { cookie: b.cookie })).text();
    expect(h2).not.toContain("<b>evil</b>");
    expect(h2).toContain("&lt;b&gt;evil&lt;/b&gt;");
    b.d.close();
  });

  it("an expired proposal is refused, grants nothing and its expiry is audited once", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("e")],
      }),
    );
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec("update reach_proposals set expires_at = 1");
    });
    const r = await get(p.secret, { cookie: b.cookie });
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("This link expired");
    expect((await get(p.secret, { cookie: b.cookie })).status).toBe(410);
    expect(await grants(b.userId)).toEqual([]);
    // Viewing a spent link audits nothing; the expiry is one row, however often it is looked at.
    expect((await auditRows(b.userId)).map((a) => a.action).sort()).toEqual([
      "bus.reach.expired",
      "bus.reach.proposed",
    ]);
    b.d.close();
  });

  it("the confirm is bound to the role as shown: a re-point, a removal or a rename of the holder since refuses it, applying nothing", async () => {
    const b = await withBus();
    const hub = await hubOf(b.userId);
    const mk = async () => {
      const h = await holder(b);
      const p = await proposed(
        await propose(b.machineToken, {
          nativeRef: h.agent.ref,
          namespaces: [ns("bound")],
        }),
      );
      return { ...h, p };
    };
    // Re-pointed at another agent.
    const a = await mk();
    const other = await open(b.userId, b.d, a.home);
    expect((await hub.putRole(a.home, a.role, other.id)).ok).toBe(true);
    // The card refuses it, and so does the decide step when posted directly.
    expect((await get(a.p.secret, { cookie: b.cookie })).status).toBe(409);
    const r1 = await decideDirect(b, a.p.secret);
    expect(r1.status).toBe(409);
    expect(await r1.text()).toContain("The role changed");
    // Removed.
    const c = await mk();
    const roleId = (await hub.listRoles()).find(
      (r) => r.namespace === c.home,
    )?.id;
    expect(await hub.deleteRole(roleId ?? "")).toBe(true);
    expect((await decideDirect(b, c.p.secret)).status).toBe(409);
    // The holder renamed since the member was shown its name.
    const d2 = await mk();
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec(
        "update agents set name = 'renamed-' || name where id = ?",
        d2.agent.id,
      );
    });
    expect((await decideDirect(b, d2.p.secret)).status).toBe(409);
    expect(await grants(b.userId)).toEqual([]);
    const refused = (await auditRows(b.userId)).filter(
      (r) => r.action === "bus.reach.refused",
    );
    expect(refused.map((r) => JSON.parse(r.detail).why)).toEqual([
      "changed",
      "changed",
      "changed",
    ]);
    b.d.close();
  });

  it("confirming what the role already reaches is a no-op with a clear message; the card says so", async () => {
    const b = await withBus();
    const { home, agent, role } = await holder(b);
    const t = ns("have");
    expect((await (await hubOf(b.userId)).putReach(home, role, t)).ok).toBe(
      true,
    );
    const p = await proposed(
      await propose(b.machineToken, { nativeRef: agent.ref, namespaces: [t] }),
    );
    expect(await (await get(p.secret, { cookie: b.cookie })).text()).toContain(
      "already reaches all of these",
    );
    const r = await confirmInBrowser(b.cookie, p.secret);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Nothing changed");
    // The member's own grant is untouched: still theirs, not the request's.
    expect((await grantRows(b.userId)).map((g) => g.granted_by)).toEqual([
      "member",
    ]);
    b.d.close();
  });

  it("the limits hold at confirm: a role at its share is refused whole, applying none of the proposal", async () => {
    const b = await withBus();
    const { home, agent, role } = await holder(b);
    const hub = await hubOf(b.userId);
    for (let i = 0; i < BUS_REACH_PER_ROLE - 1; i++)
      expect((await hub.putReach(home, role, ns("fill"))).ok).toBe(true);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("n1"), ns("n2")],
      }),
    );
    const r = await get(p.secret, { cookie: b.cookie });
    expect(r.status).toBe(409);
    const r2 = await decideDirect(b, p.secret);
    expect(r2.status).toBe(409);
    expect(await grants(b.userId)).toHaveLength(BUS_REACH_PER_ROLE - 1);
    b.d.close();
  });

  it("at most 10 are pending per member, and 10 per machine per hour", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const one = (token: string, ref: string) =>
      propose(token, { nativeRef: ref, namespaces: [ns("l")] });
    const second = await machine("Second", b.userId);
    const d2 = await hello(second.token, "Second");
    const home2 = ns("home2");
    const agent2 = await open(b.userId, d2, home2);
    expect(
      (await (await hubOf(b.userId)).putRole(home2, "lead", agent2.id)).ok,
    ).toBe(true);
    for (let i = 0; i < BUS_REACH_PROPOSALS_PENDING_MAX; i++)
      expect((await one(b.machineToken, agent.ref)).status).toBe(200);
    const full = await one(second.token, agent2.ref);
    expect(full.status).toBe(409);
    expect((await errOf(full)).details).toEqual({ reason: "proposal_limit" });
    expect(BUS_REACH_PROPOSALS_PER_MACHINE_HOUR).toBe(10);
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec(
        "update reach_proposals set status = 'refused', decided_at = ?",
        Date.now(),
      );
    });
    const rl = await one(b.machineToken, agent.ref);
    expect(rl.status).toBe(409);
    expect((await errOf(rl)).details).toEqual({ reason: "rate_limited" });
    expect((await one(second.token, agent2.ref)).status).toBe(200);
    b.d.close();
    d2.close();
  });

  it("a revoked machine's pending proposals can no longer be confirmed, and each expiry is audited", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const other = await machine("Other", b.userId);
    const od = await hello(other.token, "Other");
    const home2 = ns("home2");
    const agent2 = await open(b.userId, od, home2);
    expect(
      (await (await hubOf(b.userId)).putRole(home2, "lead", agent2.id)).ok,
    ).toBe(true);
    const mine = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("v")],
      }),
    );
    const theirs = await proposed(
      await propose(other.token, {
        nativeRef: agent2.ref,
        namespaces: [ns("w")],
      }),
    );
    // The real revoke (D1 and the hub), not a direct write.
    expect(await revokeBusMachine(env, b.userId, b.machineId)).toBe(true);
    expect((await get(mine.secret, { cookie: b.cookie })).status).toBe(410);
    expect((await confirmInBrowser(b.cookie, theirs.secret)).status).toBe(200);
    expect(await grants(b.userId)).toHaveLength(1);
    const rows = await auditRows(b.userId);
    const expired = rows.filter((r) => r.action === "bus.reach.expired");
    expect(expired).toHaveLength(1);
    expect(JSON.parse(expired[0]?.detail ?? "{}")).toMatchObject({
      why: "machine_revoked",
      machineId: b.machineId,
    });
    expect(expired[0]?.actor_kind).toBe("system");
    b.d.close();
    od.close();
  });

  it("revoking a machine frees its pending proposals from the limit at the next proposal, audited machine_revoked, with no page view", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const other = await machine("Other", b.userId);
    const od = await hello(other.token, "Other");
    const home2 = ns("home2");
    const agent2 = await open(b.userId, od, home2);
    expect(
      (await (await hubOf(b.userId)).putRole(home2, "lead", agent2.id)).ok,
    ).toBe(true);
    const one = (token: string, ref: string) =>
      propose(token, { nativeRef: ref, namespaces: [ns("q")] });
    for (let i = 0; i < BUS_REACH_PROPOSALS_PENDING_MAX; i++)
      expect((await one(b.machineToken, agent.ref)).status).toBe(200);
    expect((await one(other.token, agent2.ref)).status).toBe(409);
    expect(await revokeBusMachine(env, b.userId, b.machineId)).toBe(true);
    expect((await one(other.token, agent2.ref)).status).toBe(200);
    const expired = (await auditRows(b.userId)).filter(
      (r) => r.action === "bus.reach.expired",
    );
    expect(expired).toHaveLength(BUS_REACH_PROPOSALS_PENDING_MAX);
    for (const r of expired)
      expect(JSON.parse(r.detail)).toMatchObject({
        why: "machine_revoked",
        machineId: b.machineId,
      });
    b.d.close();
    od.close();
  });

  it("the hub-wide limit holds at view and confirm: nothing is applied past BUS_REACH_MAX", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    await runInHub(b.userId, (s) => {
      for (let i = 0; i < BUS_REACH_MAX; i++)
        s.storage.sql.exec(
          `insert into reach_grants (id, org_id, role_ns, role_name, lname, mode, target_ns, created_at)
           values (?, ?, ?, 'r', ?, 'reach', 't', 1)`,
          `fill${i}`,
          OWNER_ORG_ID,
          `fill.local/${Math.floor(i / 10)}`,
          `r${i % 10}`,
        );
    });
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("over")],
      }),
    );
    expect((await get(p.secret, { cookie: b.cookie })).status).toBe(409);
    expect((await decideDirect(b, p.secret)).status).toBe(409);
    expect(await grantRows(b.userId)).toHaveLength(BUS_REACH_MAX);
    b.d.close();
  });

  it("the holder going away, moving namespace or flipping global between propose and confirm refuses it, applying nothing", async () => {
    const b = await withBus();
    const cases: [string, string][] = [
      ["away", "update agents set live = 0 where id = ?"],
      [
        "moved",
        "update agents set namespace = 'moved.local/elsewhere' where id = ?",
      ],
      ["global", "update agents set global = 1 where id = ?"],
    ];
    for (const [, q] of cases) {
      const h = await holder(b);
      const p = await proposed(
        await propose(b.machineToken, {
          nativeRef: h.agent.ref,
          namespaces: [ns("g")],
        }),
      );
      await runInHub(b.userId, (s) => {
        s.storage.sql.exec(q, h.agent.id);
      });
      expect((await decideDirect(b, p.secret)).status).toBe(409);
    }
    expect(await grants(b.userId)).toEqual([]);
    const why = (await auditRows(b.userId))
      .filter((r) => r.action === "bus.reach.refused")
      .map((r) => JSON.parse(r.detail).why);
    expect(why).toEqual(["changed", "changed", "changed"]);
    b.d.close();
  });

  it("a proposal whose grants fail partway applies none of them: refused as changed", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const good = ns("good");
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [good, ns("other")],
      }),
    );
    // addReach passes for the first namespace, then fails on the second.
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec(
        "update reach_proposals set namespaces = ?",
        JSON.stringify([good, "BAD NS"]),
      );
    });
    const r = await decideDirect(b, p.secret);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("The role changed");
    expect(await grants(b.userId)).toEqual([]);
    const row = await runInHub(b.userId, (s) =>
      s.storage.sql
        .exec<{ status: string; reason: string }>(
          "select status, reason from reach_proposals",
        )
        .toArray(),
    );
    expect(row).toEqual([{ status: "refused", reason: "changed" }]);
    b.d.close();
  });

  it("a proposal that expired is refused by the decide step too, audited as expired then refused", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("x")],
      }),
    );
    await runInHub(b.userId, (s) => {
      s.storage.sql.exec("update reach_proposals set expires_at = 1");
    });
    expect((await decideDirect(b, p.secret)).status).toBe(410);
    expect(await grants(b.userId)).toEqual([]);
    const rows = await auditRows(b.userId);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "bus.reach.expired",
      "bus.reach.proposed",
      "bus.reach.refused",
    ]);
    expect(
      JSON.parse(
        rows.find((r) => r.action === "bus.reach.refused")?.detail ?? "{}",
      ).why,
    ).toBe("expired");
    b.d.close();
  });

  it("if the grant lands but the audit write fails, the page never says nothing changed", async () => {
    const b = await withBus();
    const { agent } = await holder(b);
    const p = await proposed(
      await propose(b.machineToken, {
        nativeRef: agent.ref,
        namespaces: [ns("au")],
      }),
    );
    const page = await get(p.secret, { cookie: b.cookie });
    const csrf = csrfOf(await page.text());
    await env.DB.prepare(
      "alter table audit_events rename to audit_events_x",
    ).run();
    let r: Response;
    try {
      // Raw, as the page's script gets it: the harness's `post` unwraps JSON.
      r = await browser.postJson(
        env,
        "/bus/reach/confirm",
        { cookie: b.cookie },
        {
          secret: p.secret,
          csrf,
          decision: "confirm",
        },
      );
    } finally {
      await env.DB.prepare(
        "alter table audit_events_x rename to audit_events",
      ).run();
    }
    expect(r.status).toBe(500);
    // The page's script renders only JSON ({ html }): raw HTML would show
    // "Nothing changed" in a browser, which is false here.
    expect(r.headers.get("content-type")).toContain("application/json");
    const { html: card } = (await r.json()) as { html: string };
    expect(card).toContain("We could not confirm this finished");
    expect(card).not.toContain("Nothing changed");
    expect(await grants(b.userId)).toHaveLength(1);
    b.d.close();
  });

  it("a hub from before PR 2 (reach_grants without provenance) gains the columns, keeping its rows as the member's", async () => {
    const b = await withBus();
    const n = await runInHub(b.userId, (s) => {
      const sql = s.storage.sql;
      sql.exec("drop table reach_grants");
      sql.exec(`create table reach_grants (
        id text primary key, org_id text not null, role_ns text not null,
        role_name text not null, lname text not null,
        mode text not null default 'reach' check (mode = 'reach'),
        target_ns text not null, created_at integer not null,
        unique (org_id, role_ns, lname, mode, target_ns))`);
      sql.exec(
        "insert into reach_grants values ('g1','o','r','Lead','lead','reach','t',1)",
      );
      migrateHub(sql);
      migrateHub(sql); // idempotent
      return sql
        .exec<{ granted_by: string; machine_id: string | null }>(
          "select granted_by, machine_id from reach_grants",
        )
        .toArray();
    });
    expect(n).toEqual([{ granted_by: "member", machine_id: null }]);
    b.d.close();
  });
});

describe("role confirm card lists the role's reach (#1346 review of PR 2)", () => {
  /** A role with reach, and a role proposal over MCP-free path: seeded in the hub as bus_role_propose does. */
  async function seeded(action: "repoint" | "clear" | "set") {
    const b = await withBus();
    const hub = await hubOf(b.userId);
    const home = ns("rc");
    const alice = await open(b.userId, b.d, home);
    const bob = await open(b.userId, b.d, home);
    const [x, y] = [ns("ra"), ns("rb")];
    const name = "boss";
    if (action !== "set") {
      expect((await hub.putRole(home, name, alice.id)).ok).toBe(true);
      expect((await hub.putReach(home, name, y)).ok).toBe(true);
      expect((await hub.putReach(home, name, x)).ok).toBe(true);
    }
    const secret = "S".repeat(43);
    const r = await hub.proposeRole(
      {
        action: action === "clear" ? "clear" : "set",
        namespace: home,
        name,
        agent: action === "clear" ? null : bob.name,
      },
      await sha256Hex(secret),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return { b, secret, x, y, home };
  }
  const card = async (b: Bus, secret: string) => {
    const bb = confirmBrowser(app, APP, "/bus/roles/confirm");
    return (await bb.get(secret, { cookie: b.cookie }, env)).text();
  };

  it("a re-point lists every namespace the role reaches, so reach can't pass to a new holder unseen", async () => {
    const { b, secret, x, y } = await seeded("repoint");
    const html = await card(b, secret);
    expect(html).toContain("Re-point this role?");
    expect(html).toContain("Its reach goes with the role");
    expect(html).toContain(x);
    expect(html).toContain(y);
    b.d.close();
  });

  it("a removal says the reach goes; a new role shows none", async () => {
    const c = await seeded("clear");
    const html = await card(c.b, c.secret);
    expect(html).toContain("Its reach is removed");
    expect(html).toContain(c.x);
    c.b.d.close();
    const s = await seeded("set");
    const sh = await card(s.b, s.secret);
    expect(sh).toContain("Create this role?");
    expect(sh).not.toContain("reach");
    s.b.d.close();
  });
});
