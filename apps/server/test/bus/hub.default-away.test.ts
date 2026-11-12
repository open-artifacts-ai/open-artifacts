// #2311: an away agent that still has a harness default name is purged an hour
// after it closed; renamed, live and busy ones keep today's rules.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  newId,
} from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { isDefaultAgentName } from "../../src/bus/default-names.js";
import {
  AUTHZ_AT_HEADER,
  BusHub,
  CONNECT_DO_PATH,
  DEFAULT_NAME_AWAY_MS,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  OWNER_ORG_ID,
} from "../../src/bus/hub.js";
import { e, trackSocket } from "./helpers.js";

type Stub = DurableObjectStub<BusHub>;
const busNs = () => e.BUS_HUB as DurableObjectNamespace<BusHub>;
const fresh = (): Stub => busNs().get(busNs().newUniqueId());
const inHub = <R>(h: Stub, fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(h, (i: BusHub, s) => fn(i, s));
const clock = (h: Stub, ms: number) =>
  inHub(h, (i) => BusHub.setTestClock(i, ms));
const MIN = 60_000;

/** Seeds one agent row (and its away reservation when closed). */
const seed = (
  h: Stub,
  name: string,
  live: 0 | 1,
  closedAt: number,
  kind = "claude-code",
) =>
  inHub(h, (_, s) => {
    const id = newId();
    const sql = s.storage.sql;
    sql.exec(
      "insert or ignore into machines (id, org_id, label, created_at) values ('m1', ?, 'Mac', 0)",
      OWNER_ORG_ID,
    );
    sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at, away_since)
       values (?, ?, 'ns', ?, ?, 'm1', ?, 0, ?, ?, ?)`,
      id,
      OWNER_ORG_ID,
      name,
      kind,
      `ref_${id}`,
      live,
      closedAt,
      live === 0 ? closedAt : null,
    );
    if (live === 0)
      sql.exec(
        `insert into former_names (agent_id, org_id, name, lname, kind, expires_at, namespace, global)
         values (?, ?, ?, lower(?), 'away', ?, 'ns', 0)`,
        id,
        OWNER_ORG_ID,
        name,
        name,
        closedAt + 7 * 24 * 60 * MIN,
      );
    return id;
  });
const exists = (h: Stub, id: string) =>
  inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from agents where id = ?",
          id,
        )
        .one().n === 1,
  );
const alarms = async (h: Stub, n: number) => {
  // Seeded rows arm nothing: arm the alarm as a close would.
  await inHub(h, (_, s) => s.storage.setAlarm(Date.now() + 1));
  for (let k = 0; k < n; k++) {
    await runDurableObjectAlarm(h);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("isDefaultAgentName", () => {
  it("knows the harness defaults and not chosen names", () => {
    for (const n of ["claude-4242", "pi", "pi-7", "omp-3", "agent-2", "codex"])
      expect(isDefaultAgentName(n, "claude-code", false)).toBe(true);
    expect(isDefaultAgentName("open-artifacts-3fa1", "claude-code", true)).toBe(
      true,
    );
    for (const n of ["OA Manager", "OA Bus-2", "backend-fe", "my agent"])
      expect(isDefaultAgentName(n, "claude-code", false)).toBe(false);
  });
});

describe("default-named away agents (#2311)", () => {
  it("are gone after 61 min and kept at 59", async () => {
    const h = fresh();
    const t0 = Date.now();
    const id = await seed(h, "claude-111", 0, t0);
    await clock(h, t0 + DEFAULT_NAME_AWAY_MS - MIN);
    await alarms(h, 2);
    expect(await exists(h, id)).toBe(true);
    await clock(h, t0 + DEFAULT_NAME_AWAY_MS + MIN);
    await alarms(h, 3);
    expect(await exists(h, id)).toBe(false);
    const left = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from former_names where agent_id = ?",
            id,
          )
          .one().n,
    );
    expect(left).toBe(0);
  });

  it("a renamed away agent and a live default-named one are kept", async () => {
    const h = fresh();
    const t0 = Date.now();
    const renamed = await seed(h, "OA Manager", 0, t0);
    const live = await seed(h, "claude-222", 1, t0);
    await clock(h, t0 + 2 * DEFAULT_NAME_AWAY_MS);
    await alarms(h, 3);
    expect(await exists(h, renamed)).toBe(true);
    expect(await exists(h, live)).toBe(true);
  });

  it("one with pending mail is kept", async () => {
    const h = fresh();
    const t0 = Date.now();
    const id = await seed(h, "pi-3", 0, t0, "pi");
    await inHub(h, (_, s) =>
      s.storage.sql.exec(
        "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'x', ?, ?)",
        newId(),
        OWNER_ORG_ID,
        id,
        t0,
        t0 + 7 * 24 * 60 * MIN,
      ),
    );
    await clock(h, t0 + 2 * DEFAULT_NAME_AWAY_MS);
    await alarms(h, 3);
    expect(await exists(h, id)).toBe(true);
  });

  it("a batch of 300 is swept over passes", async () => {
    const h = fresh();
    const t0 = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++)
      ids.push(await seed(h, `claude-${i}`, 0, t0 + i));
    await clock(h, t0 + 2 * DEFAULT_NAME_AWAY_MS);
    await alarms(h, 1);
    const afterOne = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>("select count(*) as n from agents")
          .one().n,
    );
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(300);
    await alarms(h, 10);
    const left = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>("select count(*) as n from agents")
          .one().n,
    );
    expect(left).toBe(0);
  });
});

describe("unnamed flag and renames (#2311)", () => {
  it("a chosen rename is never expired, and the list marks only unnamed agents", async () => {
    const h = fresh();
    const t0 = Date.now();
    const a = await seed(h, "open-artifacts-3fa1", 0, t0);
    const b = await seed(h, "claude-77", 0, t0);
    // `a` was renamed by the user to a name that reads like a default.
    await inHub(h, (_, s) =>
      s.storage.sql.exec("update agents set name_chosen = 1 where id = ?", a),
    );
    await inHub(h, (_, s) =>
      s.storage.sql.exec(
        "insert into minted_names (org_id, lname, name, agent_id, lbase, created_at) values (?, 'open-artifacts-3fa1', 'open-artifacts-3fa1', ?, 'open-artifacts', ?)",
        OWNER_ORG_ID,
        a,
        t0,
      ),
    );
    const list = (await inHub(h, (i) => i.snapshot({ away: true }))) as {
      agents: { id: string; unnamed?: boolean }[];
    };
    expect(list.agents.find((x) => x.id === a)?.unnamed).toBeUndefined();
    expect(list.agents.find((x) => x.id === b)?.unnamed).toBe(true);
    await clock(h, t0 + 2 * DEFAULT_NAME_AWAY_MS);
    await alarms(h, 3);
    expect(await exists(h, a)).toBe(true);
    expect(await exists(h, b)).toBe(false);
  });
});

describe("agent_up name_chosen (#2311)", () => {
  it("marks the agent chosen, so a default-looking name is not expired", async () => {
    const h = fresh();
    const mid = newId();
    await inHub(h, (_, s) =>
      s.storage.sql.exec(
        "insert into machines (id, org_id, label, created_at) values (?, ?, 'Mac', ?)",
        mid,
        OWNER_ORG_ID,
        Date.now(),
      ),
    );
    const res = await h.fetch(`https://hub.internal${CONNECT_DO_PATH}`, {
      headers: {
        Upgrade: "websocket",
        [MACHINE_ID_HEADER]: mid,
        [MACHINE_LABEL_HEADER]: "Mac",
        [AUTHZ_AT_HEADER]: String(Date.now()),
      },
    });
    const ws = res.webSocket as WebSocket;
    ws.accept();
    trackSocket(ws);
    const types: string[] = [];
    ws.addEventListener("message", (ev) => {
      const r = decodeServerFrame(String(ev.data));
      if (r.ok) types.push(r.frame.type);
    });
    const send = (f: ClientFrame) => ws.send(encodeFrame(f));
    send({
      v: 1,
      id: "u1",
      type: "agent_up",
      agent_ref: "ref_c",
      kind: "pi",
      proposed_name: "pi-2",
      namespace: "ns",
      global: false,
      name_chosen: true,
    });
    send({
      v: 1,
      id: "u2",
      type: "agent_up",
      agent_ref: "ref_d",
      kind: "pi",
      proposed_name: "pi-3",
      namespace: "ns",
      global: false,
    });
    for (let i = 0; i < 100 && types.filter((t) => t === "agent_ok").length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    const flags = await inHub(h, (_, s) =>
      s.storage.sql
        .exec<{ n: string; c: number }>(
          "select native_ref as n, name_chosen as c from agents order by native_ref",
        )
        .toArray(),
    );
    expect(flags).toEqual([
      { n: "ref_c", c: 1 },
      { n: "ref_d", c: 0 },
    ]);
  });
});
