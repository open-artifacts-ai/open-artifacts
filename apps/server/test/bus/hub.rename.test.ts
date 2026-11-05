// R393b (#1325, ported from OpenBus #393 / #431 and #441): the hub side of
// renames. `rename` answers `renamed` or an error; a former name keeps
// reaching its agent for LIMITS.formerNameGraceMs, a chosen one stays
// reserved for it, a default name is minted `<base>-<4 hex>` and never minted
// again; resolution looks in the sender's own namespace first. OA's gate is a
// capability, not a version: `former_names` and a former-name `to_name` go
// only to sockets whose hello listed BUS_CAPS.rename. Time is
// BusHub.setTestClock, always set ahead of real time and reset after each
// test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  IsoTimeSchema,
  KindTokenSchema,
  LIMITS,
  MachineLabelSchema,
  MsgIdSchema,
  RENAME_MESSAGES,
  ReceiptReasonSchema,
  ReceiptStateSchema,
  type ServerFrame,
  StatusLabelSchema,
  StatusStateSchema,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BusHub } from "../../src/bus/hub.js";
import { migrateHub } from "../../src/bus/schema.js";
import {
  type Daemon,
  daemon,
  hubOf,
  machine,
  member,
  ns,
  waitFor,
} from "./helpers.js";

const inHub = async <R>(
  fn: (i: BusHub, s: DurableObjectState) => R,
  userId?: string,
) => runInDurableObject(await hubOf(userId), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));

afterEach(async () => {
  await setClock(null);
});

const GRACE = LIMITS.formerNameGraceMs;
let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

type Renamed = Extract<ServerFrame, { type: "renamed" }>;
type ErrorFrame = Extract<ServerFrame, { type: "error" }>;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type Roster = Extract<ServerFrame, { type: "roster" }>;

/**
 * A daemon on a new machine of the owner (or `userId`) that said hello,
 * listing BUS_CAPS.rename unless `caps` is false (an old client).
 */
async function at(caps = true, userId?: string): Promise<Daemon> {
  const m = await machine("MacBook", userId);
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    ...(caps ? { caps: [BUS_CAPS.rename] } : {}),
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  opts: { global?: boolean; kind?: "default" | "chosen" } = {},
): Promise<string> {
  d.send({
    v: 1,
    id: id("u"),
    type: "agent_up",
    agent_ref: ref,
    kind: "opencode",
    proposed_name: name,
    namespace,
    global: opts.global ?? false,
    ...(opts.kind === undefined ? {} : { name_kind: opts.kind }),
  });
  return (await waitFor(d, "agent_ok")).bus_name;
}

/** Sends `rename`; resolves with the `renamed` or `error` that answers it. */
async function rename(
  d: Daemon,
  ref: string,
  name: string,
  kind?: "default" | "chosen",
): Promise<Renamed | ErrorFrame> {
  const fid = id("r");
  d.send({
    v: 1,
    id: fid,
    type: "rename",
    agent_ref: ref,
    proposed_name: name,
    ...(kind === undefined ? {} : { name_kind: kind }),
  });
  for (;;) {
    const f = await d.next();
    if ((f.type === "renamed" || f.type === "error") && f.id === fid) return f;
  }
}

