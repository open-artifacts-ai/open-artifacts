// #3132 "Every move is in the audit log": each role move gets one
// bus.role.moved row saying who moved it (member: the dashboard; holder: the
// holding session's hand-over, in hub.role-move and mcp-role-hand-over), and
// a move whose audit write D1 refused is kept in the hub and written on the
// next Roles read, with the moving request's credential and never twice.
// Real hub, real daemon socket, the real roles routes.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { api } from "../helpers.js";
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

type Row = {
  id: string;
  actor_kind: string;
  actor_cred_kind: string | null;
  detail: string;
};
const moves = async (uid: string) =>
  (
    await e.DB.prepare(
      "select id, actor_kind, actor_cred_kind, detail from audit_events where target_id = ? and action = 'bus.role.moved' order by at",
    )
      .bind(uid)
      .all<Row>()
  ).results;

const scene = async () => {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello("h1"), caps: [BUS_CAPS.follow] } as never);
  await waitFor(d, "hello_ok");
  const space = ns("audit");
  const names: string[] = [];
  for (const [i, n] of [uniq("A"), uniq("B")].entries()) {
    d.send(up(`u${i}`, `ref${i}`, n, space));
    names.push((await waitFor(d, "agent_ok")).bus_name);
  }
  const hub = await hubOf(m.userId);
  const snap = (await hub.snapshot()).agents;
  const idOf = (name: string) => snap.find((a) => a.name === name)?.id ?? "";
  const role = uniq("Platform");
  const put = (agentId: string) =>
    api(app, R.busRoles, m.cookie, {
      method: "PUT",
      body: { namespace: space, name: role, agentId },
    });
  return { m, hub, put, ids: names.map(idOf) };
};

describe("role move audit rows (#3132)", () => {
  it("a dashboard move: one row by the member, with the session credential", async () => {
    const s = await scene();
    expect((await s.put(s.ids[0]!)).status).toBe(200);
    expect((await s.put(s.ids[1]!)).status).toBe(200);
    const rows = await moves(s.m.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_cred_kind: "session",
    });
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      fromAgentId: s.ids[0],
      toAgentId: s.ids[1],
      by: "member",
    });
    expect(await s.hub.pendingRoleMoveAudits()).toEqual([]);
  });

  it("a write D1 refuses is kept and written on the next Roles read, once, with the mover's credential", async () => {
    const s = await scene();
    expect((await s.put(s.ids[0]!)).status).toBe(200);
    // D1 refuses the move's audit row (a real refusal: a trigger).
    await e.DB.exec(
      "create trigger audit_down before insert on audit_events when new.action = 'bus.role.moved' begin select raise(abort, 'down'); end",
    );
    // The move stands though its audit write failed.
    expect((await s.put(s.ids[1]!)).status).toBe(200);
    expect(await moves(s.m.userId)).toEqual([]);
    await e.DB.exec("drop trigger audit_down");
    const held = await s.hub.pendingRoleMoveAudits();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      toAgentId: s.ids[1],
      by: "member",
      cred: { kind: "session" },
    });

    expect((await api(app, R.busRoles, s.m.cookie)).status).toBe(200);
    const rows = await moves(s.m.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(held[0]?.id);
    expect(rows[0]?.actor_cred_kind).toBe("session");
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      toAgentId: s.ids[1],
      by: "member",
      movedAt: held[0]?.at,
    });
    expect(await s.hub.pendingRoleMoveAudits()).toEqual([]);
    // A later read writes nothing more.
    expect((await api(app, R.busRoles, s.m.cookie)).status).toBe(200);
    expect(await moves(s.m.userId)).toHaveLength(1);
  });

  it("a write whose answer was lost is not written twice: the row id is the move's", async () => {
    const s = await scene();
    expect((await s.put(s.ids[0]!)).status).toBe(200);
    expect((await s.put(s.ids[1]!)).status).toBe(200);
    const [row] = await moves(s.m.userId);
    // As if D1 took the row but the hub never heard: unsettle it.
    await runInDurableObject(s.hub, (_, st) => {
      st.storage.sql.exec("update role_moves set audited = 0");
    });
    expect(await s.hub.pendingRoleMoveAudits()).toHaveLength(1);
    expect((await api(app, R.busRoles, s.m.cookie)).status).toBe(200);
    const rows = await moves(s.m.userId);
    expect(rows.map((r) => r.id)).toEqual([row?.id]);
    expect(await s.hub.pendingRoleMoveAudits()).toEqual([]);
  });
});
