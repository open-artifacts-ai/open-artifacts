// #2552 step 2: with no version named, machines follow the instance. The
// default is the server's own strict x.y.z release, offered at once, only
// forward of the machine's own version, and never while the owner has paused
// updates. A named version keeps its old meaning.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { BUS_MACHINES_PAUSED_HEADER, R } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { BusHub } from "../../src/bus/hub.js";
import { RUN_VERSION_KEY, UPDATES_PAUSED_KEY } from "../../src/bus/updates.js";
import {
  RUN_VERSION_FANOUT_KEY,
  setBusUpdatesPaused,
} from "../../src/services/bus.js";
import { api } from "../helpers.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
  hello,
  hubOf,
  machine,
  member,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

const app = createApp();
const CAP = [BUS_CAPS.runVersion];
const NOW = 1_800_000_000_000;

const setKey = async (k: string, v: string | null) => {
  if (v === null)
    await e.DB.prepare("delete from settings where key = ?").bind(k).run();
  else
    await e.DB.prepare(
      "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    )
      .bind(k, v)
      .run();
};
const getKey = async (k: string) =>
  (
    await e.DB.prepare("select value from settings where key = ?")
      .bind(k)
      .first<{ value: string }>()
  )?.value ?? null;

afterEach(async () => {
  for (const k of [RUN_VERSION_KEY, UPDATES_PAUSED_KEY, RUN_VERSION_FANOUT_KEY])
    await setKey(k, null);
});

/**
 * A member on a hub whose server VERSION is `server` and whose clock is NOW,
 * and a machine running `running` that has said hello.
 */
async function open(server: string, running: string) {
  const who = await member();
  const m = await machine("MacBook", who.userId);
  const stub = await hubOf(who.userId);
  await runInDurableObject(stub, (i) => {
    BusHub.setTestServerVersion(i as unknown as BusHub, server);
    BusHub.setTestClock(i as unknown as BusHub, NOW);
  });
  const d = await daemon(m.token);
  d.send({
    ...hello("h0"),
    client_version: running,
    caps: CAP,
  } as ClientFrame);
  await waitFor(d, "hello_ok");
  // A cold hub reads the settings after hello_ok and pushes the target.
  const target = (await waitFor(d, "run_version")).run_version;
  return { who, m, d, target, stub };
}
const seen = (d: Daemon, type: ServerFrame["type"]) =>
  framesSeen(d).filter((f) => f.type === type);
const pushes = (d: Daemon) =>
  seen(d, "run_version").map(
    (f) => (f as { run_version: string | null }).run_version,
  );
const sw = (over: Record<string, unknown>) =>
  ({
    v: 1,
    id: `r${Math.random().toString(36).slice(2, 10)}`,
    type: "update_report",
    event: "switching",
    from: "1.0.0",
    to: "1.2.0",
    reason: "ok",
    rescue_version: 2,
    at: new Date(NOW).toISOString(),
    ...over,
  }) as ClientFrame;
const ackOf = async (d: Daemon, f: ClientFrame) => {
  d.send(f);
  for (;;) {
    const a = await waitFor(d, "update_ack");
    if (a.id === (f as { id: string }).id) return a.ok;
  }
};

describe("following the instance (#2552)", () => {
  it("a new release is offered at once: an older machine is told the server's release on its first hello, with no wait", async () => {
    const old = await open("1.2.0", "1.0.0");
    expect(old.target).toBe("1.2.0");
    const same = await open("1.2.0", "1.2.0");
    expect(same.target).toBeNull();
    const newer = await open("1.2.0", "1.3.0");
    expect(newer.target).toBeNull();
    // A later push says the same.
    await old.stub.runVersionChanged();
    await same.stub.runVersionChanged();
    expect(pushes(old.d).at(-1)).toBe("1.2.0");
    expect(pushes(same.d).at(-1)).toBeNull();
  });

  it("release offered right after the instance runs it", async () => {
    const { target } = await open("1.2.0", "1.0.0");
    expect(target).toBe("1.2.0");
  });

  it("a -dev or pre-release VERSION gives no default", async () => {
    for (const v of ["1.2.0-dev+abc1234", "1.2.0-rc.1"]) {
      const { target } = await open(v, "1.0.0");
      expect(target).toBeNull();
    }
  });

  it("a server older than the machine leaves the machine alone", async () => {
    const { target } = await open("1.0.0", "1.5.0");
    expect(target).toBeNull();
  });

  it("an unreadable machine version gets no default", async () => {
    const { target } = await open("1.2.0", "unknown-1700");
    expect(target).toBeNull();
  });

  it("named wins: a lower named version is still a step back", async () => {
    await setKey(RUN_VERSION_KEY, "1.1.0");
    const a = await open("1.2.0", "1.0.0");
    expect(a.target).toBe("1.1.0");
    const b = await open("1.2.0", "1.2.0");
    expect(b.target).toBe("1.1.0"); // below its own: a deliberate step back
    expect(
      await ackOf(b.d, sw({ from: "1.2.0", to: "1.1.0", reason: "ok" })),
    ).toBe(true);
    // Not the default while another is named.
    expect(await ackOf(a.d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(false);
  });
});

describe("update_ack with the default (#2552)", () => {
  it("the forward default is allowed at once; refuses anything else", async () => {
    const { d, m } = await open("1.2.0", "1.0.0");
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(true);
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.1.0" }))).toBe(false);
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.3.0" }))).toBe(false);
    // The machine already runs the default: a switch to it is no forward move.
    expect(await ackOf(d, sw({ from: "1.2.0", to: "1.2.0" }))).toBe(false);
    // The person's own request and a step back keep their old allowance.
    expect(
      await ackOf(d, sw({ from: "1.0.0", to: "1.1.0", reason: "requested" })),
    ).toBe(true);
    expect(await ackOf(d, sw({ from: "1.2.0", to: "1.0.0" }))).toBe(true);
    void m;
  });

  it("a -dev server: refused", async () => {
    const { d } = await open("1.2.0-dev+abc1234", "1.0.0");
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(false);
  });
});

describe("pause (#2552)", () => {
  it("pushes the cleared target and refuses every instance-driven switch; resume restores the default", async () => {
    const { who, d, stub } = await open("1.2.0", "1.0.0");
    // Page 0: only this member's hub is told. Other tests' hubs run other
    // pretend VERSIONs, and each would rewrite the one first-seen row.
    await setBusUpdatesPaused(e, who.userId, true, 0);
    expect(pushes(d)).toEqual(["1.2.0", null]);
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(false);
    // Named does not get past a pause either; the person's own request does.
    await setKey(RUN_VERSION_KEY, "1.2.0");
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(false);
    expect(
      await ackOf(d, sw({ from: "1.0.0", to: "1.2.0", reason: "requested" })),
    ).toBe(true);
    await setKey(RUN_VERSION_KEY, null);
    // A hello while paused is told nothing to run.
    d.send({
      ...hello("h1"),
      client_version: "1.0.0",
      caps: CAP,
    } as ClientFrame);
    expect((await waitFor(d, "hello_ok")).run_version).toBeNull();
    await setBusUpdatesPaused(e, who.userId, false, 0);
    await eventually(() => expect(pushes(d).at(-1)).toBe("1.2.0"));
    expect(await getKey(UPDATES_PAUSED_KEY)).toBeNull();
    expect(await ackOf(d, sw({ from: "1.0.0", to: "1.2.0" }))).toBe(true);
    void stub;
  });

  it("PUT R.busUpdatesPaused: the owner only, in a cookie session, audited", async () => {
    const put = (auth: string | null, body: unknown) =>
      api(app, R.busUpdatesPaused, auth, { method: "PUT", body });
    const owner = await member("owner");
    const t0 = Date.now();
    expect((await put(owner.cookie, { paused: "yes" })).status).toBe(400);
    expect((await put(null, { paused: true })).status).toBeGreaterThanOrEqual(
      401,
    );
    expect((await put(owner.cookie, { paused: true })).status).toBe(204);
    expect(await getKey(UPDATES_PAUSED_KEY)).not.toBeNull();
    expect((await put(owner.cookie, { paused: false })).status).toBe(204);
    expect(await getKey(UPDATES_PAUSED_KEY)).toBeNull();
    const rows = (
      await e.DB.prepare(
        "select actor_id, detail from audit_events where at >= ? and action = 'bus.updates_paused.set' order by at",
      )
        .bind(t0)
        .all<{ actor_id: string; detail: string }>()
    ).results;
    expect(rows.map((r) => JSON.parse(r.detail).paused)).toEqual([true, false]);
    expect(rows[0]?.actor_id).toBe(owner.userId);
  });

  it("GET R.busMachines tells the owner the pause state when asked, and no one else", async () => {
    const owner = await member("owner");
    const read = async (auth: string | null | undefined, ask: boolean) =>
      (await (
        await api(
          app,
          R.busMachines,
          auth ?? null,
          ask ? { headers: { [BUS_MACHINES_PAUSED_HEADER]: "1" } } : {},
        )
      ).json()) as { machines: unknown[]; updatesPaused?: boolean };
    // A build from before #2552 parses this with a strict schema: no field.
    const legacy = await read(owner.cookie, false);
    expect(Object.keys(legacy)).toEqual(["machines"]);
    const asked = await read(owner.cookie, true);
    expect(Object.keys(asked).sort()).toEqual(["machines", "updatesPaused"]);
    expect(asked.updatesPaused).toBe(false);
    await api(app, R.busUpdatesPaused, owner.cookie, {
      method: "PUT",
      body: { paused: true },
    });
    expect((await read(owner.cookie, true)).updatesPaused).toBe(true);
    expect(Object.keys(await read(owner.cookie, false))).toEqual(["machines"]);
    await api(app, R.busUpdatesPaused, owner.cookie, {
      method: "PUT",
      body: { paused: false },
    });
    expect((await read(owner.cookie, true)).updatesPaused).toBe(false);
    const other = await member("member");
    expect("updatesPaused" in (await read(other.cookie, true))).toBe(false);
  });
});
