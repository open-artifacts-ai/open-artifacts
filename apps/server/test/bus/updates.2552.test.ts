// #2552 PR 5: the instance names the version, machines report back.
// BUS_CAPS.runVersion gates every frame both ways; the version comes only from
// the instance setting `bus_run_version` (owner-only route, audited); a
// `switching` report is answered by update_ack; a machine that says switching
// and then nothing for 5 minutes is marked stopped.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import {
  latestReport,
  markStopped,
  RUN_VERSION_KEY,
  STOPPED_AFTER_MS,
} from "../../src/bus/updates.js";
import { setBusRunVersion } from "../../src/services/bus.js";
import { VERSION } from "../../src/version.gen.js";
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

const app = createApp();
const CAP = [BUS_CAPS.runVersion];

const setNamed = async (v: string | null) => {
  if (v === null)
    await e.DB.prepare("delete from settings where key = ?")
      .bind(RUN_VERSION_KEY)
      .run();
  else
    await e.DB.prepare(
      "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    )
      .bind(RUN_VERSION_KEY, v)
      .run();
};

/** A fresh member, machine and (cap'd) socket with hello_ok read. */
async function open(caps: string[] = CAP) {
  const who = await member();
  const m = await machine("MacBook", who.userId);
  const d = await daemon(m.token);
  d.send({ ...hello("h0"), ...(caps.length ? { caps } : {}) } as ClientFrame);
  const ok = await waitFor(d, "hello_ok");
  return { who, m, d, ok };
}
/** A round trip: every frame the hub sent before it has arrived. */
async function barrier(d: Daemon, caps: string[] = CAP) {
  const id = `b${Math.random().toString(36).slice(2, 10)}`;
  d.send({ ...hello(id), ...(caps.length ? { caps } : {}) } as ClientFrame);
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}
const seen = (d: Daemon, type: ServerFrame["type"]) =>
  framesSeen(d).filter((f) => f.type === type);

const report = (over: Record<string, unknown> = {}) =>
  ({
    v: 1,
    id: `r${Math.random().toString(36).slice(2, 10)}`,
    type: "update_report",
    event: "updated",
    from: "1.0.0",
    to: "1.1.0",
    reason: "ok",
    rescue_version: 2,
    at: new Date().toISOString(),
    ...over,
  }) as ClientFrame;

describe("run_version: the instance names it (#2552)", () => {
  it("nothing named: no field, no push; the cap is listed", async () => {
    await setNamed(null);
    const { d, ok } = await open();
    expect(ok.caps).toContain("run_version");
    // Cold hub: unknown at hello_ok, then the push says none (#2719).
    expect(ok.run_version).toBeUndefined();
    expect((await waitFor(d, "run_version")).run_version).toBeNull();
  });

  it("named and a cold hub: hello_ok first, then the push", async () => {
    await setNamed("1.5.0");
    try {
      const { d, ok } = await open();
      expect(ok.run_version).toBeUndefined();
      const push = await waitFor(d, "run_version");
      expect(push.run_version).toBe("1.5.0");
    } finally {
      await setNamed(null);
    }
  });

  it("named and a warm hub: hello_ok carries it, with no second push", async () => {
    await setNamed("1.5.0");
    try {
      const { who, d } = await open();
      await waitFor(d, "run_version");
      d.send({ ...hello("h1"), caps: CAP } as ClientFrame);
      const again = await waitFor(d, "hello_ok");
      expect(again.run_version).toBe("1.5.0");
      await barrier(d);
      expect(seen(d, "run_version")).toHaveLength(1);
      expect(who.userId).toBeTruthy();
    } finally {
      await setNamed(null);
    }
  });

  it("an older daemon (no cap) never sees the field, the push or the cap", async () => {
    await setNamed("1.5.0");
    try {
      const { d, ok } = await open([]);
      expect(ok.run_version).toBeUndefined();
      expect(ok.caps).toBeUndefined();
      await barrier(d, []);
      expect(seen(d, "run_version")).toHaveLength(0);
      // A daemon that listed other caps but not this one: the cap is listed
      // (the hub lists what it supports) and still no field or push.
      const other = await open([BUS_CAPS.ids]);
      expect(other.ok.run_version).toBeUndefined();
      await barrier(other.d, [BUS_CAPS.ids]);
      expect(seen(other.d, "run_version")).toHaveLength(0);
    } finally {
      await setNamed(null);
    }
  });

  it("a stored value that is not x.y.z names nothing", async () => {
    for (const bad of ["latest", "1.2", "1.2.3-x", " 1.2.3", "1.2.3\n"]) {
      await setNamed(bad);
      try {
        const { d, ok } = await open();
        expect(ok.run_version, bad).toBeUndefined();
        expect((await waitFor(d, "run_version")).run_version, bad).toBeNull();
      } finally {
        await setNamed(null);
      }
    }
  });

  it("the owner's change reaches the owner's connected machines at once", async () => {
    await setNamed(null);
    const { who, d } = await open();
    await barrier(d);
    await setNamed("1.7.0");
    try {
      await (await hubOf(who.userId)).runVersionChanged();
      expect((await waitFor(d, "run_version")).run_version).toBe("1.7.0");
    } finally {
      await setNamed(null);
    }
  });
});

describe("update_report (#2552)", () => {
  it("is kept as the machine's latest, replaced by the next", async () => {
    const { m, d } = await open();
    d.send(report({ event: "refused", to: "1.2.0", reason: "proof_failed" }));
    await barrier(d);
    expect(await latestReport(e, m.id)).toMatchObject({
      event: "refused",
      toVersion: "1.2.0",
      reason: "proof_failed",
      rescueVersion: 2,
      stoppedAt: null,
    });
    d.send(report({ event: "updated", detail: "ok after 12 s" }));
    await barrier(d);
    expect(await latestReport(e, m.id)).toMatchObject({
      event: "updated",
      toVersion: "1.1.0",
      detail: "ok after 12 s",
    });
    // One row per machine.
    const n = await e.DB.prepare(
      "select count(*) as n from bus_machine_updates where machine_id = ?",
    )
      .bind(m.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("only a socket that listed the cap may send one: bad_frame, nothing stored", async () => {
    const { m, d } = await open([]);
    d.send(report());
    const err = await waitFor(d, "error");
    expect(err.code).toBe("bad_frame");
    expect(await latestReport(e, m.id)).toBeNull();
  });

  it("an unknown reason or event, a bad version or a long detail is bad_frame", async () => {
    const { m, d } = await open();
    for (const bad of [
      { reason: "because" },
      { event: "gone" },
      { to: "1.2" },
      { detail: "x".repeat(201) },
      { extra: 1 },
      { rescue_version: -1 },
    ]) {
      d.send(report(bad));
      expect((await waitFor(d, "error")).code, JSON.stringify(bad)).toBe(
        "bad_frame",
      );
    }
    expect(await latestReport(e, m.id)).toBeNull();
  });

  it("a switching report is answered yes, once stored; others get no answer", async () => {
    const { m, d } = await open();
    const sw = report({ event: "switching", reason: "requested" });
    d.send(sw);
    const ack = await waitFor(d, "update_ack");
    expect(ack).toMatchObject({ id: (sw as { id: string }).id, ok: true });
    expect(await latestReport(e, m.id)).toMatchObject({ event: "switching" });
    d.send(report({ event: "updated" }));
    await barrier(d);
    expect(seen(d, "update_ack")).toHaveLength(1);
  });

  it("an ack says yes or no and nothing else", async () => {
    const { d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    const ack = await waitFor(d, "update_ack");
    expect(Object.keys(ack).sort()).toEqual(["id", "ok", "type", "v"]);
  });
});

const CORE = "0.1.0";
describe("stopping a rollout (#2719)", () => {
  it("a warm hub says none in hello_ok; clearing pushes null to capped sockets", async () => {
    await setNamed("1.7.0");
    const { who, d } = await open();
    await waitFor(d, "run_version");
    await setNamed(null);
    await (await hubOf(who.userId)).runVersionChanged();
    const cleared = await waitFor(d, "run_version");
    expect(cleared.run_version).toBeNull();
    d.send({ ...hello("h9"), caps: CAP } as ClientFrame);
    const again = await waitFor(d, "hello_ok");
    expect(again.run_version).toBeNull();
  });

  it("another member's connected machine hears the change through setBusRunVersion", async () => {
    await setNamed(null);
    const owner = await member();
    const other = await open();
    await waitFor(other.d, "run_version");
    await setBusRunVersion(e, owner.userId, CORE);
    try {
      expect((await waitFor(other.d, "run_version")).run_version).toBe(CORE);
    } finally {
      await setNamed(null);
    }
  });

  it("update_ack is no for a switch to a version that is not named, read fresh", async () => {
    await setNamed("1.1.0");
    const { m, d } = await open();
    await waitFor(d, "run_version");
    // Warm cache says 1.1.0; the setting is cleared behind its back.
    await setNamed(null);
    const sw = report({ event: "switching", reason: "ok" });
    d.send(sw);
    const ack = await waitFor(d, "update_ack");
    expect(ack).toMatchObject({ id: (sw as { id: string }).id, ok: false });
    // Nothing stored: no stop clock for a swap that never happens.
    expect(await latestReport(e, m.id)).toBeNull();
  });

  it("yes when it names that version, for a step back, and for the person's request", async () => {
    await setNamed("1.1.0");
    try {
      const { d } = await open();
      for (const over of [
        { to: "1.1.0" },
        { from: "1.1.0", to: "1.0.0", reason: "ok" },
        { to: "1.9.0", reason: "requested" },
      ]) {
        const sw = report({ event: "switching", reason: "ok", ...over });
        d.send(sw);
        let ack = await waitFor(d, "update_ack");
        while (ack.id !== (sw as { id: string }).id)
          ack = await waitFor(d, "update_ack");
        expect(ack.ok, JSON.stringify(over)).toBe(true);
      }
    } finally {
      await setNamed(null);
    }
  });
});

describe("the bus stopped (#2552)", () => {
  const dueNow = async (userId: string) =>
    runInDurableObject(await hubOf(userId), (_i, s: DurableObjectState) =>
      s.storage.sql.exec(
        "update meta set value = ? where key = 'update_due'",
        String(Date.now() - 1),
      ),
    );
  const aged = (machineId: string, ago: number) =>
    e.DB.prepare(
      "update bus_machine_updates set switching_at = ?1, last_hello_at = ?1 where machine_id = ?2",
    )
      .bind(Date.now() - ago, machineId)
      .run();

  it("switching and no hello for 5 minutes: marked stopped", async () => {
    const { who, m, d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    await waitFor(d, "update_ack");
    await aged(m.id, STOPPED_AFTER_MS + 1000);
    await dueNow(who.userId);
    const ran = await runDurableObjectAlarm(await hubOf(who.userId));
    expect(ran).toBe(true);
    expect((await latestReport(e, m.id))?.stoppedAt).not.toBeNull();
  });

  it("not before the 5 minutes are up", async () => {
    const { who, m, d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    await waitFor(d, "update_ack");
    await aged(m.id, 60_000);
    await dueNow(who.userId);
    await runDurableObjectAlarm(await hubOf(who.userId));
    expect((await latestReport(e, m.id))?.stoppedAt).toBeNull();
  });

  it("a hello after the switching report clears the clock", async () => {
    const { who, m, d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    await waitFor(d, "update_ack");
    await aged(m.id, STOPPED_AFTER_MS + 1000);
    // The new daemon connects and says hello.
    const d2 = await daemon(m.token);
    d2.send({ ...hello("h9"), caps: CAP } as ClientFrame);
    await waitFor(d2, "hello_ok");
    await dueNow(who.userId);
    await runDurableObjectAlarm(await hubOf(who.userId));
    expect((await latestReport(e, m.id))?.stoppedAt).toBeNull();
    // No past due time is left behind to re-arm the alarm in a loop.
    const due = await runInDurableObject(
      await hubOf(who.userId),
      (_i, s: DurableObjectState) =>
        s.storage.sql
          .exec("select value from meta where key = 'update_due'")
          .toArray()
          .map((r) => Number(r.value)),
    );
    expect(due.every((t) => t > Date.now())).toBe(true);
  });

  it("markStopped returns null for a hello-after-switching machine", async () => {
    const { who, m, d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    await waitFor(d, "update_ack");
    await aged(m.id, STOPPED_AFTER_MS + 1000);
    await e.DB.prepare(
      "update bus_machine_updates set last_hello_at = switching_at + 1 where machine_id = ?1",
    )
      .bind(m.id)
      .run();
    expect(await markStopped(e, who.userId, Date.now())).toBeNull();
  });

  it("a later non-switching report is not a stop either", async () => {
    const { who, m, d } = await open();
    d.send(report({ event: "switching", reason: "requested" }));
    await waitFor(d, "update_ack");
    d.send(report({ event: "updated" }));
    await barrier(d);
    await aged(m.id, STOPPED_AFTER_MS + 1000);
    await dueNow(who.userId);
    await runDurableObjectAlarm(await hubOf(who.userId));
    expect((await latestReport(e, m.id))?.stoppedAt).toBeNull();
  });

  it("without any switching report the alarm asks D1 nothing about updates", async () => {
    const { who } = await open();
    const has = await runInDurableObject(
      await hubOf(who.userId),
      (_i, s: DurableObjectState) =>
        s.storage.sql
          .exec("select count(*) as n from meta where key = 'update_due'")
          .one().n,
    );
    expect(has).toBe(0);
  });
});

describe("install_now (#2552)", () => {
  it("reaches only that machine's sockets that listed the cap, with no field", async () => {
    const who = await member();
    const m1 = await machine("A", who.userId);
    const m2 = await machine("B", who.userId);
    const a = await daemon(m1.token);
    a.send({ ...hello("a"), caps: CAP } as ClientFrame);
    await waitFor(a, "hello_ok");
    const old = await daemon(m2.token);
    old.send(hello("o"));
    await waitFor(old, "hello_ok");
    const hub = await hubOf(who.userId);
    expect(await hub.installNow(m1.id)).toBe(1);
    const f = await waitFor(a, "install_now");
    expect(Object.keys(f).sort()).toEqual(["id", "type", "v"]);
    // The other machine has no cap: nothing is sent.
    expect(await hub.installNow(m2.id)).toBe(0);
    await barrier(old, []);
    expect(seen(old, "install_now")).toHaveLength(0);
    // Garbage ids reach no one.
    expect(await hub.installNow("not-an-id")).toBe(0);
  });
});

describe("PUT R.busRunVersion: the owner names it (#2552)", () => {
  const put = (auth: string | null, body: unknown) =>
    api(app, R.busRunVersion, auth, { method: "PUT", body });
  const auditRows = async (since: number) =>
    (
      await e.DB.prepare(
        "select actor_id, action, target_type, target_id, detail from audit_events where at >= ? and action = 'bus.run_version.set' order by at",
      )
        .bind(since)
        .all<{ actor_id: string; detail: string; target_id: string }>()
    ).results;
  const stored = async () =>
    (
      await e.DB.prepare("select value from settings where key = ?")
        .bind(RUN_VERSION_KEY)
        .first<{ value: string }>()
    )?.value ?? null;

  it("the owner sets and clears it, each audited", async () => {
    await setNamed(null);
    const owner = await member("owner");
    const since = Date.now();
    const r = await put(owner.cookie, { version: "0.150.1" });
    expect(r.status).toBe(204);
    expect(await stored()).toBe("0.150.1");
    expect((await put(owner.cookie, { version: null })).status).toBe(204);
    expect(await stored()).toBeNull();
    const rows = await auditRows(since);
    expect(rows.map((x) => JSON.parse(x.detail).version)).toEqual([
      "0.150.1",
      null,
    ]);
    expect(rows[0]).toMatchObject({
      actor_id: owner.userId,
      target_id: RUN_VERSION_KEY,
    });
  });

  it("older than the one named: refused unless stepBack, which the audit records", async () => {
    await setNamed(null);
    const owner = await member("owner");
    const since = Date.now();
    expect((await put(owner.cookie, { version: "0.150.0" })).status).toBe(204);
    // Equal and newer are fine; older is a conflict.
    expect((await put(owner.cookie, { version: "0.150.0" })).status).toBe(204);
    expect((await put(owner.cookie, { version: "0.151.0" })).status).toBe(204);
    const r = await put(owner.cookie, { version: "0.150.0" });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("older_version");
    expect(await stored()).toBe("0.151.0");
    expect(
      (await put(owner.cookie, { version: "0.150.0", stepBack: false })).status,
    ).toBe(409);
    expect(
      (await put(owner.cookie, { version: "0.150.0", stepBack: "yes" })).status,
    ).toBe(400);
    expect(
      (await put(owner.cookie, { version: "0.150.0", stepBack: true })).status,
    ).toBe(204);
    expect(await stored()).toBe("0.150.0");
    // Clearing never needs it.
    expect((await put(owner.cookie, { version: null })).status).toBe(204);
    const rows = (await auditRows(since)).map((x) => JSON.parse(x.detail));
    expect(rows.at(-2)).toEqual({ version: "0.150.0", stepBack: true });
    expect(rows.every((d) => typeof d.stepBack === "boolean")).toBe(true);
  });

  it("newer than this server: refused, nothing stored", async () => {
    await setNamed(null);
    const owner = await member("owner");
    // Versions past this server, whatever version it is built as.
    const [maj, min, pat] = (VERSION.split(/[-+]/)[0] ?? "0.0.0")
      .split(".")
      .map(Number) as [number, number, number];
    for (const v of [
      "99.0.0",
      `${maj}.${min + 1}.0`,
      `${maj}.${min}.${pat + 1}`,
      `${maj + 1}.0.0`,
    ]) {
      const r = await put(owner.cookie, { version: v });
      expect(r.status, v).toBe(409);
      expect(await r.text()).toContain("ahead_of_server");
    }
    expect(await stored()).toBeNull();
    expect((await put(owner.cookie, { version: "0.150.0" })).status).toBe(204);
    await setNamed(null);
  });

  it("only strict x.y.z; nothing stored or audited on a bad one", async () => {
    await setNamed(null);
    const owner = await member("owner");
    const since = Date.now();
    for (const bad of [
      { version: "1.2" },
      { version: "v1.2.3" },
      { version: "1.2.3-x" },
      { version: "01.2.3" },
      { version: "1.2.3 " },
      { version: "" },
      { version: 123 },
      {},
      { version: "1.2.3", url: "https://x.test" },
    ])
      expect((await put(owner.cookie, bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    expect(await stored()).toBeNull();
    expect(await auditRows(since)).toEqual([]);
  });

  it("admins, members, guests, a PAT and anonymous callers are refused, writing nothing", async () => {
    await setNamed(null);
    const owner = await member("owner");
    const since = Date.now();
    for (const role of ["admin", "member", "guest"] as const) {
      const who = await member(role);
      expect((await put(who.cookie, { version: "9.9.9" })).status, role).toBe(
        404,
      );
    }
    const { token } = await createPat(e, owner.userId, "agent");
    expect((await put(token, { version: "9.9.9" })).status).toBe(404);
    expect((await put(null, { version: "9.9.9" })).status).toBe(401);
    // A cookie that also carries a bearer is not a person in a browser.
    const mixed = await api(app, R.busRunVersion, owner.cookie, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: { version: "9.9.9" },
    });
    expect([401, 404]).toContain(mixed.status);
    expect(await stored()).toBeNull();
    expect(await auditRows(since)).toEqual([]);
  });

  it("a cookie write without the request header is refused (CSRF)", async () => {
    await setNamed(null);
    const owner = await member("owner");
    const r = await app.request(
      `http://app.localhost${R.busRunVersion}`,
      {
        method: "PUT",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ version: "3.0.0" }),
      },
      e,
    );
    expect(r.status).toBe(403);
    expect(await stored()).toBeNull();
  });
});

describe("POST R.busMachineInstallNow: the machine's own member (#2552)", () => {
  const post = (auth: string | null, id: string) =>
    api(app, R.busMachineInstallNow(id), auth, { method: "POST" });
  const auditN = async (id: string) =>
    (
      await e.DB.prepare(
        "select count(*) as n from audit_events where action = 'bus.install_now' and target_id = ?",
      )
        .bind(id)
        .first<{ n: number }>()
    )?.n;

  it("a connected machine gets the fieldless frame; audited", async () => {
    const { who, m, d } = await open();
    const r = await post(who.cookie, m.id);
    expect(r.status).toBe(204);
    const f = await waitFor(d, "install_now");
    expect(Object.keys(f).sort()).toEqual(["id", "type", "v"]);
    expect(await auditN(m.id)).toBe(1);
  });

  it("409 machine_offline when no socket took it", async () => {
    const who = await member();
    const m = await machine("Off", who.userId);
    const r = await post(who.cookie, m.id);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("machine_offline");
  });

  it("another member's machine, an unknown id, a PAT or anonymous: nothing sent", async () => {
    const { who, m, d } = await open();
    const other = await member();
    expect((await post(other.cookie, m.id)).status).toBe(404);
    expect((await post(who.cookie, "nope")).status).toBe(404);
    const { token } = await createPat(e, who.userId, "agent");
    expect((await post(token, m.id)).status).toBe(404);
    expect((await post(null, m.id)).status).toBe(401);
    await barrier(d);
    expect(seen(d, "install_now")).toHaveLength(0);
    expect(await auditN(m.id)).toBe(0);
  });

  it("a revoked machine is unknown", async () => {
    const { who, m } = await open();
    await e.DB.prepare("update bus_machines set revoked_at = ? where id = ?")
      .bind(Date.now(), m.id)
      .run();
    expect((await post(who.cookie, m.id)).status).toBe(404);
  });
});