async function renamed(
  d: Daemon,
  ref: string,
  name: string,
  kind?: "default" | "chosen",
): Promise<Renamed> {
  const r = await rename(d, ref, name, kind);
  expect(r.type, JSON.stringify(r)).toBe("renamed");
  return r as Renamed;
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  toNamespace?: string,
): Promise<Receipt> {
  const fid = id("s");
  d.send({
    v: 1,
    id: fid,
    type: "send",
    from_ref: from,
    to_name: to,
    body: "hi",
    ...(toNamespace === undefined ? {} : { to_namespace: toNamespace }),
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

async function list(d: Daemon, from: string): Promise<Roster> {
  const fid = id("l");
  d.send({ v: 1, id: fid, type: "list", from_ref: from });
  for (;;) {
    const f = await d.next();
    if (f.type === "roster" && f.id === fid) return f;
  }
}

/** The raw text of the frame answering `fid` (for the frozen-schema checks). */
const rawFor = (d: Daemon, fid: string): unknown => {
  for (const t of d.raw) {
    if (!t.startsWith("{")) continue;
    const v = JSON.parse(t) as { id?: string };
    if (v.id === fid) return v;
  }
  throw new Error(`no frame ${fid}`);
};

const row = (r: Roster, name: string) =>
  r.agents.find((a) => a.bus_name === name);

/** The deliver frame for `msgId`, from frames already received or still to come. */
async function delivered(d: Daemon, msgId: string) {
  for (;;) {
    const f = await d.next();
    if (f.type === "deliver" && f.msg_id === msgId) return f;
  }
}

/**
 * The former names stored for the agent now (or last) named `name`; OpenBus
 * #451: not its held names (see `holds`).
 */
const formerRows = (name: string) =>
  inHub((_, s) =>
    s.storage.sql
      .exec(
        "select f.name from former_names f join agents a on a.id = f.agent_id where a.name = ? and f.kind != 'held'",
        name,
      )
      .toArray()
      .map((r) => String(r.name)),
  );

/**
 * Runs the alarm until `done` (at most 50 runs): each run purges at most a
 * batch, and the whole file's rows (every test's clock) share the hub.
 */
async function alarmsUntil(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50 && !(await done()); i++)
    await runDurableObjectAlarm(await hubOf());
}

/** OpenBus #451: the held (left current-name) rows of `name`, as `namespace/global`. */
const holds = (name: string) =>
  inHub((_, st) =>
    st.storage.sql
      .exec(
        "select namespace, global from former_names where lname = ? and kind = 'held' order by rowid",
        name.toLowerCase(),
      )
      .toArray()
      .map((r) => `${String(r.namespace)}/${Number(r.global)}`),
  );

/**
 * The roster row and receipt as a client from before #1325 decodes them,
 * frozen here: strict objects with no `former_names` and no `to_name`.
 */
const OldRosterAgent = z.strictObject({
  bus_name: z.string(),
  kind: KindTokenSchema,
  namespace: WireNamespaceSchema,
  global: z.boolean(),
  state: z.enum(["live", "queued"]),
  machine_label: MachineLabelSchema.optional(),
  status: StatusStateSchema.optional(),
  status_label: StatusLabelSchema.optional(),
  status_at: IsoTimeSchema.optional(),
});
const OldRoster = z.strictObject({
  v: z.literal(1),
  id: z.string(),
  type: z.literal("roster"),
  agents: z.array(OldRosterAgent),
});
const OldReceipt = z.strictObject({
  v: z.literal(1),
  id: z.string(),
  type: z.literal("receipt"),
  msg_id: MsgIdSchema,
  state: ReceiptStateSchema,
  reason: ReceiptReasonSchema.optional(),
});

/**
 * `times` name changes by `rename`, alternating between two fresh names so
 * at most two chosen former names pile up (the agent's own former name is
 * free to it, and taking it back drops its row). Returns the current name.
 */
async function churn(d: Daemon, ref: string, times: number): Promise<string> {
  const pair = [uniq("Ping"), uniq("Pong")];
  let cur = "";
  for (let i = 0; i < times; i++) {
    cur = pair[i % 2] as string;
    expect((await renamed(d, ref, cur)).bus_name).toBe(cur);
  }
  return cur;
}

describe("rename (R393b)", () => {
  it("A→B: renamed with former; a send to A is delivered to it, with to_name B", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Alpha");
    const b = uniq("Bravo");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    const r = await renamed(d, "a", b);
    expect(r).toMatchObject({ agent_ref: "a", bus_name: b, former: a });

    const rc = await send(d, "s", a);
    expect(rc).toMatchObject({ state: "pending", to_name: b });
    const dl = await delivered(d, rc.msg_id);
    expect(dl.to_ref).toBe("a");
    // Any case of the former name resolves.
    expect(await send(d, "s", a.toUpperCase())).toMatchObject({
      state: "pending",
      to_name: b,
    });
    // The current name carries no to_name.
    const cur = await send(d, "s", b);
    expect(cur.state).toBe("pending");
    expect(cur.to_name).toBeUndefined();

    const ro = await list(d, "s");
    expect(row(ro, a)).toBeUndefined();
    const fn = row(ro, b)?.former_names;
    expect(fn).toHaveLength(1);
    expect(fn?.[0]?.name).toBe(a);
    const exp = Date.parse(fn?.[0]?.expires_at ?? "");
    expect(exp).toBeGreaterThan(Date.now() + GRACE - 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + GRACE + 1000);
    d.close();
  });

  it("a rename keeps status and the socket; others get roster_changed", async () => {
    const d = await at();
    const watcher = await at();
    const n = ns("rn");
    await reg(d, "a", uniq("Stat"), n);
    await reg(watcher, "w", uniq("Watch"), n);
    d.send({
      v: 1,
      id: id("st"),
      type: "status",
      from_ref: "a",
      state: "working",
      label: "busy",
    });
    const b = uniq("Stat2");
    await renamed(d, "a", b);
    const rc = await waitFor(watcher, "roster_changed");
    expect(rc.namespace).toBe(n);
    const ro = await list(d, "a");
    expect(row(ro, b)).toMatchObject({
      status: "working",
      status_label: "busy",
    });
    watcher.close();
    d.close();
  });

  it("after the grace, A is unknown_agent and the alarm purges the row", async () => {
    const t0 = Date.now() + 10 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const a = uniq("Gone");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    const here = uniq("Here");
    await renamed(d, "a", here);
    // The alarm is armed no later than the grace's end.
    const alarm = await inHub((_, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(t0 + GRACE);
    await setClock(t0 + GRACE - 1);
    expect((await send(d, "s", a)).state).toBe("pending");
    await setClock(t0 + GRACE);
    expect(await send(d, "s", a)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // No former_names once expired, even before the purge.
    const ro = await list(d, "s");
    expect(ro.agents.every((x) => x.former_names === undefined)).toBe(true);
    await runDurableObjectAlarm(await hubOf());
    expect(await formerRows(here)).toEqual([]);
    const rl = await inHub(
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>("select count(*) as n from rename_rl")
          .one().n,
    );
    expect(rl).toBe(0);
    d.close();
  });

  it("a chosen former name is reserved for the grace: a new agent asking for it gets A-2", async () => {
    const t0 = Date.now() + 20 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const a = uniq("Kept");
    await reg(d, "a", a, n);
    await renamed(d, "a", uniq("Moved"));
    expect(await reg(d, "x", a, n)).toBe(`${a}-2`);
    // A rename to it is de-collided the same way.
    await reg(d, "y", uniq("Other"), n);
    expect((await renamed(d, "y", a)).bus_name).toBe(`${a}-3`);
    // After the grace the name is free again.
    await setClock(t0 + GRACE);
    expect(await reg(d, "z", a, n)).toBe(a);
    d.close();
  });

  it("A→B→A is allowed and keeps former names distinct and never the current name", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Ping");
    const b = uniq("Pong");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    expect(await renamed(d, "a", a)).toMatchObject({ bus_name: a, former: b });
    await renamed(d, "a", b);
    const fn = row(await list(d, "s"), b)?.former_names;
    expect(fn?.map((f) => f.name)).toEqual([a]);
    expect(await formerRows(b)).toEqual([a]);
    d.close();
  });

  it("former names are newest first, at most maxFormerNames; a default one is dropped first, a chosen one never in its grace", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const c0 = uniq("C0");
    await reg(d, "a", c0, n);
    const c1 = uniq("C1");
    await renamed(d, "a", c1);
    // Four minted names in turn: each leaves a default former name.
    const minted: string[] = [];
    for (let i = 0; i < 4; i++)
      minted.push((await renamed(d, "a", uniq(`pb${i}`), "default")).bus_name);
    const current = uniq("C2");
    await renamed(d, "a", current);
    // Six left (c0, c1, four minted): the oldest DEFAULT one is dropped.
    const left = [c0, c1, ...minted];
    const kept = left.filter((x) => x !== minted[0]);
    expect((await formerRows(current)).sort()).toEqual([...kept].sort());
    const fn = row(await list(d, "s"), current)?.former_names ?? [];
    expect(fn.map((f) => f.name)).toEqual([...kept].reverse());
    for (let i = 1; i < fn.length; i++)
      expect(Date.parse(fn[i]?.expires_at ?? "")).toBeLessThanOrEqual(
        Date.parse(fn[i - 1]?.expires_at ?? ""),
      );
    // The dropped default name no longer resolves, and still is never handed
    // on; the oldest chosen one still resolves and stays reserved.
    expect(await send(d, "s", minted[0] as string)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await reg(d, "x", minted[0] as string, n)).toBe(`${minted[0]}-2`);
    expect(await send(d, "s", c0)).toMatchObject({
      state: "pending",
      to_name: current,
    });
    expect(await reg(d, "y", c0, n)).toBe(`${c0}-2`);
    d.close();
  });

  it("with maxFormerNames chosen names in grace, a 6th chosen rename is rate_limited; the oldest stays reserved (OpenBus #449 B1)", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n);
    let cur = mine;
    for (let i = 0; i < LIMITS.maxFormerNames; i++) {
      cur = uniq(`M${i}`);
      await renamed(d, "a", cur);
    }
    expect(await formerRows(cur)).toHaveLength(LIMITS.maxFormerNames);
    expect(await rename(d, "a", uniq("Sixth"))).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.room,
    });
    expect(await reg(d, "x", mine, n)).toBe(`${mine}-2`);
    const rc = await send(d, "s", mine);
    expect(rc).toMatchObject({ state: "pending", to_name: cur });
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
    // Back to one of its own former names is allowed: it frees that row.
    expect(await renamed(d, "a", mine)).toMatchObject({
      bus_name: mine,
      former: cur,
    });
    expect(await formerRows(mine)).toHaveLength(LIMITS.maxFormerNames);
    d.close();
  });

  it("the 11th rename in an hour is rate_limited with the pinned message; no-ops are free", async () => {
    const t0 = Date.now() + 30 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    let cur = uniq("Rate");
    await reg(d, "a", cur, n);
    const pair = [uniq("RateP"), uniq("RateQ")];
    for (let i = 0; i < LIMITS.renamesPerHour; i++) {
      // A no-op between every rename never counts.
      expect(await renamed(d, "a", cur)).not.toHaveProperty("former");
      cur = pair[i % 2] as string;
      await renamed(d, "a", cur);
    }
    const over = uniq("Over");
    const r = await rename(d, "a", over);
    expect(r).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.rate,
    });
    // A refusal changes nothing: the name stays.
    expect(row(await list(d, "a"), cur)).toBeDefined();
    expect(row(await list(d, "a"), over)).toBeUndefined();
    // Still free at the limit.
    expect(await renamed(d, "a", cur)).toEqual(
      expect.not.objectContaining({ former: expect.anything() }),
    );
    // A rolling hour.
    await setClock(t0 + GRACE + 1);
    expect((await renamed(d, "a", uniq("Later"))).former).toBe(cur);
    d.close();
  });

  it("a no-op answers renamed without former and records nothing", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Same");
    await reg(d, "a", a, n);
    const r = await renamed(d, "a", `  ${a} `);
    expect(r).toEqual({
      v: 1,
      id: r.id,
      type: "renamed",
      agent_ref: "a",
      bus_name: a,
    });
    expect(await formerRows(a)).toEqual([]);
    const rl = await inHub(
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.name = ?",
            a,
          )
          .one().n,
    );
    expect(rl).toBe(0);
    d.close();
  });

  it("a case-only change is a rename, with no former row (same name, any case)", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Casey");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    const r = await renamed(d, "a", a.toLowerCase());
    expect(r).toMatchObject({ bus_name: a.toLowerCase(), former: a });
    expect(await formerRows(a.toLowerCase())).toEqual([]);
    const rc = await send(d, "s", a);
    expect(rc.state).toBe("pending");
    expect(rc.to_name).toBeUndefined();
    d.close();
  });

  it("close keeps chosen former names reserved and holds the current name (agent_down, sessions; OpenBus #451); a revoke frees both (#1448)", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Closer");
    await reg(d, "a", a, n);
    const a2 = uniq("Closer2");
    await renamed(d, "a", a2);
    expect(await formerRows(a2)).toEqual([a]);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "x", a, n)).toBe(`${a}-2`);
    expect(await reg(d, "x2", a2, n)).toBe(`${a2}-2`);
    expect(await formerRows(a2)).toEqual([a]);

    const b = uniq("Sess");
    await reg(d, "b", b, n);
    const b2 = uniq("Sess2");
    await renamed(d, "b", b2);
    d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: ["b"] });
    expect(await reg(d, "y", b, n)).toBe(`${b}-2`);
    expect(await reg(d, "y2", b2, n)).toBe(`${b2}-2`);
    expect(await formerRows(b2)).toEqual([b]);

    const m = await machine("Revokee");
    const v = await daemon(m.token);
    v.send({
      v: 1,
      id: id("h"),
      type: "hello",
      machine_label: "M",
      client_version: "0.0.0",
      caps: [BUS_CAPS.rename],
    });
    await waitFor(v, "hello_ok");
    const c = uniq("Revoked");
    await reg(v, "rv", c, n);
    const c2 = uniq("Revoked2");
    await renamed(v, "rv", c2);
    expect(await (await hubOf()).revokeMachine(m.id)).toBe(true);
    expect(await reg(d, "z", c, n)).toBe(c);
    expect(await reg(d, "z2", c2, n)).toBe(c2);
    expect(await formerRows(c2)).toEqual([]);
    d.close();
  });

  it("rename from a non-live agent is not_registered", async () => {
    const d = await at();
    const n = ns("rn");
    expect(await rename(d, "nobody", "X")).toMatchObject({
      type: "error",
      code: "not_registered",
    });
    await reg(d, "a", uniq("Closed"), n);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await rename(d, "a", "X")).toMatchObject({
      type: "error",
      code: "not_registered",
    });
    // The socket stays usable.
    await reg(d, "b", uniq("After"), n);
    d.close();
  });

  it("a namespace-hidden former name is unknown_agent; a global's follows its visibility", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const a = uniq("Hidden");
    const g = uniq("GlobalOld");
    await reg(d, "a", a, n1);
    await reg(d, "g", g, n1, { global: true });
    await reg(d, "s", uniq("Outsider"), n2);
    await renamed(d, "a", uniq("Hidden2"));
    const gNew = uniq("GlobalNew");
    await renamed(d, "g", gNew);
    expect(await send(d, "s", a)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await send(d, "s", a, n1)).toMatchObject({
      state: "refused",
      reason: "other_namespace",
    });
    // A global's former name is visible wherever its current name is.
    expect(await send(d, "s", g)).toMatchObject({
      state: "pending",
      to_name: gNew,
    });
    expect(await send(d, "s", g, n1)).toMatchObject({
      state: "pending",
      to_name: gNew,
    });
    // ...and reserved globally.
    expect(await reg(d, "x", g, n2)).toBe(`${g}-2`);
    d.close();
  });

  it("the sender's own namespace comes first: its former name beats a live name elsewhere", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const shared = uniq("Shared");
    const moved = uniq("Moved");
    await reg(d, "g", uniq("Global"), n1, { global: true });
    await reg(d, "l", uniq("Local"), n1);
    await reg(d, "own", shared, n1);
    await renamed(d, "own", moved);
    // Not reserved in another namespace: a non-global there may take it.
    expect(await reg(d, "far", shared, n2)).toBe(shared);
    for (const from of ["g", "l"])
      expect(await send(d, from, shared)).toMatchObject({
        state: "pending",
        to_name: moved,
      });
    // The global sender reaches the other one only by naming its namespace.
    const there = await send(d, "g", shared, n2);
    expect(there.state).toBe("pending");
    expect(there.to_name).toBeUndefined();
    d.close();
  });

  it("a resend of a send through a former name repeats its to_name", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Re");
    const b = uniq("Re2");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    const f = {
      v: 1,
      id: id("s"),
      type: "send",
      from_ref: "s",
      to_name: a,
      body: "hi",
    } as ClientFrame;
    d.send(f);
    const first = await waitFor(d, "receipt");
    d.send(f);
    const again = await waitFor(d, "receipt");
    expect(again).toMatchObject({ msg_id: first.msg_id, to_name: b });
    d.close();
  });
});

