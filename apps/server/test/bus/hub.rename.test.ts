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

/** The former names stored for the agent now (or last) named `name`. */
const formerRows = (name: string) =>
  inHub((_, s) =>
    s.storage.sql
      .exec(
        "select f.name from former_names f join agents a on a.id = f.agent_id where a.name = ?",
        name,
      )
      .toArray()
      .map((r) => String(r.name)),
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

  it("former names are newest first, at most maxFormerNames; older ones still resolve", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const names = [uniq("N0")];
    await reg(d, "a", names[0] as string, n);
    for (let i = 1; i <= LIMITS.maxFormerNames + 1; i++) {
      const next = uniq(`N${i}`);
      names.push(next);
      await renamed(d, "a", next);
    }
    const current = names.at(-1) as string;
    const fn = row(await list(d, "s"), current)?.former_names ?? [];
    expect(fn.map((f) => f.name)).toEqual(
      names.slice(0, -1).reverse().slice(0, LIMITS.maxFormerNames),
    );
    for (let i = 1; i < fn.length; i++)
      expect(Date.parse(fn[i]?.expires_at ?? "")).toBeLessThanOrEqual(
        Date.parse(fn[i - 1]?.expires_at ?? ""),
      );
    // The oldest is past the cap but still resolves and stays reserved.
    const oldest = names[0] as string;
    expect(await send(d, "s", oldest)).toMatchObject({
      state: "pending",
      to_name: current,
    });
    expect(await reg(d, "x", oldest, n)).toBe(`${oldest}-2`);
    d.close();
  });

  it("the 11th rename in an hour is rate_limited with the pinned message; no-ops are free", async () => {
    const t0 = Date.now() + 30 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    let cur = uniq("Rate");
    await reg(d, "a", cur, n);
    for (let i = 0; i < LIMITS.renamesPerHour; i++) {
      // A no-op between every rename never counts.
      expect(await renamed(d, "a", cur)).not.toHaveProperty("former");
      cur = uniq(`Rate${i}`);
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

  it("close drops former names: the name is free at once (agent_down, sessions, revoke)", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const a = uniq("Closer");
    await reg(d, "a", a, n);
    const a2 = uniq("Closer2");
    await renamed(d, "a", a2);
    expect(await formerRows(a2)).toEqual([a]);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    expect(await reg(d, "x", a, n)).toBe(a);
    expect(await formerRows(a2)).toEqual([]);

    const b = uniq("Sess");
    await reg(d, "b", b, n);
    const b2 = uniq("Sess2");
    await renamed(d, "b", b2);
    d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: ["b"] });
    expect(await reg(d, "y", b, n)).toBe(b);
    expect(await formerRows(b2)).toEqual([]);

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

  it("taking a default former name supersedes it: one holder per scope", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "x", uniq("pi"), n, { kind: "default" });
    await renamed(d, "x", uniq("Xc"));
    // Z takes the unreserved name, then leaves it (a chosen former name).
    expect(await reg(d, "z", minted, n)).toBe(minted);
    const zc = uniq("Zc");
    await renamed(d, "z", zc);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: zc,
    });
    const holders = await inHub(
      (_, st) =>
        st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from former_names where lname = ?",
            minted.toLowerCase(),
          )
          .one().n,
    );
    expect(holders).toBe(1);
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
        `insert into former_names (agent_id, org_id, name, lname, kind, expires_at)
         select id, org_id, ?, ?, 'chosen', ? from agents where name = ?`,
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

  it("a namespace move or global flip drops the agent's former names", async () => {
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
    // X flips global: its former `foo` would otherwise be visible in n2.
    expect(await reg(d, "x", x2, n1, { global: true })).toBe(x2);
    expect(await formerRows(x2)).toEqual([]);
    expect(await send(d, "s", foo)).toMatchObject({
      state: "pending",
      to_name: y2,
    });
    // A namespace move drops them too.
    const y3 = uniq("Y3");
    await renamed(d, "y", y3);
    expect(await formerRows(y3)).toHaveLength(2);
    expect(await reg(d, "y", y3, n1)).toBe(y3);
    expect(await formerRows(y3)).toEqual([]);
    d.close();
  });

  it("close drops the rename log too", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("Log");
    await reg(d, "a", a, n);
    await renamed(d, "a", uniq("Log2"));
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
    expect(await log()).toBe(1);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    await reg(d, "b", uniq("Barrier"), n);
    expect(await log()).toBe(0);
    d.close();
  });

  it("at the limit, a re-sent name the agent holds as foo-2 is a no-op", async () => {
    const t0 = Date.now() + 40 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const foo = uniq("Foo");
    await reg(d, "o", foo, n);
    await reg(d, "a", uniq("Fa"), n);
    for (let i = 0; i < LIMITS.renamesPerHour - 1; i++)
      await renamed(d, "a", uniq(`Fa${i}`));
    expect((await renamed(d, "a", foo)).bus_name).toBe(`${foo}-2`);
    const again = await renamed(d, "a", foo);
    expect(again.bus_name).toBe(`${foo}-2`);
    expect(again).not.toHaveProperty("former");
    expect(await rename(d, "a", uniq("Over"))).toMatchObject({
      code: "rate_limited",
    });
    d.close();
  });

  it("at the limit, a default rename to a different minted name is rate_limited", async () => {
    const t0 = Date.now() + 50 * GRACE;
    await setClock(t0);
    const d = await at();
    const n = ns("rn");
    const base = uniq("pibase");
    const m1 = await reg(d, "x", base, n, { kind: "default" });
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "x" });
    // Z holds m1 (unreserved: X is closed), so X's reopen mints m2.
    expect(await reg(d, "z", m1, n)).toBe(m1);
    const m2 = await reg(d, "x", base, n, { kind: "default" });
    expect(m2).not.toBe(m1);
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "z" });
    for (let i = 0; i < LIMITS.renamesPerHour - 1; i++)
      await renamed(d, "x", uniq(`Fx${i}`));
    // X now holds m1 (chosen; Z closed). A default rename would mint m2 back.
    expect((await renamed(d, "x", m1)).bus_name).toBe(m1);
    expect(await rename(d, "x", base, "default")).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: RENAME_MESSAGES.rate,
    });
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

  it("a former default name resolves for the grace but is not reserved", async () => {
    const d = await at();
    const n = ns("rn");
    await reg(d, "s", uniq("Sender"), n);
    const minted = await reg(d, "p", uniq("pi"), n, { kind: "default" });
    const chosen = uniq("Picked");
    expect(await renamed(d, "p", chosen, "chosen")).toMatchObject({
      bus_name: chosen,
      former: minted,
    });
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: chosen,
    });
    // Not reserved: a chosen name may take it, and the live one then wins.
    expect(await reg(d, "x", minted, n)).toBe(minted);
    const rc = await send(d, "s", minted);
    expect(rc.state).toBe("pending");
    expect(rc.to_name).toBeUndefined();
    await delivered(d, rc.msg_id).then((f) => expect(f.to_ref).toBe("x"));
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

describe("repeat agent_up rename (#1323) under R393b", () => {
  it("renames a live agent without a former name or a rename_rl row", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("UpA");
    const b = uniq("UpB");
    await reg(d, "s", uniq("Sender"), n);
    await reg(d, "a", a, n);
    expect(await reg(d, "a", b, n)).toBe(b);
    expect(await formerRows(b)).toEqual([]);
    const rl = await inHub(
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from rename_rl r join agents a on a.id = r.agent_id where a.name = ?",
            b,
          )
          .one().n,
    );
    expect(rl).toBe(0);
    // The old name is not an address (no former name), and not reserved.
    expect(await send(d, "s", a)).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await reg(d, "x", a, n)).toBe(a);
    d.close();
  });

  it("a repeat agent_up back to the agent's own former name clears that row", async () => {
    const d = await at();
    const n = ns("rn");
    const a = uniq("BackA");
    const b = uniq("BackB");
    await reg(d, "a", a, n);
    await renamed(d, "a", b);
    expect(await formerRows(b)).toEqual([a]);
    expect(await reg(d, "a", a, n)).toBe(a);
    expect(await formerRows(a)).toEqual([]);
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
