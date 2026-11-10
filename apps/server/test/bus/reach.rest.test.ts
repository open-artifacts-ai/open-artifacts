// #1346 role reach over REST: GET R.busReach lists the member's grants, PUT
// lets a role reach one more namespace (idempotent), DELETE R.busReachGrant(id)
// removes one. Only the member, in a browser session: a PAT, an OAuth grant or
// a machine token never grants reach, so no AI agent can widen what a role
// reaches. The member's own PUT is the approval (no proposal step here).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  BUS_REACH_MAX,
  BUS_REACH_PER_ROLE,
  type BusReach,
  newId,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { addReach } from "../../src/bus/reach.js";
import { api, errOf, fetchAndWait } from "../helpers.js";
import { limiter } from "../mcp-helpers.js";
import {
  daemon,
  e,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const app = createApp();

/** A member whose machine has connected (so a hub exists for it). */
async function withBus() {
  const who = await member();
  const m = await machine("MacBook", who.userId);
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
  });
  await d.next();
  return { who, d, m };
}

const putReach = (auth: string | null, body: unknown) =>
  api(app, R.busReach, auth, { method: "PUT", body });
const putRole = (auth: string, namespace: string, name: string) =>
  api(app, R.busRoles, auth, {
    method: "PUT",
    body: { namespace, name, agentId: null },
  });
const grant = (ns: string, name: string, target: string) => ({
  role: { namespace: ns, name },
  namespace: target,
});