describe("the rename gate: BUS_CAPS.rename in hello (#1325)", () => {
  it("an old-hello socket gets no former_names and no to_name, resolves the same, and decodes with the old strict schemas", async () => {
    const d = await at();
    const old = await at(false);
    const n = ns("rn");
    const a = uniq("Old");
    const b = uniq("New");
    await reg(old, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    await renamed(d, "a", b);

    const rc = await send(old, "s", a);
    expect(rc.state).toBe("pending");
    expect(rc).not.toHaveProperty("to_name");
    expect(OldReceipt.safeParse(rawFor(old, rc.id)).success).toBe(true);
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
    // A resend of it (same frame id and payload) carries none either.
    old.send({
      v: 1,
      id: rc.id,
      type: "send",
      from_ref: "s",
      to_name: a,
      body: "hi",
    } as ClientFrame);
    const again = await waitFor(old, "receipt");
    expect(again.msg_id).toBe(rc.msg_id);
    expect(again).not.toHaveProperty("to_name");
    expect(old.raw.filter((t) => t.includes(`"${rc.id}"`)).length).toBe(2);
    // Nor does a plain send to the current name.
    const plain = await send(old, "s", b);
    expect(plain).not.toHaveProperty("to_name");

    const ro = await list(old, "s");
    expect(row(ro, b)).toBeDefined();
    expect(ro.agents.every((x) => !("former_names" in x))).toBe(true);
    const frozen = OldRoster.safeParse(rawFor(old, ro.id));
    expect(frozen.success, JSON.stringify(frozen.error?.issues)).toBe(true);
    expect(old.raw.join("")).not.toContain("former_names");
    expect(old.raw.join("")).not.toContain('"to_name"');

    // The same roster on the caps socket fails the old schema: the gate is
    // what keeps the field away from old clients.
    await reg(d, "s2", uniq("CapsSender"), n);
    const capsRo = await list(d, "s2");
    expect(row(capsRo, b)?.former_names?.[0]?.name).toBe(a);
    expect(OldRoster.safeParse(rawFor(d, capsRo.id)).success).toBe(false);
    old.close();
    d.close();
  });

  it("a caps socket gets former_names and to_name; the caps are stored in the socket attachment", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Hib");
    const b = uniq("Hib2");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    const caps = await inHub((_, s) =>
      s
        .getWebSockets("daemon")
        .map((w) => (w.deserializeAttachment() as { caps?: string[] }).caps),
    );
    expect(caps).toContainEqual([BUS_CAPS.rename]);
    expect(await send(d, "s", a)).toMatchObject({ to_name: b });
    expect(row(await list(d, "s"), b)?.former_names).toHaveLength(1);
    d.close();
  });

  it("hello keeps the attachment's other fields", async () => {
    const d = await at();
    // A field set before hello (as a future one would be) survives it.
    await inHub((_, s) => {
      for (const w of s.getWebSockets("daemon")) {
        const a = w.deserializeAttachment() as Record<string, unknown>;
        w.serializeAttachment({ ...a, probe: 1 });
      }
    });
    d.send({
      v: 1,
      id: id("h"),
      type: "hello",
      machine_label: "MacBook",
      client_version: "0.0.0",
      caps: [BUS_CAPS.rename],
    });
    await waitFor(d, "hello_ok");
    const atts = await inHub((_, s) =>
      s
        .getWebSockets("daemon")
        .map((w) => w.deserializeAttachment() as Record<string, unknown>),
    );
    expect(atts).toContainEqual(
      expect.objectContaining({ probe: 1, caps: [BUS_CAPS.rename] }),
    );
    d.close();
  });

  it("a later hello without caps drops the gate on that socket", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Re-hello");
    const b = uniq("Re-hello2");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    d.send({
      v: 1,
      id: id("h"),
      type: "hello",
      machine_label: "MacBook",
      client_version: "0.0.0",
    });
    await waitFor(d, "hello_ok");
    const rc = await send(d, "s", a);
    expect(rc.state).toBe("pending");
    expect(rc).not.toHaveProperty("to_name");
    d.close();
  });

  it("an ordinary send never carries to_name, with or without caps", async () => {
    const d = await at();
    const n = ns("rn");
    const target = uniq("Plain");
    await reg(d, "t", target, n);
    for (const caps of [false, true]) {
      const s = await at(caps);
      await reg(s, "s", uniq("Sender"), n);
      for (const to of [target, target.toUpperCase()]) {
        const rc = await send(s, "s", to);
        expect(rc.state).toBe("pending");
        expect(rc).not.toHaveProperty("to_name");
      }
      s.close();
    }
    d.close();
  });
});

