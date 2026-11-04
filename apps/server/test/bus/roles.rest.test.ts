// #1296 role addresses over REST: GET R.busRoles lists the member's roles,
// PUT R.busRoles sets, re-points or vacates one, DELETE R.busRole(id)
// removes it. Only the member, in a browser session: a PAT, an OAuth grant
// or a machine token never sets one, so no AI agent can set or claim a role.
// Another member's call reaches only their own hub.
import { env } from "cloudflare:workers";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type BusRole, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { api, errOf, fetchAndWait } from "../helpers.js";
import { daemon, e, hubOf, machine, member, ns, waitFor } from "./helpers.js";

const app = createApp();
let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

/** A member with a connected machine and one open agent; returns its id. */
async function withAgent(namespace: string) {
  const who = await member();
  const m = await machine("MacBook", who.userId);
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    caps: [BUS_CAPS.roles],
  });
  await waitFor(d, "hello_ok");
  const name = uniq("alice");
  d.send({
    v: 1,
    id: "u",
    type: "agent_up",
    agent_ref: "a",
    kind: "opencode",
    proposed_name: name,
    namespace,
    global: false,
  });
  await waitFor(d, "agent_ok");
  const agent = (await (await hubOf(who.userId)).snapshot()).agents[0];
  if (!agent) throw new Error("no agent");
  return { who, d, m, agentId: agent.id, name };
}

const putRole = (auth: string | null, body: unknown) =>
  api(app, R.busRoles, auth, { method: "PUT", body });

