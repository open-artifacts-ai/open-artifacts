// #2311: an away agent that still has a harness default name is purged an hour
// after it closed; renamed, live and busy ones keep today's rules.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { newId } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { isDefaultAgentName } from "../../src/bus/default-names.js";
import {
  BusHub,
  DEFAULT_NAME_AWAY_MS,
  OWNER_ORG_ID,
} from "../../src/bus/hub.js";
import { e } from "./helpers.js";

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