describe("review fixes (R393b)", () => {
  it("a global sender's former-name target held in two other namespaces, none its own, is ambiguous", async () => {
    const d = await at();
    const home = ns("rn");
    const n1 = ns("rn");
    const n2 = ns("rn");
    const x = uniq("Dup");
    await reg(d, "g", uniq("Glob"), home, { global: true });
    await reg(d, "a", x, n1);
    await renamed(d, "a", uniq("DupA"));
    // Not reserved in n2 (another scope): b takes it there, then leaves it.
    await reg(d, "b", x, n2);
    await renamed(d, "b", uniq("DupB"));
    expect(await send(d, "g", x)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // Naming a namespace picks one.
    expect((await send(d, "g", x, n1)).state).toBe("pending");
    d.close();
  });

  it("a rename of another machine's live agent_ref is not_registered", async () => {
    const mine = await at();
    const other = await at();
    const n = ns("rn");
    const a = uniq("Theirs");
    await reg(other, "theirs", a, n);
    expect(await rename(mine, "theirs", uniq("Stolen"))).toMatchObject({
      type: "error",
      code: "not_registered",
    });
    const r = await list(other, "theirs");
    expect(row(r, a)).toBeDefined();
    mine.close();
    other.close();
  });

  it("a chosen name never takes another agent's minted name, in or after its grace (OpenBus #446)", async () => {
    const t0 = Date.now() + 60 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "x", uniq("pi"), n, { kind: "default" });
    const xc = uniq("Xc");
    await renamed(d, "x", xc);
    // A new agent and a rename alike are de-collided, in any case.
    expect(await reg(d, "z", minted, n)).toBe(`${minted}-2`);
    expect((await renamed(d, "z", minted.toUpperCase())).bus_name).toBe(
      `${minted.toUpperCase()}-2`,
    );
    // The renamed agent still gets its mail, from no rival holder.
    const rc = await send(d, "s", minted);
    expect(rc).toMatchObject({ state: "pending", to_name: xc });
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("x");
    // After the grace, and after its agent closed, still never reused.
    await setClock(t0 + GRACE);
    // (z holds -2.)
    expect(await reg(d, "w", minted, n)).toBe(`${minted}-3`);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "x" });
    expect(await reg(d, "v", minted, n)).toBe(`${minted}-4`);
    // Its own agent may take it back.
    expect(await reg(d, "x", minted, n)).toBe(minted);
    d.close();
  });

  it("a global agent never takes a namespace's default former name (OpenBus #446)", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    await reg(d, "s", uniq("Sender"), n1);
    const minted = await reg(d, "x", uniq("pi"), n1, { kind: "default" });
    const xc = uniq("Xc");
    await renamed(d, "x", xc);
    expect(await reg(d, "g", minted, n2, { global: true })).toBe(`${minted}-2`);
    expect(await formerRows(xc)).toEqual([minted]);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: xc,
    });
    d.close();
  });

  it("two agents holding one former name in a scope is ambiguous, never either", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Twice");
    await reg(d, "a", a, n);
    await renamed(d, "a", uniq("A2"));
    const b2 = uniq("B2");
    await reg(d, "b", b2, n);
    // Seeded: commitName and the reservation keep this from happening.
    await inHub((_, st) =>
      st.storage.sql.exec(
        `insert into former_names (agent_id, org_id, name, lname, kind, expires_at, namespace, global)
         select id, org_id, ?, ?, 'chosen', ?, namespace, global from agents where name = ?`,
        a,
        a.toLowerCase(),
        Date.now() + GRACE,
        b2,
      ),
    );
    expect(await send(d, "s", a)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    d.close();
  });

  it("a namespace move or global flip keeps chosen former names in the old scope, resolving to no one (OpenBus #451)", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const foo = uniq("foo");
    await reg(d, "x", foo, n1);
    const x2 = uniq("X2");
    await renamed(d, "x", x2);
    await reg(d, "y", foo, n2);
    const y2 = uniq("Y2");
    await renamed(d, "y", y2);
    await reg(d, "s", uniq("Sender"), n2);
    // X flips global: its former `foo` stays reserved in n1 only, so it is
    // neither visible nor delivered in n2.
    expect(await reg(d, "x", x2, n1, { global: true })).toBe(x2);
    expect(await formerRows(x2)).toEqual([foo]);
    expect(await send(d, "s", foo)).toMatchObject({
      state: "pending",
      to_name: y2,
    });
    // A namespace move keeps them too (default ones go).
    const y3 = uniq("Y3");
    await renamed(d, "y", y3);
    expect(await formerRows(y3)).toHaveLength(2);
    expect(await reg(d, "y", y3, n1)).toBe(y3);
    expect((await formerRows(y3)).sort()).toEqual([foo, y2].sort());
    const minted = await reg(d, "p", uniq("pi"), n1, { kind: "default" });
    await renamed(d, "p", uniq("Pc"));
    const pc = uniq("Pc2");
    await renamed(d, "p", pc);
    expect(await reg(d, "p", pc, n2)).toBe(pc);
    expect(await formerRows(pc)).toHaveLength(1);
    expect(await reg(d, "q", minted, n1)).toBe(`${minted}-2`);
    d.close();
  });

  it("close keeps the rename log; a reopen within the hour is still limited (OpenBus #446)", async () => {
    const t0 = Date.now() + 70 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Log");
    await reg(d, "a", a, n);
    const first = uniq("Log0");
    await renamed(d, "a", first);
    const cur = await churn(d, "a", LIMITS.renamesPerHour - 1);
    const log = () =>
      inHub(
        (_, st) =>
          st.storage.sql
            .exec<{ n: number }>(
              "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.native_ref = ? and a.namespace = ?",
              "a",
              n,
            )
            .one().n,
      );
    expect(await log()).toBe(LIMITS.renamesPerHour);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    // OpenBus #451: its chosen former names stay reserved after the close.
    expect(await reg(d, "b", a, n)).toBe(`${a}-2`);
    // At the limit a reopen keeps its name (OpenBus #449 N1), counting
    // nothing.
    expect(await reg(d, "a", uniq("Reopened"), n)).toBe(cur);
    const reopened = cur;
    expect(await log()).toBe(LIMITS.renamesPerHour);
    expect(await rename(d, "a", uniq("Over"))).toMatchObject({
      type: "error",
      code: "rate_limited",
    });
    // Reopened in its scope, its former names in grace resolve again.
    expect(await formerRows(reopened)).toContain(first);
    expect(await send(d, "s", first)).toMatchObject({
      state: "pending",
      to_name: reopened,
    });
    // A rolling hour: the alarm purges the log, and renames work again.
    await setClock(t0 + GRACE + 1);
    await alarmsUntil(async () => (await log()) === 0);
    expect(await log()).toBe(0);
    await renamed(d, "a", uniq("Later"));
    d.close();
  });

  it("revoke drops the rename log", async () => {
    const m = await machine("Revokee");
    const v = await daemon(m.token);
    v.send({
      v: 1,
      id: id("h"),
      type: "hello",
      machine_label: "M",
      client_version: "0.0.0",
      caps: [BUS_CAPS.rename],
    });
    await waitFor(v, "hello_ok");
    await reg(v, "rv", uniq("Rv"), ns("rn"));
    await renamed(v, "rv", uniq("Rv2"));
    const log = () =>
      inHub(
        (_, st) =>
          st.storage.sql
            .exec<{ n: number }>(
              "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.machine_id = ?",
              m.id,
            )
            .one().n,
      );
    expect(await log()).toBe(1);
    expect(await (await hubOf()).revokeMachine(m.id)).toBe(true);
    expect(await log()).toBe(0);
  });

  it("at the limit, a re-sent name the agent holds as foo-2 is a no-op", async () => {
    const t0 = Date.now() + 40 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const foo = uniq("Foo");
    await reg(d, "o", foo, n);
    await reg(d, "a", uniq("Fa"), n);
    await churn(d, "a", LIMITS.renamesPerHour - 1);
    expect((await renamed(d, "a", foo)).bus_name).toBe(`${foo}-2`);
    const again = await renamed(d, "a", foo);
    expect(again.bus_name).toBe(`${foo}-2`);
    expect(again).not.toHaveProperty("former");
    expect(await rename(d, "a", uniq("Over"))).toMatchObject({
      code: "rate_limited",
    });
    d.close();
  });

  it("at the limit, a default rename to a different minted name is rate_limited and mints nothing", async () => {
    const t0 = Date.now() + 50 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    await reg(d, "x", uniq("Fx"), n);
    await churn(d, "x", LIMITS.renamesPerHour);
    const base = uniq("pibase");
    expect(await rename(d, "x", base, "default")).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.rate,
    });
    const mints = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from minted_names where lbase = ?",
            base.toLowerCase(),
          )
          .one().n,
    );
    expect(mints).toBe(0);
    d.close();
  });
});

describe("default names (R393b)", () => {
  const HEX4 = /-[0-9a-f]{4}$/;

  it("are minted <base>-<4 hex>, never minted again, and kept by their agent", async () => {
    const d = await at();
    const n = ns("rn");
    const base = uniq("pidef");
    const one = await reg(d, "p1", base, n, { kind: "default" });
    expect(one).toMatch(HEX4);
    expect(one.slice(0, -5)).toBe(base);
    const two = await reg(d, "p2", base, n, { kind: "default" });
    expect(two).toMatch(HEX4);
    expect(two).not.toBe(one);
    // A re-sent agent_up (reconnect) and a reopen keep the agent's own.
    expect(await reg(d, "p1", base, n, { kind: "default" })).toBe(one);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "p1" });
    const three = await reg(d, "p3", base, n, { kind: "default" });
    expect(three).not.toBe(one);
    expect(await reg(d, "p1", base, n, { kind: "default" })).toBe(one);
    // A default rename back to the base is a no-op.
    expect(await renamed(d, "p1", base, "default")).not.toHaveProperty(
      "former",
    );
    // Absent name_kind is chosen: no suffix.
    const chosen = uniq("pichosen");
    expect(await reg(d, "c", chosen, n)).toBe(chosen);
    d.close();
  });

  it("a long base keeps the suffix within the name cap", async () => {
    const d = await at();
    const base = `x${"y".repeat(70)}`;
    const name = await reg(d, "long", base, ns("rn"), { kind: "default" });
    expect(name.length).toBeLessThanOrEqual(LIMITS.maxBusNameChars);
    expect(name).toMatch(HEX4);
    d.close();
  });

  it("a former default name resolves for the grace and is never handed to another agent", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "p", uniq("pi"), n, { kind: "default" });
    const chosen = uniq("Picked");
    expect(await renamed(d, "p", chosen, "chosen")).toMatchObject({
      bus_name: chosen,
      former: minted,
    });
    // Stored as a default former name: the minted name itself is what no
    // one else can take (OpenBus #446).
    const kind = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ kind: string }>(
            "select kind from former_names where lname = ?",
            minted.toLowerCase(),
          )
          .one().kind,
    );
    expect(kind).toBe("default");
    expect(await reg(d, "x", minted, n)).toBe(`${minted}-2`);
    const rc = await send(d, "s", minted);
    expect(rc).toMatchObject({ state: "pending", to_name: chosen });
    await delivered(d, rc.msg_id).then((f) => expect(f.to_ref).toBe("p"));
    d.close();
  });

  it("a default rename mints a name too", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Named");
    await reg(d, "p", a, n);
    const base = uniq("codex");
    const r = await renamed(d, "p", base, "default");
    expect(r.bus_name).toMatch(HEX4);
    expect(r.bus_name.slice(0, -5)).toBe(base);
    expect(r.former).toBe(a);
    d.close();
  });
});

describe("#420: a reply to a renamed agent's old name", () => {
  it("reaches it across machines in one namespace during the grace", async () => {
    // A default-named session on the workstation messaged the MacBook, then
    // took its chosen name; the reply to the old name must still arrive.
    const work = await at();
    const mac = await at();
    const n = ns("i420");
    const base = uniq("codex");
    const old = await reg(work, "w", base, n, { kind: "default" });
    expect(old).toMatch(new RegExp(`^${base}-[0-9a-f]{4}$`));
    await reg(mac, "o", uniq("OA Owner"), n);
    const chosen = uniq("OA Product");
    await renamed(work, "w", chosen, "chosen");

    const rc = await send(mac, "o", old);
    expect(rc).toMatchObject({ state: "pending", to_name: chosen });
    expect((await delivered(work, rc.msg_id)).to_ref).toBe("w");
    work.close();
    mac.close();
  });
});