describe("reach REST (#1346)", () => {
  it("the member grants, lists, regrants idempotently and removes", async () => {
    const [home, a, b] = [ns("rh"), ns("ra"), ns("rb")];
    const { who, d } = await withBus();
    expect((await putRole(who.cookie, home, "Lead")).status).toBe(200);
    const one = await putReach(who.cookie, grant(home, "lead", b));
    expect(one.status).toBe(200);
    const { reach } = (await one.json()) as { reach: BusReach };
    // The role's own spelling, the target and a timestamp; nothing else.
    expect(reach).toMatchObject({
      role: { namespace: home, name: "Lead" },
      namespace: b,
    });
    expect(Object.keys(reach).sort()).toEqual([
      "createdAt",
      "grantedAt",
      "grantedBy",
      "id",
      "known",
      "mode",
      "namespace",
      "role",
      "roleId",
    ]);
    const again = await putReach(who.cookie, grant(home, "Lead", b));
    expect(((await again.json()) as { reach: BusReach }).reach).toEqual(reach);
    const two = (await (
      await putReach(who.cookie, grant(home, "Lead", a))
    ).json()) as { reach: BusReach };
    expect(await (await api(app, R.busReach, who.cookie)).json()).toEqual({
      reach: [two.reach, reach], // by role, then namespace: a before b
      live: true,
    });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await api(app, R.busReachGrant(reach.id), who.cookie, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204);
    expect(await (await api(app, R.busReach, who.cookie)).json()).toEqual({
      reach: [two.reach],
      live: true,
    });
    d.close();
  });

  it("400 for an invalid body, a non-canonical, own or missing target, or a bad role name", async () => {
    const [home, b] = [ns("rh"), ns("rb")];
    const { who, d } = await withBus();
    await putRole(who.cookie, home, "lead");
    for (const body of [
      {},
      { namespace: b },
      { role: { namespace: home, name: "lead" } },
      { ...grant(home, "lead", b), extra: 1 },
      grant(home, "lead", "Not Canonical"),
      grant(home, "lead", home),
      grant(home, "bad name!", b),
      grant("Not Canonical", "lead", b),
      { role: "lead", namespace: b },
    ]) {
      const r = await putReach(who.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await hubOf(who.userId)).listReach()).toEqual([]);
    d.close();
  });

  it("409 role_unknown for a role that does not exist: the member sets the role first", async () => {
    const { who, d } = await withBus();
    const r = await putReach(who.cookie, grant(ns("rh"), "ghost", ns("rb")));
    expect(r.status).toBe(409);
    expect((await errOf(r)).details).toEqual({ reason: "role_unknown" });
    expect(await (await hubOf(who.userId)).listReach()).toEqual([]);
    d.close();
  });

  it("409 reach_limit past BUS_REACH_PER_ROLE for a role and past BUS_REACH_MAX for the member; a regrant at the limit is still fine", async () => {
    const home = ns("rh");
    const { who, d } = await withBus();
    await putRole(who.cookie, home, "lead");
    const targets = Array.from({ length: BUS_REACH_PER_ROLE }, (_, i) =>
      ns(`t${i}`),
    );
    for (const t of targets)
      expect((await putReach(who.cookie, grant(home, "lead", t))).status).toBe(
        200,
      );
    const over = await putReach(who.cookie, grant(home, "lead", ns("over")));
    expect(over.status).toBe(409);
    expect((await errOf(over)).details).toEqual({ reason: "reach_limit" });
    const first = targets[0] ?? "";
    expect(
      (await putReach(who.cookie, grant(home, "lead", first))).status,
    ).toBe(200);
    // The member's total: fill the hub with other roles' rows, then one more.
    const hub = await hubOf(who.userId);
    await runInDurableObject(hub, (_i, state) => {
      const have = state.storage.sql
        .exec<{ n: number }>("select count(*) as n from reach_grants")
        .one().n;
      for (let i = have; i < BUS_REACH_MAX; i++)
        state.storage.sql.exec(
          `insert into reach_grants (id, org_id, role_ns, role_name, lname, mode, target_ns, created_at)
           select ?, org_id, 'fill/ns', ?, ?, 'reach', ?, 1 from reach_grants limit 1`,
          newId(),
          `f${i}`,
          `f${i}`,
          `fill/t${i}`,
        );
    });
    await putRole(who.cookie, ns("other"), "other");
    const full = await putReach(
      who.cookie,
      grant(home, "lead", ns("one-more")),
    );
    expect(full.status).toBe(409);
    expect((await errOf(full)).details).toEqual({ reason: "reach_limit" });
    expect((await hub.listReach()).length).toBe(BUS_REACH_MAX);
    d.close();
  });

  it("the DTO carries the role id, known, mode and who granted it and when; a deleted role reads unknown", async () => {
    const [home, a, b] = [ns("rh"), ns("ra"), ns("rb")];
    const { who, d, m } = await withBus();
    const role = (await (await putRole(who.cookie, home, "Lead")).json()) as {
      role: { id: string };
    };
    const mine = (await (
      await putReach(who.cookie, grant(home, "lead", a))
    ).json()) as { reach: BusReach };
    expect(mine.reach).toMatchObject({
      roleId: role.role.id,
      known: true,
      mode: "reach",
      grantedBy: "member",
    });
    expect(Date.parse(mine.reach.grantedAt)).toBe(
      Date.parse(mine.reach.createdAt),
    );
    // A confirmed agent proposal is recorded by the hub, never by a claim.
    const hub = await hubOf(who.userId);
    await runInDurableObject(hub, (_i, state) => {
      const r = addReach(
        state.storage.sql,
        "owner",
        home,
        "lead",
        b,
        Date.now(),
        newId,
        BUS_REACH_MAX,
        BUS_REACH_PER_ROLE,
        m.id,
      );
      expect(r.ok).toBe(true);
    });
    const list = (await (await api(app, R.busReach, who.cookie)).json()) as {
      reach: BusReach[];
    };
    expect(list.reach.map((g) => [g.namespace, g.grantedBy])).toEqual(
      [
        [a, "member"],
        [b, "request"],
      ].sort(),
    );
    await api(app, `${R.busRoles}/${role.role.id}`, who.cookie, {
      method: "DELETE",
    });
    const gone = (await (await api(app, R.busReach, who.cookie)).json()) as {
      reach: BusReach[];
    };
    for (const g of gone.reach)
      expect(g).toMatchObject({ roleId: null, known: false });
    d.close();
  });

  const setReach = (auth: string | null, body: unknown) =>
    api(app, R.busReachSet, auth, { method: "PUT", body });
  const setBody = (home: string, name: string, namespaces: string[]) => ({
    role: { namespace: home, name },
    namespaces,
  });

  it("set replaces the role's reach set in one call, keeping kept grants and others' grants", async () => {
    const [home, a, b, c, oh] = [
      ns("rh"),
      ns("ra"),
      ns("rb"),
      ns("rc"),
      ns("o"),
    ];
    const { who, d } = await withBus();
    await putRole(who.cookie, home, "lead");
    await putRole(who.cookie, oh, "other");
    const kept = (await (
      await putReach(who.cookie, grant(home, "lead", a))
    ).json()) as { reach: BusReach };
    await putReach(who.cookie, grant(home, "lead", b));
    const other = await putReach(who.cookie, grant(oh, "other", c));
    const o = ((await other.json()) as { reach: BusReach }).reach;
    const r = await setReach(who.cookie, setBody(home, "Lead", [a, c, c]));
    expect(r.status).toBe(200);
    const { reach } = (await r.json()) as { reach: BusReach[] };
    expect(reach.map((g) => g.namespace)).toEqual([a, c].sort());
    expect(reach.find((g) => g.namespace === a)?.id).toBe(kept.reach.id);
    const all = (await (await api(app, R.busReach, who.cookie)).json()) as {
      reach: BusReach[];
    };
    expect(all.reach.map((g) => g.id)).toContain(o.id);
    expect(all.reach).toHaveLength(3);
    const none = await setReach(who.cookie, setBody(home, "lead", []));
    expect(((await none.json()) as { reach: BusReach[] }).reach).toEqual([]);
    expect(
      (
        (await (await api(app, R.busReach, who.cookie)).json()) as {
          reach: BusReach[];
        }
      ).reach.map((g) => g.id),
    ).toEqual([o.id]);
    d.close();
  });

  it("set is all or nothing: an invalid target, an unknown role or a cap changes nothing", async () => {
    const [home, a, b] = [ns("rh"), ns("ra"), ns("rb")];
    const { who, d } = await withBus();
    await putRole(who.cookie, home, "lead");
    await putReach(who.cookie, grant(home, "lead", a));
    const hub = await hubOf(who.userId);
    const before = await hub.listReach();
    for (const bad of [
      setBody(home, "lead", [b, home]),
      setBody(home, "lead", [b, "Not Canonical"]),
      { ...setBody(home, "lead", [b]), extra: 1 },
      setBody(
        home,
        "lead",
        Array.from({ length: BUS_REACH_PER_ROLE + 1 }, (_, i) => ns(`t${i}`)),
      ),
    ])
      expect((await setReach(who.cookie, bad)).status).toBe(400);
    const ghost = await setReach(who.cookie, setBody(home, "ghost", [b]));
    expect(ghost.status).toBe(409);
    expect((await errOf(ghost)).details).toEqual({ reason: "role_unknown" });
    // The member's total cap: fill the hub, then a set that adds two and drops none.
    await runInDurableObject(hub, (_i, state) => {
      const have = state.storage.sql
        .exec<{ n: number }>("select count(*) as n from reach_grants")
        .one().n;
      for (let i = have; i < BUS_REACH_MAX; i++)
        state.storage.sql.exec(
          `insert into reach_grants (id, org_id, role_ns, role_name, lname, mode, target_ns, created_at)
           select ?, org_id, 'fill/ns', ?, ?, 'reach', ?, 1 from reach_grants limit 1`,
          newId(),
          `f${i}`,
          `f${i}`,
          `fill/t${i}`,
        );
    });
    const full = await setReach(who.cookie, setBody(home, "lead", [a, b]));
    expect(full.status).toBe(409);
    expect((await errOf(full)).details).toEqual({ reason: "reach_limit" });
    const now = await hub.listReach();
    expect(now.filter((g) => g.roleNamespace === home)).toEqual(
      before.filter((g) => g.roleNamespace === home),
    );
    expect(now).toHaveLength(BUS_REACH_MAX);
    // A swap that nets zero still fits at the cap.
    expect(
      (await setReach(who.cookie, setBody(home, "lead", [b]))).status,
    ).toBe(200);
    d.close();
  });

  it("set takes the same auth as PUT: a PAT, a machine token, anonymous and a guest get nothing", async () => {
    const [home, a] = [ns("rh"), ns("ra")];
    const { who, d, m } = await withBus();
    await putRole(who.cookie, home, "lead");
    const { token } = await createPat(e, who.userId, "agent");
    for (const t of [token, m.token, null])
      expect([401, 404]).toContain(
        (await setReach(t, setBody(home, "lead", [a]))).status,
      );
    expect(
      (await setReach(who.cookie, setBody(home, "lead", [a]))).status,
    ).toBe(200);
    expect((await (await hubOf(who.userId)).listReach()).length).toBe(1);
    d.close();
  });

  it("lists the namespaces the member's machines have used, sorted, only this member's", async () => {
    const [x, y] = [ns("zz"), ns("aa")];
    const one = await withBus();
    const two = await withBus();
    one.d.send(up("u1", "ref-a", "alpha", x));
    await waitFor(one.d, "agent_ok");
    one.d.send(up("u2", "ref-b", "beta", y));
    await waitFor(one.d, "agent_ok");
    const r = await api(app, R.busReachNamespaces, one.who.cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ namespaces: [y, x].sort(), live: true });
    expect(
      await (await api(app, R.busReachNamespaces, two.who.cookie)).json(),
    ).toEqual({
      namespaces: [],
      live: true,
    });
    expect((await api(app, R.busReachNamespaces, null)).status).toBe(401);
    one.d.close();
    two.d.close();
  });

  it("DELETE takes an id of at most 64 id characters", async () => {
    const { who, d } = await withBus();
    for (const bad of ["a".repeat(65), "a%20b", "a.b"]) {
      const r = await api(app, `${R.busReach}/${bad}`, who.cookie, {
        method: "DELETE",
      });
      expect(r.status, bad).toBe(400);
    }
    d.close();
  });

  it("another member reaches only their own hub", async () => {
    const [home, b] = [ns("rh"), ns("rb")];
    const one = await withBus();
    const two = await withBus();
    await putRole(one.who.cookie, home, "lead");
    await putRole(two.who.cookie, home, "lead");
    await putReach(one.who.cookie, grant(home, "lead", b));
    expect(await (await api(app, R.busReach, two.who.cookie)).json()).toEqual({
      reach: [],
      live: true,
    });
    // The same role name and namespace in the other member's hub is not a grant there.
    expect((await (await hubOf(two.who.userId)).listReach()).length).toBe(0);
    const [mine] = await (await hubOf(one.who.userId)).listReach();
    expect(
      (
        await api(app, R.busReachGrant(mine?.id ?? ""), two.who.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await (await hubOf(one.who.userId)).listReach()).toHaveLength(1);
    one.d.close();
    two.d.close();
  });

  it("a PAT may read but never grant or remove; a machine token, guests, restricted and anonymous callers get nothing", async () => {
    const [home, b] = [ns("rh"), ns("rb")];
    const { who, d, m } = await withBus();
    await putRole(who.cookie, home, "lead");
    const { reach } = (await (
      await putReach(who.cookie, grant(home, "lead", b))
    ).json()) as { reach: BusReach };
    const { token } = await createPat(e, who.userId, "agent");
    expect((await api(app, R.busReach, token)).status).toBe(200);
    expect((await putReach(token, grant(home, "lead", ns("c")))).status).toBe(
      404,
    );
    expect(
      (await api(app, R.busReachGrant(reach.id), token, { method: "DELETE" }))
        .status,
    ).toBe(404);
    // A cookie session that also carries an Authorization header is not a
    // person in a browser either.
    const mixed = await api(app, R.busReach, who.cookie, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: grant(home, "lead", ns("c")),
    });
    expect([401, 404]).toContain(mixed.status);

    const guest = await member("guest");
    const restricted = await member();
    await e.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(restricted.userId)
      .run();
    for (const c of [guest.cookie, restricted.cookie]) {
      expect((await api(app, R.busReach, c)).status).toBe(404);
      expect((await putReach(c, grant(home, "lead", ns("c")))).status).toBe(
        404,
      );
      expect(
        (await api(app, R.busReachGrant(reach.id), c, { method: "DELETE" }))
          .status,
      ).toBe(404);
    }
    expect((await api(app, R.busReach, null)).status).toBe(401);
    expect((await putReach(null, grant(home, "lead", ns("c")))).status).toBe(
      401,
    );
    expect(
      (await api(app, R.busReachGrant(reach.id), null, { method: "DELETE" }))
        .status,
    ).toBe(401);
    // The machine token is bus-only.
    const r = await api(app, R.busReach, null, {
      method: "PUT",
      headers: { authorization: `Bearer ${m.token}` },
      body: grant(home, "lead", ns("c")),
    });
    expect(r.status).toBe(401);
    expect((await (await hubOf(who.userId)).listReach()).length).toBe(1);
    d.close();
  });

  it("a member with no machine that connected never reaches a BusHub", async () => {
    const dave = await member();
    await machine("never", dave.userId);
    const ev = {
      ...env,
      BUS_HUB: {
        idFromName: () => {
          throw new Error("reached the BusHub");
        },
        get: () => {
          throw new Error("reached the BusHub");
        },
      },
    };
    const call = (path: string, method = "GET", body?: unknown) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${path}`, {
          method,
          headers: {
            cookie: dave.cookie,
            "x-oa-request": "1",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        ev,
      );
    expect(await (await call(R.busReach)).json()).toEqual({
      reach: [],
      live: false,
    });
    const put = await call(R.busReach, "PUT", grant("x/y", "lead", "x/z"));
    expect(put.status).toBe(409);
    expect((await errOf(put)).details).toEqual({ reason: "no_bus" });
    expect((await call(R.busReachGrant("nope"), "DELETE")).status).toBe(204);
  });

  it("PUT and DELETE are rate-limited per member (#1358): over the limit is 429 rate_limited, normal use passes, reads are free", async () => {
    const home = ns("rh");
    const { who, d } = await withBus();
    await putRole(who.cookie, home, "lead");
    const l = limiter(3);
    const ev = { ...env, ...l };
    const call = (path: string, method: string, body?: unknown) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${path}`, {
          method,
          headers: {
            "x-oa-request": "1",
            cookie: who.cookie,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        ev,
      );
    for (let i = 0; i < 3; i++)
      expect((await call(R.busReach, "GET")).status).toBe(200);
    expect([...l.counts.keys()]).toEqual([]);
    const put = (n: string) =>
      call(R.busReach, "PUT", grant(home, "lead", ns(n)));
    expect((await put("1")).status).toBe(200);
    expect((await call(`${R.busReach}/nope`, "DELETE")).status).toBe(204);
    expect((await put("2")).status).toBe(200);
    const over = await put("3");
    expect(over.status).toBe(429);
    expect((await errOf(over)).code).toBe("rate_limited");
    expect((await call(`${R.busReach}/nope`, "DELETE")).status).toBe(429);
    d.close();
  });
});