describe("roles REST (#1296)", () => {
  it("the member sets, lists, re-points, vacates and removes a role", async () => {
    const n = ns("rr");
    const { who, d, agentId, name } = await withAgent(n);
    const set = await putRole(who.cookie, {
      namespace: n,
      name: "backend-lead",
      agentId,
    });
    expect(set.status).toBe(200);
    const { role } = (await set.json()) as { role: BusRole };
    expect(role).toMatchObject({
      namespace: n,
      name: "backend-lead",
      agentId,
      holderName: name,
      vacant: false,
    });
    expect(Object.keys(role).sort()).toEqual(
      [
        "agentId",
        "holderName",
        "id",
        "name",
        "namespace",
        "setAt",
        "vacant",
      ].sort(),
    );

    const list = await api(app, R.busRoles, who.cookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ roles: [role], live: true });

    const vacated = await putRole(who.cookie, {
      namespace: n,
      name: "Backend-Lead",
      agentId: null,
    });
    expect(vacated.status).toBe(200);
    expect(((await vacated.json()) as { role: BusRole }).role).toMatchObject({
      id: role.id,
      name: "Backend-Lead",
      agentId: null,
      vacant: true,
    });

    const del = await api(app, R.busRole(role.id), who.cookie, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    // Idempotent.
    expect(
      (await api(app, R.busRole(role.id), who.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(await (await api(app, R.busRoles, who.cookie)).json()).toEqual({
      roles: [],
      live: true,
    });
    d.close();
  });

  it("409 conflict for a taken name, a holder that isn't open there, and the cap", async () => {
    const n = ns("rr");
    const { who, d, agentId, name } = await withAgent(n);
    const taken = await putRole(who.cookie, { namespace: n, name, agentId });
    expect(taken.status).toBe(409);
    expect((await errOf(taken)).code).toBe("conflict");
    const wrongNs = await putRole(who.cookie, {
      namespace: ns("other"),
      name: "lead",
      agentId,
    });
    expect(wrongNs.status).toBe(409);
    d.close();
  });

  it("400 for an invalid body, name or namespace", async () => {
    const n = ns("rr");
    const { who, d, agentId } = await withAgent(n);
    for (const body of [
      { namespace: n, name: "lead" },
      { namespace: n, name: "lead", agentId, extra: 1 },
      { namespace: n, name: "bad@name", agentId },
      { namespace: n, name: "open-artifacts", agentId },
      { namespace: n, name: "openbus", agentId },
      { namespace: "Not Canonical", name: "lead", agentId },
      { namespace: n, name: "lead", agentId: 7 },
    ]) {
      const r = await putRole(who.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await hubOf(who.userId)).listRoles()).toEqual([]);
    d.close();
  });

  it("DELETE takes an id of at most 64 id characters (400 otherwise); a guest gets 404 first", async () => {
    const n = ns("rr");
    const { who, d } = await withAgent(n);
    const del = (id: string, cookie = who.cookie) =>
      api(app, `${R.busRoles}/${id}`, cookie, { method: "DELETE" });
    expect((await del("a".repeat(64))).status).toBe(204);
    for (const bad of ["a".repeat(65), "a%20b", "a.b", "%E2%9C%93"]) {
      const r = await del(bad);
      expect(r.status, bad).toBe(400);
      expect((await errOf(r)).details).toEqual({ field: "id" });
    }
    const guest = await member("guest");
    expect((await del("a".repeat(65), guest.cookie)).status).toBe(404);
    d.close();
  });

  it("another member reaches only their own hub: they can't see, set or remove the member's role", async () => {
    const n = ns("rr");
    const { who, d, agentId } = await withAgent(n);
    const mallory = await withAgent(n);
    const set = await putRole(who.cookie, {
      namespace: n,
      name: "lead",
      agentId,
    });
    const { role } = (await set.json()) as { role: BusRole };
    expect(
      await (await api(app, R.busRoles, mallory.who.cookie)).json(),
    ).toEqual({ roles: [], live: true });
    // The member's agent id means nothing in Mallory's hub.
    const steal = await putRole(mallory.who.cookie, {
      namespace: n,
      name: "lead",
      agentId,
    });
    expect(steal.status).toBe(409);
    expect(
      (
        await api(app, R.busRole(role.id), mallory.who.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await (await hubOf(who.userId)).listRoles()).toEqual([role]);
    d.close();
    mallory.d.close();
  });

  it("a PAT may read but never set or remove; guests, capped and anonymous callers get nothing", async () => {
    const n = ns("rr");
    const { who, d, agentId, m } = await withAgent(n);
    const { role } = (await (
      await putRole(who.cookie, { namespace: n, name: "lead", agentId })
    ).json()) as { role: BusRole };
    const { token } = await createPat(e, who.userId, "agent");
    expect((await api(app, R.busRoles, token)).status).toBe(200);
    expect(
      (await putRole(token, { namespace: n, name: "lead", agentId: null }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.busRole(role.id), token, { method: "DELETE" })).status,
    ).toBe(404);

    const guest = await member("guest");
    const capped = await member();
    await e.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    for (const c of [guest.cookie, capped.cookie]) {
      expect((await api(app, R.busRoles, c)).status).toBe(404);
      expect(
        (await putRole(c, { namespace: n, name: "lead", agentId: null }))
          .status,
      ).toBe(404);
      expect(
        (await api(app, R.busRole(role.id), c, { method: "DELETE" })).status,
      ).toBe(404);
    }
    expect((await api(app, R.busRoles, null)).status).toBe(401);
    expect(
      (await putRole(null, { namespace: n, name: "lead", agentId: null }))
        .status,
    ).toBe(401);
    expect(
      (await api(app, R.busRole(role.id), null, { method: "DELETE" })).status,
    ).toBe(401);
    // The machine token is bus-only.
    const r = await api(app, R.busRoles, null, {
      method: "PUT",
      headers: { authorization: `Bearer ${m.token}` },
      body: { namespace: n, name: "lead", agentId: null },
    });
    expect(r.status).toBe(401);
    expect(await (await hubOf(who.userId)).listRoles()).toEqual([role]);
    d.close();
  });

  it("a member with no machine that connected never reaches a BusHub", async () => {
    const dave = await member();
    await machine("never", dave.userId);
    // Any touch of the binding fails the request.
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
    const list = await call(R.busRoles);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ roles: [], live: false });
    const put = await call(R.busRoles, "PUT", {
      namespace: "x/y",
      name: "lead",
      agentId: "nope",
    });
    expect(put.status).toBe(409);
    expect((await call(R.busRole("nope"), "DELETE")).status).toBe(204);
  });
});