describe("repeat agent_up rename (#1323) is a rename (OpenBus #446)", () => {
  it("records the former name, reserves it and counts in the rate limit, with or without caps", async () => {
    // Old clients rename this way; resolution must be safe for them too.
    for (const caps of [true, false]) {
      const d = await at(caps);
      const n = ns("rn");
      await reg(d, "s", uniq("Sender"), n);
      const alice = uniq("Alice");
      expect(await reg(d, "a", alice, n)).toBe(alice);
      const bob = uniq("Bob");
      expect(await reg(d, "a", bob, n)).toBe(bob);
      expect(await formerRows(bob)).toEqual([alice]);
      // Reserved for the grace: a stranger gets alice-2, mail reaches bob.
      expect(await reg(d, "m", alice, n)).toBe(`${alice}-2`);
      const rc = await send(d, "s", alice);
      expect(rc.state).toBe("pending");
      expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
      // An unchanged re-send is no rename and never counts.
      expect(await reg(d, "a", bob, n)).toBe(bob);
      let cur = bob;
      const pair = [uniq("AP"), uniq("AQ")];
      for (let i = 1; i < LIMITS.renamesPerHour; i++) {
        cur = pair[i % 2] as string;
        expect(await reg(d, "a", cur, n)).toBe(cur);
      }
      // At the limit the agent_up still succeeds, keeping the current name.
      expect(await reg(d, "a", uniq("Over"), n)).toBe(cur);
      if (caps)
        expect(await rename(d, "a", uniq("Over2"))).toMatchObject({
          type: "error",
          code: "rate_limited",
        });
      d.close();
    }
  });

  it("a minted former name is kept as a default one, never handed on", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "p", uniq("pi"), n, { kind: "default" });
    const chosen = uniq("Chosen");
    expect(await reg(d, "p", chosen, n)).toBe(chosen);
    const kind = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ kind: string }>(
            "select kind from former_names where lname = ?",
            minted.toLowerCase(),
          )
          .one().kind,
    );
    expect(kind).toBe("default");
    expect(await reg(d, "q", minted, n)).toBe(`${minted}-2`);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: chosen,
    });
    d.close();
  });

  it("a repeat agent_up back to the agent's own former name swaps the rows", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("BackA");
    const b = uniq("BackB");
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    expect(await formerRows(b)).toEqual([a]);
    expect(await reg(d, "a", a, n)).toBe(a);
    expect(await formerRows(a)).toEqual([b]);
    d.close();
  });
});

describe("retro review holes (OpenBus #446)", () => {
  it("live agent_up re-sends never push a chosen former name in its grace out; past the room the name is kept", async () => {
    const d = await at();
    const n = ns("adv");
    await reg(d, "s", uniq("Sender"), n);
    const alice = uniq("Alice");
    expect(await reg(d, "a", alice, n)).toBe(alice);
    const names = [alice];
    for (let i = 0; i < 15; i++) {
      const next = uniq("A");
      const got = await reg(d, "a", next, n);
      if (i < LIMITS.maxFormerNames) {
        expect(got).toBe(next);
        names.push(got);
      } else expect(got).toBe(names.at(-1));
    }
    // alice, the oldest, is still reserved and still reaches the agent.
    expect(await reg(d, "m", alice, n)).toBe(`${alice}-2`);
    const rc = await send(d, "s", alice);
    await delivered(d, rc.msg_id).then((f) => expect(f.to_ref).toBe("a"));
    expect(await rename(d, "a", uniq("B"))).toMatchObject({
      type: "error",
      code: "rate_limited",
    });
    d.close();
  });

  it("agent_down + agent_up does not reset the rename rate limit", async () => {
    const d = await at();
    const n = ns("adv");
    await reg(d, "a", uniq("A"), n);
    await churn(d, "a", LIMITS.renamesPerHour);
    expect((await rename(d, "a", uniq("C"))).type).toBe("error");
    d.send({ v: 1, id: id("dn"), type: "agent_down", agent_ref: "a" });
    await reg(d, "a", uniq("A"), n);
    expect(await rename(d, "a", uniq("C"))).toMatchObject({
      type: "error",
      code: "rate_limited",
    });
    d.close();
  });
});

describe("OpenBus #449: review of #446", () => {
  it("an agent_up keeps the current name with maxFormerNames chosen names in grace", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n);
    let cur = mine;
    for (let i = 0; i < LIMITS.maxFormerNames; i++) {
      cur = uniq(`U${i}`);
      expect(await reg(d, "a", cur, n)).toBe(cur);
    }
    expect(await reg(d, "a", uniq("Sixth"), n)).toBe(cur);
    expect(await reg(d, "x", mine, n)).toBe(`${mine}-2`);
    expect(await send(d, "s", mine)).toMatchObject({
      state: "pending",
      to_name: cur,
    });
    d.close();
  });

  it("an agent_up namespace move at the limit is kept in its scope and name (move_kept, OpenBus #451 review)", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    await reg(d, "a", uniq("Mover"), n1);
    const cur = await churn(d, "a", LIMITS.renamesPerHour);
    expect(await reg(d, "a", uniq("Elsewhere"), n2)).toBe(cur);
    // Nothing moved: its former names are where they were.
    expect(await formerRows(cur)).toHaveLength(2);
    const ns2 = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ namespace: string }>(
            "select namespace from agents where name = ? and live = 1",
            cur,
          )
          .one().namespace,
    );
    expect(ns2).toBe(n1);
    d.close();
  });

  it("an agent_up namespace move with maxFormerNames chosen names in grace moves under its current name; the names stay reserved in the old namespace (OpenBus #451)", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const full = uniq("Full");
    await reg(d, "a", full, n1);
    let cur = "";
    for (let i = 0; i < LIMITS.maxFormerNames; i++)
      cur = (await renamed(d, "a", uniq(`F${i}`))).bus_name;
    expect(await formerRows(cur)).toHaveLength(LIMITS.maxFormerNames);
    // The move would leave a sixth chosen name: no room, so the name is kept.
    expect(await reg(d, "a", uniq("Moved"), n2)).toBe(cur);
    expect(await formerRows(cur)).toHaveLength(LIMITS.maxFormerNames);
    expect(await reg(d, "x", full, n1)).toBe(`${full}-2`);
    d.close();
  });

  it("a chosen name in another non-global namespace never takes a minted one", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const minted = await reg(d, "x", uniq("pi"), n1, { kind: "default" });
    expect(await reg(d, "y", minted, n2)).toBe(`${minted}-2`);
    d.close();
  });

  it("an agent_up case-only change counts, with no former row", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Casey");
    await reg(d, "a", a, n);
    expect(await reg(d, "a", a.toLowerCase(), n)).toBe(a.toLowerCase());
    expect(await formerRows(a.toLowerCase())).toEqual([]);
    const log = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.name = ?",
            a.toLowerCase(),
          )
          .one().n,
    );
    expect(log).toBe(1);
    const rc = await send(d, "s", a);
    expect(rc.state).toBe("pending");
    expect(rc.to_name).toBeUndefined();
    d.close();
  });

  it("a reopen under a new name counts in the rate limit, with no former name (N1)", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Reo");
    await reg(d, "a", a, n);
    const cur = await churn(d, "a", LIMITS.renamesPerHour - 1);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    const b = uniq("Reo2");
    expect(await reg(d, "a", b, n)).toBe(b);
    // OpenBus #451: no former row for the old name; the close holds it.
    expect(await formerRows(b)).not.toContain(cur);
    expect(await holds(cur)).toEqual([`${n}/0`]);
    expect(await reg(d, "o", cur, n)).toBe(`${cur}-2`);
    // That was the 10th change: the next reopen keeps its name.
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "a", uniq("Reo3"), n)).toBe(b);
    d.close();
  });

  it("an agent holding another's minted name (the old hole) gets -2 on its next agent_up, leaving no former row (N3)", async () => {
    const d = await at();
    const n = ns("rn");
    const minted = await reg(d, "x", uniq("pi"), n, { kind: "default" });
    await renamed(d, "x", uniq("Xc"));
    const z = uniq("Zed");
    await reg(d, "z", z, n);
    // Seeded: what the pre-#446 hub allowed.
    await inHub((_, st) =>
      st.storage.sql.exec(
        "update agents set name = ? where name = ?",
        minted,
        z,
      ),
    );
    expect(await reg(d, "z", minted, n)).toBe(`${minted}-2`);
    expect(await formerRows(`${minted}-2`)).toEqual([]);
    // Its own agent takes it back.
    expect((await renamed(d, "x", minted)).bus_name).toBe(minted);
    d.close();
  });
});

describe("wipe (erase) and the R393b tables", () => {
  it("deletes former_names, minted_names and rename_rl, and leaves them empty and usable", async () => {
    const who = await member();
    const d = await at(true, who.userId);
    const n = ns("rn");
    await reg(d, "p", uniq("pi"), n, { kind: "default" });
    await renamed(d, "p", uniq("Chosen"));
    const counts = () =>
      inHub(
        (_, s) =>
          ["former_names", "minted_names", "rename_rl"].map(
            (t) =>
              s.storage.sql
                .exec<{ n: number }>(`select count(*) as n from ${t}`)
                .one().n,
          ),
        who.userId,
      );
    expect(await counts()).toEqual([1, 1, 1]);
    await (await hubOf(who.userId)).wipe();
    await d.closed;
    expect(await counts()).toEqual([0, 0, 0]);
    // Usable after the wipe: a new socket can rename again.
    const d2 = await at(true, who.userId);
    await reg(d2, "q", uniq("Again"), n);
    await renamed(d2, "q", uniq("Again2"));
    expect((await counts())[0]).toBe(1);
    d2.close();
  });
});

describe("OpenBus #451: a move or global flip keeps chosen former names reserved", () => {
  /** rename_rl rows of the live agent `ref` on any machine named `name`. */
  const log = (name: string) =>
    inHub(
      (_, st) =>
        st.storage.sql
          .exec(
            "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.name = ?",
            name,
          )
          .one().n,
    );

  it("a namespace move: a stranger in the old namespace gets -2 and its mail is refused, until the grace ends", async () => {
    const t0 = Date.now() + 80 * GRACE;
    await setClock(t0);
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const n3 = ns("rn");
    await reg(d, "s1", uniq("Sender"), n1);
    await reg(d, "s2", uniq("Sender"), n2);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    const other = uniq("Other");
    await renamed(d, "a", other);
    expect(await reg(d, "a", other, n2)).toBe(other);
    // Still reserved in n1, and for a global; free in another namespace.
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    expect(await reg(d, "g", mine, n3, { global: true })).toBe(`${mine}-3`);
    // It resolves to no one: not delivered to the moved agent.
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // Nor in its new namespace, where it was never its name.
    expect(await send(d, "s2", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // The roster shows no former name the agent cannot be reached by.
    expect(row(await list(d, "s2"), other)?.former_names).toBeUndefined();
    // Taking the name back in n2 keeps the n1 reservation.
    await renamed(d, "a", mine);
    expect(await reg(d, "y", mine, n1)).toBe(`${mine}-4`);
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // After the grace the name is free in n1.
    await setClock(t0 + GRACE);
    expect(await reg(d, "z", mine, n1)).toBe(mine);
    d.close();
  });

  it("a global flip, both ways: the old scope keeps the reservation and refuses its mail", async () => {
    const t0 = Date.now() + 90 * GRACE;
    await setClock(t0);
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    await reg(d, "s1", uniq("Sender"), n1);
    await reg(d, "s2", uniq("Sender"), n2);
    // Non-global to global.
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    const other = uniq("Other");
    await renamed(d, "a", other);
    expect(await reg(d, "a", other, n1, { global: true })).toBe(other);
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await send(d, "s1", mine, n1)).toMatchObject({
      state: "refused",
    });
    // Global to non-global: the reservation was everywhere, and stays so.
    const gmine = uniq("GMine");
    await reg(d, "b", gmine, n1, { global: true });
    const gother = uniq("GOther");
    await renamed(d, "b", gother);
    expect(await reg(d, "b", gother, n1)).toBe(gother);
    expect(await reg(d, "y", gmine, n2)).toBe(`${gmine}-2`);
    expect(await send(d, "s1", gmine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    await setClock(t0 + GRACE);
    expect(await reg(d, "z", mine, n1)).toBe(mine);
    expect(await reg(d, "w", gmine, n2)).toBe(gmine);
    d.close();
  });

  it("a move that also changes the name reserves the old one in the old namespace", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    await reg(d, "s1", uniq("Sender"), n1);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    const other = uniq("Other");
    expect(await reg(d, "a", other, n2)).toBe(other);
    expect(await log(other)).toBe(1);
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    d.close();
  });

  it("a same-name move with maxFormerNames chosen names in grace cannot escape the room check", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    const left = [mine];
    let cur = mine;
    for (let i = 0; i < LIMITS.maxFormerNames; i++) {
      cur = uniq(`M${i}`);
      await renamed(d, "a", cur);
      left.push(cur);
    }
    left.pop();
    expect(await reg(d, "a", cur, n2)).toBe(cur);
    // The move counts once (OpenBus #451 review: every scope change counts)...
    expect(await log(cur)).toBe(LIMITS.maxFormerNames + 1);
    // ...and the five reservations still fill the room.
    expect(await rename(d, "a", uniq("Sixth"))).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.room,
    });
    expect(await reg(d, "a", uniq("Sixth"), n2)).toBe(cur);
    for (const f of left) expect(await reg(d, id("x"), f, n1)).toBe(`${f}-2`);
    d.close();
  });

  it("taking back a name left in the old namespace still needs room: that row is in another scope", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    let cur = mine;
    for (let i = 0; i < LIMITS.maxFormerNames; i++) {
      cur = uniq(`T${i}`);
      await renamed(d, "a", cur);
    }
    expect(await reg(d, "a", cur, n2)).toBe(cur);
    // `mine` in n2 would leave `cur` there while the n1 row of `mine` stays:
    // a sixth chosen reservation.
    expect(await rename(d, "a", mine)).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.room,
    });
    expect(await formerRows(cur)).toHaveLength(LIMITS.maxFormerNames);
    d.close();
  });
});

describe("OpenBus #451 nits", () => {
  it("a reopen de-collided from its own name counts nothing (N1)", async () => {
    const t0 = Date.now() + 65 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const dup = uniq("Dup");
    await reg(d, "a", dup, n);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    // OpenBus #451: the close holds the name for the grace; then another
    // takes it.
    expect(await reg(d, "o", dup, n)).toBe(`${dup}-2`);
    await setClock(t0 + GRACE);
    expect(await reg(d, "o2", dup, n)).toBe(dup);
    expect(await reg(d, "a", dup, n)).toBe(`${dup}-3`);
    const log = await inHub(
      (_, st) =>
        st.storage.sql
          .exec(
            "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.name = ?",
            `${dup}-3`,
          )
          .one().n,
    );
    expect(log).toBe(0);
    d.close();
  });

  it("10 fresh renames in an hour, 5 of them minted: the defaults are dropped first at the limit (N3)", async () => {
    const t0 = Date.now() + 100 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const c0 = uniq("C0");
    await reg(d, "a", c0, n);
    const minted: string[] = [];
    for (let i = 0; i < 5; i++)
      minted.push((await renamed(d, "a", uniq(`pd${i}`), "default")).bus_name);
    const chosen = [c0];
    let cur = "";
    for (let i = 1; i <= 5; i++) {
      cur = uniq(`C${i}`);
      await renamed(d, "a", cur);
      chosen.push(cur);
    }
    chosen.pop();
    // Every default row went first; the five chosen ones are all kept.
    expect((await formerRows(cur)).sort()).toEqual([...chosen].sort());
    expect(await rename(d, "a", uniq("Over"))).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.rate,
    });
    for (const m of minted) {
      expect(await send(d, "s", m)).toMatchObject({
        state: "refused",
        reason: "unknown_agent",
      });
      expect(await reg(d, id("x"), m, n)).toBe(`${m}-2`);
    }
    for (const c of chosen) {
      expect(await send(d, "s", c)).toMatchObject({
        state: "pending",
        to_name: cur,
      });
      expect(await reg(d, id("y"), c, n)).toBe(`${c}-2`);
    }
    d.close();
  });
});

it("OpenBus #451: migrateHub anchors existing former names to their agent's scope", async () => {
  const d = await at();
  const n = ns("rn");
  const a = uniq("Mig");
  await reg(d, "a", a, n, { global: true });
  const b = uniq("Mig2");
  await renamed(d, "a", b);
  const got = await inHub((_, st) => {
    const sql = st.storage.sql;
    sql.exec("alter table former_names drop column namespace");
    sql.exec("alter table former_names drop column global");
    migrateHub(sql);
    migrateHub(sql);
    return sql
      .exec(
        "select namespace, global from former_names where lname = ?",
        a.toLowerCase(),
      )
      .one();
  });
  expect(got).toEqual({ namespace: n, global: 1 });
  d.close();
});

it("OpenBus #452: a global's unscoped send is ambiguous across a current name and a former name in other namespaces", async () => {
  const d = await at();
  const x = ns("rn");
  const y = ns("rn");
  const z = ns("rn");
  const alice = uniq("alice");
  await reg(d, "a", alice, x);
  const bob = uniq("bob");
  await renamed(d, "a", bob);
  expect(await reg(d, "c", alice, y)).toBe(alice);
  await reg(d, "g", uniq("G"), z, { global: true });
  expect(await send(d, "g", alice)).toMatchObject({
    state: "refused",
    reason: "ambiguous",
  });
  // A namespace given picks one.
  const toC = await send(d, "g", alice, y);
  expect(toC.state).toBe("pending");
  expect(toC.to_name).toBeUndefined();
  expect((await delivered(d, toC.msg_id)).to_ref).toBe("c");
  // The global sender's own namespace still comes first.
  await reg(d, "h", uniq("H"), x, { global: true });
  expect(await send(d, "h", alice)).toMatchObject({
    state: "pending",
    to_name: bob,
  });
  d.close();
});

describe("OpenBus #451 review of 8038558", () => {
  for (const how of ["move", "flip"] as const)
    it(`OpenBus #452 stays ambiguous after the renamed agent's ${how}`, async () => {
      const d = await at();
      const x = ns("rn");
      const y = ns("rn");
      const z = ns("rn");
      const w = ns("rn");
      const alice = uniq("alice");
      await reg(d, "a", alice, x);
      const bob = uniq("bob");
      await renamed(d, "a", bob);
      expect(await reg(d, "c", alice, y)).toBe(alice);
      await reg(d, "g", uniq("G"), z, { global: true });
      expect(await send(d, "g", alice)).toMatchObject({
        state: "refused",
        reason: "ambiguous",
      });
      if (how === "move") expect(await reg(d, "a", bob, w)).toBe(bob);
      else expect(await reg(d, "a", bob, x, { global: true })).toBe(bob);
      expect(await send(d, "g", alice)).toMatchObject({
        state: "refused",
        reason: "ambiguous",
      });
      d.close();
    });

  it("a live move whose name gets a suffix reserves the old name in the old namespace", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    expect(await reg(d, "c", mine, n2)).toBe(mine);
    expect(await reg(d, "a", mine, n2)).toBe(`${mine}-2`);
    expect(await holds(mine)).toEqual([`${n1}/0`]);
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    d.close();
  });

  it("a global moving its home namespace keeps its former names resolving", async () => {
    const d = await at();
    const n1 = ns("rn");
    const n2 = ns("rn");
    const n3 = ns("rn");
    await reg(d, "s", uniq("Sender"), n3);
    const g = uniq("Glob");
    await reg(d, "a", g, n1, { global: true });
    const g2 = uniq("Glob2");
    await renamed(d, "a", g2);
    expect(await reg(d, "a", g2, n2, { global: true })).toBe(g2);
    expect(await send(d, "s", g)).toMatchObject({
      state: "pending",
      to_name: g2,
    });
    expect(
      row(await list(d, "s"), g2)?.former_names?.map((f) => f.name),
    ).toEqual([g]);
    expect(await reg(d, "x", g, n3)).toBe(`${g}-2`);
    // A default former name stays too: the scope did not change.
    const minted = await reg(d, "b", uniq("gpi"), n1, {
      global: true,
      kind: "default",
    });
    const b2 = uniq("GlobB");
    await renamed(d, "b", b2);
    expect(await reg(d, "b", b2, n2, { global: true })).toBe(b2);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: b2,
    });
    d.close();
  });
});

describe("OpenBus #451 review of 35017e2", () => {
  it("a former name elsewhere is ambiguous against another agent's left-behind reservation (F1)", async () => {
    const d = await at();
    const x = ns("rn");
    const y = ns("rn");
    const z = ns("rn");
    const w = ns("rn");
    const alice = uniq("alice");
    await reg(d, "a", alice, x);
    const bob = uniq("bob");
    await renamed(d, "a", bob);
    expect(await reg(d, "a", bob, w)).toBe(bob);
    expect(await reg(d, "e", alice, y)).toBe(alice);
    await renamed(d, "e", uniq("eve"));
    await reg(d, "g", uniq("G"), z, { global: true });
    expect(await send(d, "g", alice)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    d.close();
  });

  it("a global sender's own left-behind reservation never makes its send ambiguous (F2)", async () => {
    const d = await at();
    const x = ns("rn");
    const y = ns("rn");
    const alice = uniq("alice");
    await reg(d, "a", alice, x);
    const bob = uniq("bob");
    await renamed(d, "a", bob);
    expect(await reg(d, "a", bob, x, { global: true })).toBe(bob);
    expect(await reg(d, "c", alice, y)).toBe(alice);
    const rc = await send(d, "a", alice);
    expect(rc.state).toBe("pending");
    expect(rc.to_name).toBeUndefined();
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("c");
    d.close();
  });
});

describe("OpenBus #451: a session leaving a namespace holds its name there for 1 h", () => {
  // #1448: a revoke holds nothing (its own describe below).
  for (const how of ["agent_down", "sessions"] as const)
    it(`a close by ${how}: a stranger gets -2 and mail is refused, for the hour; then the name is free`, async () => {
      const t0 = Date.now() + 100 * GRACE + seq * 1000;
      await setClock(t0);
      const d = await at();
      const n = ns("lv");
      await reg(d, "s", uniq("Sender"), n);
      const mine = uniq("Mine");
      await reg(d, "a", mine, n);
      if (how === "agent_down")
        d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
      else
        d.send({
          v: 1,
          id: id("c"),
          type: "sessions",
          open: [],
          closed: ["a"],
        });
      expect(await reg(d, "x", mine, n)).toBe(`${mine}-2`);
      // Never delivered to the stranger: the closed name's own refusal.
      expect(await send(d, "s", mine)).toMatchObject({
        state: "refused",
        reason: "closed",
      });
      expect(await holds(mine)).toEqual([`${n}/0`]);
      // The alarm purges the hold at the hour; then the name is free.
      await setClock(t0 + GRACE);
      await alarmsUntil(async () => (await holds(mine)).length === 0);
      expect(await holds(mine)).toEqual([]);
      expect(await reg(d, "y", mine, n)).toBe(mine);
      d.close();
    });

  it("a close arms the alarm for the hold's end", async () => {
    const t0 = Date.now() + 120 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("lv");
    await reg(d, "a", uniq("Arm"), n);
    await inHub((_, st) => st.storage.deleteAlarm());
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    await reg(d, "b", uniq("Other"), n);
    const t = await inHub((_, st) => st.storage.getAlarm());
    expect(t).not.toBeNull();
    expect(t as number).toBeLessThanOrEqual(t0 + GRACE);
    d.close();
  });

  it("a reopen in the same scope takes its held name back; its former names in grace stayed reserved and resolve again", async () => {
    const t0 = Date.now() + 130 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("lv");
    await reg(d, "s", uniq("Sender"), n);
    const old = uniq("Old");
    await reg(d, "a", old, n);
    const mine = uniq("Mine");
    await renamed(d, "a", mine);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    // The chosen former name stays reserved after the close, resolving to no one.
    expect(await reg(d, "x", old, n)).toBe(`${old}-2`);
    expect(await send(d, "s", old)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await reg(d, "a", mine, n)).toBe(mine);
    expect(await holds(mine)).toEqual([]);
    const rc = await send(d, "s", old);
    expect(rc).toMatchObject({ state: "pending", to_name: mine });
    expect(
      row(await list(d, "s"), mine)?.former_names?.map((f) => f.name),
    ).toEqual([old]);
    d.close();
  });

  it("a reopen under another name leaves the old one held, never resolving to it", async () => {
    const d = await at();
    const n = ns("lv");
    await reg(d, "s", uniq("Sender"), n);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    const next = uniq("Next");
    expect(await reg(d, "a", next, n)).toBe(next);
    expect(await reg(d, "x", mine, n)).toBe(`${mine}-2`);
    expect(await send(d, "s", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(row(await list(d, "s"), next)?.former_names).toBeUndefined();
    d.close();
  });

  it("a same-name move: the old namespace holds it and refuses its mail as unknown_agent; moving back takes it back", async () => {
    const t0 = Date.now() + 140 * GRACE;
    await setClock(t0);
    const d = await at();
    const n1 = ns("lv");
    const n2 = ns("lv");
    await reg(d, "s1", uniq("Sender"), n1);
    await reg(d, "s2", uniq("Sender"), n2);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    expect(await reg(d, "a", mine, n2)).toBe(mine);
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    const rc = await send(d, "s2", mine);
    expect(rc.state).toBe("pending");
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
    // Moving back takes it back (and holds it in n2 in turn).
    expect(await reg(d, "a", mine, n1)).toBe(mine);
    expect(await holds(mine)).toEqual([`${n2}/0`]);
    expect(await reg(d, "y", mine, n2)).toBe(`${mine}-2`);
    await setClock(t0 + GRACE);
    expect(await reg(d, "z", mine, n2)).toBe(mine);
    d.close();
  });

  it("a -2 move holds the old name, and it never resolves, even once the agent is back in that namespace", async () => {
    const d = await at();
    const n1 = ns("lv");
    const n2 = ns("lv");
    await reg(d, "s1", uniq("Sender"), n1);
    const mine = uniq("Mine");
    await reg(d, "a", mine, n1);
    expect(await reg(d, "c", mine, n2)).toBe(mine);
    expect(await reg(d, "a", mine, n2)).toBe(`${mine}-2`);
    expect(await holds(mine)).toEqual([`${n1}/0`]);
    const back = uniq("Back");
    expect(await reg(d, "a", back, n1)).toBe(back);
    expect(await reg(d, "x", mine, n1)).toBe(`${mine}-2`);
    expect(await send(d, "s1", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(row(await list(d, "s1"), back)?.former_names).toBeUndefined();
    d.close();
  });

  it("a -2 move with no room (rename_kept) holds the old name too", async () => {
    const d = await at();
    const n1 = ns("lv");
    const n2 = ns("lv");
    await reg(d, "s1", uniq("Sender"), n1);
    await reg(d, "a", uniq("Lim"), n1);
    let cur = "";
    for (let i = 0; i < LIMITS.maxFormerNames; i++) {
      cur = uniq(`R${i}`);
      await renamed(d, "a", cur);
    }
    expect(await reg(d, "c", cur, n2)).toBe(cur);
    expect(await reg(d, "a", cur, n2)).toBe(`${cur}-2`);
    expect(await reg(d, "x", cur, n1)).toBe(`${cur}-2`);
    expect(await send(d, "s1", cur)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    d.close();
  });

  it("a same-name global flip holds the name in the scope left", async () => {
    const t0 = Date.now() + 150 * GRACE;
    await setClock(t0);
    const d = await at();
    const n1 = ns("lv");
    const n2 = ns("lv");
    await reg(d, "s2", uniq("Sender"), n2);
    const g = uniq("Glob");
    await reg(d, "a", g, n1, { global: true });
    expect(await reg(d, "a", g, n1)).toBe(g);
    expect(await holds(g)).toEqual([`${n1}/1`]);
    expect(await reg(d, "x", g, n2)).toBe(`${g}-2`);
    expect(await send(d, "s2", g)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // Back to global takes it back.
    expect(await reg(d, "a", g, n1, { global: true })).toBe(g);
    expect(await holds(g)).toEqual([`${n1}/0`]);
    d.close();
  });

  it("a global's unscoped send is ambiguous across a live name and a closed agent's held one", async () => {
    const d = await at();
    const x = ns("lv");
    const y = ns("lv");
    const z = ns("lv");
    const alice = uniq("alice");
    await reg(d, "a", alice, x);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "c", alice, y)).toBe(alice);
    await reg(d, "g", uniq("G"), z, { global: true });
    expect(await send(d, "g", alice)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // Scoped to y it resolves.
    expect((await send(d, "g", alice, y)).state).toBe("pending");
    d.close();
  });

  it("a close drops default former names, as a move does", async () => {
    const d = await at();
    const n = ns("lv");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "a", uniq("pi"), n, { kind: "default" });
    const c = uniq("Chosen");
    await renamed(d, "a", c);
    expect(await formerRows(c)).toEqual([minted]);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "a", c, n)).toBe(c);
    expect(await formerRows(c)).toEqual([]);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    d.close();
  });

  it("held rows never crowd out default former names from the per-agent cap", async () => {
    const d = await at();
    const [n1, n2, n3] = [ns("lv"), ns("lv"), ns("lv")];
    const base = uniq("pi");
    const m0 = await reg(d, "a", base, n1, { kind: "default" });
    expect(await reg(d, "a", base, n2, { kind: "default" })).toBe(m0);
    expect(await reg(d, "a", base, n3, { kind: "default" })).toBe(m0);
    expect(await holds(m0)).toHaveLength(2);
    let cur = m0;
    for (let i = 0; i < LIMITS.maxFormerNames; i++)
      cur = (await renamed(d, "a", uniq("pi"), "default")).bus_name;
    expect(await formerRows(cur)).toHaveLength(LIMITS.maxFormerNames);
    d.close();
  });

  it("no hold is dropped before its hour, and holds never fill the room", async () => {
    const d = await at();
    const mine = uniq("Hop");
    const spaces = Array.from({ length: LIMITS.maxFormerNames + 2 }, () =>
      ns("lv"),
    );
    await reg(d, "a", mine, spaces[0] as string);
    for (const s of spaces.slice(1))
      expect(await reg(d, "a", mine, s)).toBe(mine);
    expect(await holds(mine)).toEqual(spaces.slice(0, -1).map((s) => `${s}/0`));
    for (const s of spaces.slice(0, -1))
      expect(await reg(d, id("x"), mine, s)).toBe(`${mine}-2`);
    // Holds are bounded by the rename limit, not the room: an in-place
    // rename still works.
    const next = uniq("Next");
    expect((await renamed(d, "a", next)).bus_name).toBe(next);
    d.close();
  });

  it("the 11th scope change in an hour is kept: the agent stays reachable in its old scope (move_kept)", async () => {
    const t0 = Date.now() + 160 * GRACE;
    await setClock(t0);
    const d = await at();
    const mine = uniq("Hop");
    const spaces = Array.from({ length: LIMITS.renamesPerHour + 2 }, () =>
      ns("lv"),
    );
    await reg(d, "a", mine, spaces[0] as string);
    for (const s of spaces.slice(1, -1))
      expect(await reg(d, "a", mine, s)).toBe(mine);
    const last = spaces[spaces.length - 2] as string;
    const beyond = spaces[spaces.length - 1] as string;
    await reg(d, "s", uniq("Sender"), last);
    await reg(d, "t", uniq("Sender"), beyond);
    // Kept: agent_ok says the name; the agent is still in `last`.
    expect(await reg(d, "a", mine, beyond)).toBe(mine);
    expect(await holds(mine)).toHaveLength(LIMITS.renamesPerHour);
    const rc = await send(d, "s", mine);
    expect(rc.state).toBe("pending");
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
    expect(await send(d, "t", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // A flip is a scope change too, kept the same way.
    expect(await reg(d, "a", mine, last, { global: true })).toBe(mine);
    expect(await send(d, "t", mine)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    // A rolling hour later the move goes through.
    await setClock(t0 + GRACE + 1);
    expect(await reg(d, "a", mine, beyond)).toBe(mine);
    expect((await send(d, "t", mine)).state).toBe("pending");
    d.close();
  });

  it("a reopen in another scope counts too, and is kept at the limit", async () => {
    const d = await at();
    const n1 = ns("lv");
    const n2 = ns("lv");
    await reg(d, "s1", uniq("Sender"), n1);
    await reg(d, "a", uniq("Reo"), n1);
    const cur = await churn(d, "a", LIMITS.renamesPerHour);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "a", cur, n2)).toBe(cur);
    const rc = await send(d, "s1", cur);
    expect(rc.state).toBe("pending");
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("a");
    d.close();
  });

  it("a close after many moves keeps every hold", async () => {
    const d = await at();
    const mine = uniq("Hop");
    const spaces = Array.from({ length: LIMITS.maxFormerNames + 3 }, () =>
      ns("lv"),
    );
    await reg(d, "a", mine, spaces[0] as string);
    for (const s of spaces.slice(1))
      expect(await reg(d, "a", mine, s)).toBe(mine);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    await reg(d, "z", uniq("Sync"), spaces[0] as string);
    expect(await holds(mine)).toEqual(spaces.map((s) => `${s}/0`));
    for (const s of spaces)
      expect(await reg(d, id("x"), mine, s)).toBe(`${mine}-2`);
    d.close();
  });
});

describe("#1448: revoking a machine frees every name its agents held or reserved", () => {
  /** A daemon (with BUS_CAPS.rename) on a new machine, and that machine. */
  async function onMachine(label: string) {
    const m = await machine(label);
    const d = await daemon(m.token);
    d.send({
      v: 1,
      id: id("h"),
      type: "hello",
      machine_label: label,
      client_version: "0.0.0",
      caps: [BUS_CAPS.rename],
    });
    await waitFor(d, "hello_ok");
    return { m, d };
  }

  it("a re-approved machine gets the plain names; another machine's live and held names stay taken", async () => {
    const t0 = Date.now() + 200 * GRACE + seq * 1000;
    await setClock(t0);
    const n = ns("rv");
    const n2 = ns("rv");
    // C: another machine, never revoked. One live agent, one that left.
    const c = await onMachine("Other");
    await reg(c.d, "s", uniq("Sender"), n);
    const live = uniq("Live");
    await reg(c.d, "k", live, n);
    const left = uniq("Left");
    await reg(c.d, "h", left, n);
    c.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "h" });

    // A: the machine to revoke, with every way a name is held or reserved.
    const a = await onMachine("Rehearsal");
    const open = uniq("OA Backend");
    expect(await reg(a.d, "o", open, n)).toBe(open);
    const closed = uniq("OA Frontend");
    expect(await reg(a.d, "f", closed, n)).toBe(closed);
    a.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "f" });
    const before = uniq("OA Design");
    expect(await reg(a.d, "r", before, n)).toBe(before);
    const after = uniq("OA Design2");
    await renamed(a.d, "r", after);
    const glob = uniq("OA Manager");
    expect(await reg(a.d, "g", glob, n, { global: true })).toBe(glob);
    const elsewhere = uniq("OA Platform");
    expect(await reg(a.d, "e", elsewhere, n2)).toBe(elsewhere);
    expect(await reg(a.d, "x", live, n)).toBe(`${live}-2`);

    const reserved = () =>
      inHub(
        (_, st) =>
          st.storage.sql
            .exec<{ n: number }>(
              "select count(*) as n from former_names f join agents a on a.id = f.agent_id where a.machine_id = ?",
              a.m.id,
            )
            .one().n,
      );
    // Held (closed, and the revoke's own closes) and chosen rows existed.
    expect(await reserved()).toBeGreaterThan(0);
    expect(await (await hubOf()).revokeMachine(a.m.id)).toBe(true);
    expect(await reserved()).toBe(0);
    // No live agent has the name: the revoked one's own refusal.
    expect(await send(c.d, "s", open)).toMatchObject({
      state: "refused",
      reason: "revoked",
    });

    // B: the same workstation re-approved, still inside the hour.
    const b = await onMachine("Workstation");
    expect(await reg(b.d, "o", open, n)).toBe(open);
    expect(await reg(b.d, "f", closed, n)).toBe(closed);
    expect(await reg(b.d, "r", before, n)).toBe(before);
    expect(await reg(b.d, "r2", after, n)).toBe(after);
    expect(await reg(b.d, "g", glob, n, { global: true })).toBe(glob);
    expect(await reg(b.d, "e", elsewhere, n2)).toBe(elsewhere);
    // C is not revoked: its live name and its 1 h hold still protect.
    expect(await reg(b.d, "x", live, n)).toBe(`${live}-2`);
    expect(await reg(b.d, "y", left, n)).toBe(`${left}-2`);
    expect(await holds(left)).toEqual([`${n}/0`]);
    // Mail to the freed name reaches its new holder.
    const rc = await send(c.d, "s", open);
    expect(rc.state).toBe("pending");
    expect((await delivered(b.d, rc.msg_id)).to_ref).toBe("o");
    a.d.close();
    b.d.close();
    c.d.close();
  });
});
