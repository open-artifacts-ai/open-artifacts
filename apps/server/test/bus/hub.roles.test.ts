// #1296 role addresses: a member-set alias in one namespace (`backend-lead`)
// that points at one agent, by its stable id, so it follows renames. A send
// to a role resolves at send time to its holder; re-pointing changes later
// mail only. A role with no holder (vacated, or the holder closed or gone)
// refuses `role_vacant`, but only to a socket whose hello listed
// BUS_CAPS.roles: any other gets `unknown_agent` and no `to_name`, so an old
// client's strict decoder never sees a reason it doesn't know. Role names
// share the agent-name space of their namespace (case-insensitive), both
// ways, and never equal a reserved (chosen) former name. Only the member sets
// roles, through the hub's RPC (the dashboard's REST, roles.rest.test.ts);
// no frame sets or claims one.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  CLIENT_FRAMES,
  type ClientFrame,
  LIMITS,
  MAILBOX_RETAIN_MS,
  MsgIdSchema,
  ReceiptStateSchema,
  type ServerFrame,
} from "@oa/bus-protocol";
import type { BusRole } from "@oa/shared";
import { describe, expect, it } from "vitest";
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

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const GRACE = LIMITS.formerNameGraceMs;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

type Receipt = Extract<ServerFrame, { type: "receipt" }>;

/** A fresh member per test: roles are per hub, so tests never share them. */
async function owner(): Promise<string> {
  return (await member()).userId;
}

const inHub = async <R>(
  uid: string,
  fn: (i: BusHub, s: DurableObjectState) => R,
) => runInDurableObject(await hubOf(uid), fn);

/** Sets `uid`'s hub clock (each test has its own hub, so none is reset). */
const setClock = (uid: string, ms: number | null) =>
  inHub(uid, (i) => BusHub.setTestClock(i, ms));

/** A daemon of `uid` that said hello, with the given caps (none: an old client). */
async function at(uid: string, caps: string[] = []): Promise<Daemon> {
  const m = await machine("MacBook", uid);
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    ...(caps.length > 0 ? { caps } : {}),
  });
  await waitFor(d, "hello_ok");
  return d;
}
const NEW = [BUS_CAPS.rename, BUS_CAPS.roles];

async function reg(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
  nameKind?: "default" | "chosen",
): Promise<string> {
  d.send({
    v: 1,
    id: id("u"),
    type: "agent_up",
    agent_ref: ref,
    kind: "opencode",
    proposed_name: name,
    namespace,
    global,
    ...(nameKind === undefined ? {} : { name_kind: nameKind }),
  });
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  toNamespace?: string,
  frameId = id("s"),
): Promise<Receipt> {
  d.send({
    v: 1,
    id: frameId,
    type: "send",
    from_ref: from,
    to_name: to,
    body: "hi",
    ...(toNamespace === undefined ? {} : { to_namespace: toNamespace }),
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === frameId) return f;
  }
}

async function delivered(d: Daemon, msgId: string) {
  for (;;) {
    const f = await d.next();
    if (f.type === "deliver" && f.msg_id === msgId) return f;
  }
}

/** The raw frame answering `fid`, for the frozen-schema checks. */
const rawFor = (d: Daemon, fid: string): unknown => {
  for (const t of d.raw) {
    if (!t.startsWith("{")) continue;
    const v = JSON.parse(t) as { id?: string };
    if (v.id === fid) return v;
  }
  throw new Error(`no frame ${fid}`);
};

/**
 * A receipt as a client from before #1296 decodes it, frozen here: the seven
 * refusal reasons it knew, a strict object, no `to_name` (an old client may
 * not know renames either).
 */
const OLD_REASONS = [
  "unknown_agent",
  "closed",
  "inbox_full",
  "too_large",
  "other_namespace",
  "revoked",
  "ambiguous",
  "recipient_closed",
] as const;
const OldReceipt = z.strictObject({
  v: z.literal(1),
  id: z.string(),
  type: z.literal("receipt"),
  msg_id: MsgIdSchema,
  state: ReceiptStateSchema,
  reason: z.enum(OLD_REASONS).optional(),
});

/** The open agent's id, by its bus name (the dashboard's agent list). */
async function agentId(uid: string, name: string): Promise<string> {
  const a = (await (await hubOf(uid)).snapshot()).agents.find(
    (x) => x.name === name,
  );
  if (!a) throw new Error(`no open agent ${name}`);
  return a.id;
}

const put = async (
  uid: string,
  namespace: string,
  name: string,
  agent: string | null,
) => (await hubOf(uid)).putRole(namespace, name, agent);
const roles = async (uid: string): Promise<BusRole[]> =>
  (await hubOf(uid)).listRoles();

async function setRole(
  uid: string,
  namespace: string,
  name: string,
  agent: string | null,
): Promise<BusRole> {
  const r = await put(uid, namespace, name, agent);
  if (!r.ok) throw new Error(`putRole refused: ${r.reason}`);
  return r.role;
}

describe("sending to a role (#1296)", () => {
  it("reaches its holder; a roles socket learns the holder's name, an old one doesn't", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const old = await at(uid);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await reg(old, "o", uniq("oldsender"), n);
    const role = await setRole(
      uid,
      n,
      "backend-lead",
      await agentId(uid, alice),
    );
    expect(role).toMatchObject({
      namespace: n,
      name: "backend-lead",
      holderName: alice,
      vacant: false,
    });

    const r = await send(d, "s", "Backend-Lead");
    expect(r).toMatchObject({ state: "pending", to_name: alice });
    expect((await delivered(d, r.msg_id)).to_ref).toBe("a");

    const o = await send(old, "o", "backend-lead");
    expect(o.state).toBe("pending");
    expect(o).not.toHaveProperty("to_name");
    expect(OldReceipt.safeParse(rawFor(old, o.id)).success).toBe(true);
    expect((await delivered(d, o.msg_id)).to_ref).toBe("a");
    d.close();
    old.close();
  });

  it("a rename-only socket gets no to_name for a role hit (that field is the roles cap's)", async () => {
    const uid = await owner();
    const d = await at(uid, [BUS_CAPS.rename]);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    const r = await send(d, "s", "lead");
    expect(r.state).toBe("pending");
    expect(r).not.toHaveProperty("to_name");
    d.close();
  });

  it("re-pointing changes later mail only; earlier mail stays with its address", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    const bob = await reg(d, "b", uniq("bob"), n);
    await reg(d, "s", uniq("sender"), n);
    const before = await setRole(uid, n, "oncall", await agentId(uid, alice));

    // Waiting mail: carol's machine goes offline, so that send is stored.
    const offline = await at(uid, NEW);
    const carol = await reg(offline, "c", uniq("carol"), n);
    await setRole(uid, n, "oncall", await agentId(uid, carol));
    offline.close();
    await offline.closed;
    const waiting = await send(d, "s", "oncall");
    expect(waiting).toMatchObject({ state: "pending", to_name: carol });

    await setRole(uid, n, "oncall", await agentId(uid, alice));
    const first = await send(d, "s", "oncall");
    expect(first.to_name).toBe(alice);
    expect((await delivered(d, first.msg_id)).to_ref).toBe("a");

    const after = await setRole(uid, n, "oncall", await agentId(uid, bob));
    expect(after.id).toBe(before.id);
    const second = await send(d, "s", "oncall");
    expect(second.to_name).toBe(bob);
    expect((await delivered(d, second.msg_id)).to_ref).toBe("b");

    // The receipts keep the agent each send resolved to.
    const to = await inHub(uid, (_, s) =>
      Object.fromEntries(
        s.storage.sql
          .exec<{ id: string; toName: string }>(
            "select id, to_name as toName from receipts where id in (?, ?, ?)",
            waiting.msg_id,
            first.msg_id,
            second.msg_id,
          )
          .toArray()
          .map((r) => [r.id, r.toName]),
      ),
    );
    expect(to).toEqual({
      [waiting.msg_id]: carol,
      [first.msg_id]: alice,
      [second.msg_id]: bob,
    });
    d.close();
  });

  it("follows its holder through a rename", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    const renamedTo = uniq("alicia");
    const fid = id("r");
    d.send({
      v: 1,
      id: fid,
      type: "rename",
      agent_ref: "a",
      proposed_name: renamedTo,
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe(renamedTo);
    const r = await send(d, "s", "lead");
    expect(r.to_name).toBe(renamedTo);
    expect((await delivered(d, r.msg_id)).to_ref).toBe("a");
    expect((await roles(uid))[0]).toMatchObject({
      holderName: renamedTo,
      vacant: false,
    });
    d.close();
  });

  it("a resend of a role send repeats its to_name to a roles socket only", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const plain = await at(uid, [BUS_CAPS.rename]);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await reg(plain, "p", uniq("plain"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    const fid = id("s");
    const first = await send(d, "s", "lead", undefined, fid);
    const again = await send(d, "s", "lead", undefined, fid);
    expect(again).toMatchObject({ msg_id: first.msg_id, to_name: alice });
    const pid = id("s");
    const p1 = await send(plain, "p", "lead", undefined, pid);
    const p2 = await send(plain, "p", "lead", undefined, pid);
    expect(p2.msg_id).toBe(p1.msg_id);
    expect(p2).not.toHaveProperty("to_name");
    d.close();
    plain.close();
  });

  it("scope: a role in another namespace is unknown_agent, other_namespace with to_namespace", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n1 = ns("ro");
    const n2 = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n1);
    await reg(d, "s", uniq("sender"), n2);
    await setRole(uid, n1, "lead", await agentId(uid, alice));
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await send(d, "s", "lead", n1)).toMatchObject({
      state: "refused",
      reason: "other_namespace",
    });
    d.close();
  });

  it("a global sender: its own namespace's role, a named namespace's, or ambiguous across two", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n1 = ns("ro");
    const n2 = ns("ro");
    const n3 = ns("ro");
    const a1 = await reg(d, "a1", uniq("one"), n1);
    const a2 = await reg(d, "a2", uniq("two"), n2);
    await reg(d, "g", uniq("global"), n3, true);
    await setRole(uid, n1, "lead", await agentId(uid, a1));
    await setRole(uid, n2, "lead", await agentId(uid, a2));
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    expect(await send(d, "g", "lead", n2)).toMatchObject({
      state: "pending",
      to_name: a2,
    });
    await (await hubOf(uid)).deleteRole(
      (await roles(uid)).find((r) => r.namespace === n2)?.id ?? "",
    );
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "pending",
      to_name: a1,
    });
    d.close();
  });
});

describe("a global sender's role in one other namespace (#1296 review)", () => {
  /** A global sender in C, role `lead` held in B; returns the pieces. */
  async function setup() {
    const uid = await owner();
    const d = await at(uid, NEW);
    const [a, b, c] = [ns("ra"), ns("rb"), ns("rc")];
    const holder = await reg(d, "h", uniq("holder"), b);
    await reg(d, "g", uniq("global"), c, true);
    return { uid, d, a, b, holder };
  }

  it("is ambiguous while a live non-global agent in another namespace has the name, and for the hour its close holds it", async () => {
    const { uid, d, a, b, holder } = await setup();
    const t0 = Date.now() + 10 * GRACE;
    await setClock(uid, t0);
    expect(await reg(d, "x", "lead", a)).toBe("lead");
    await setRole(uid, b, "lead", await agentId(uid, holder));
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // Named, each is reachable.
    expect(await send(d, "g", "lead", b)).toMatchObject({ to_name: holder });
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "x" });
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "g" });
    await waitFor(d, "roster");
    // OpenBus #451, #1295: the close reserves `lead` in A as `away` for 7 d
    // (nameOutside counts it, as heldElsewhere does), so the send stays
    // ambiguous...
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // ...also past the hour, and once the reservation ends the role is the
    // target.
    await setClock(uid, t0 + GRACE);
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    await setClock(uid, t0 + MAILBOX_RETAIN_MS);
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "pending",
      to_name: holder,
    });
    d.close();
  });

  it("is ambiguous while an agent in another namespace holds the name as a former name, closed or not", async () => {
    const { uid, d, a, b, holder } = await setup();
    const t0 = Date.now() + 10 * GRACE;
    await setClock(uid, t0);
    expect(await reg(d, "x", "lead", a)).toBe("lead");
    const now = uniq("now");
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "x",
      proposed_name: now,
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe(now);
    await setRole(uid, b, "lead", await agentId(uid, holder));
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // OpenBus #451: a close keeps the chosen former name reserved for its
    // grace, so the send stays ambiguous; after it the role wins.
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "x" });
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "g" });
    await waitFor(d, "roster");
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    await setClock(uid, t0 + GRACE);
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "pending",
      to_name: holder,
    });
    d.close();
  });
});

describe("a global sender's role and left-behind former names (OpenBus #451, #452)", () => {
  async function renameTo(d: Daemon, ref: string, to: string) {
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: ref,
      proposed_name: to,
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe(to);
  }

  it("is ambiguous while another agent's chosen former name is reserved where it was left, even after it moved into the role's namespace", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const [a, b, c] = [ns("ra"), ns("rb"), ns("rc")];
    const holder = await reg(d, "h", uniq("holder"), b);
    await reg(d, "g", uniq("global"), c, true);
    expect(await reg(d, "x", "lead", a)).toBe("lead");
    const now = uniq("now");
    await renameTo(d, "x", now);
    // x moves into b: `lead` stays reserved in a, so b may have the role.
    expect(await reg(d, "x", now, b)).toBe(now);
    await setRole(uid, b, "lead", await agentId(uid, holder));
    expect(await send(d, "g", "lead")).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    // Named, the role is reachable.
    expect(await send(d, "g", "lead", b)).toMatchObject({ to_name: holder });
    d.close();
  });

  it("a global sender's own left-behind former name never makes its role send ambiguous", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const [a, b] = [ns("ra"), ns("rb")];
    const holder = await reg(d, "h", uniq("holder"), b);
    expect(await reg(d, "s", "lead", a)).toBe("lead");
    const now = uniq("now");
    await renameTo(d, "s", now);
    // s flips global: `lead` stays reserved in a only.
    expect(await reg(d, "s", now, a, true)).toBe(now);
    await setRole(uid, b, "lead", await agentId(uid, holder));
    const rc = await send(d, "s", "lead");
    expect(rc).toMatchObject({ state: "pending", to_name: holder });
    expect((await delivered(d, rc.msg_id)).to_ref).toBe("h");
    d.close();
  });
});

describe("a vacant role (#1296)", () => {
  it("vacated: role_vacant to a roles socket, unknown_agent to an old one (frozen schema decodes)", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const old = await at(uid);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await reg(old, "o", uniq("old"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    const vacated = await setRole(uid, n, "lead", null);
    expect(vacated).toMatchObject({
      agentId: null,
      holderName: null,
      vacant: true,
    });
    const r = await send(d, "s", "lead");
    expect(r).toMatchObject({ state: "refused", reason: "role_vacant" });
    expect(r).not.toHaveProperty("to_name");
    const o = await send(old, "o", "lead");
    expect(o).toMatchObject({ state: "refused", reason: "unknown_agent" });
    expect(o).not.toHaveProperty("to_name");
    const frozen = OldReceipt.safeParse(rawFor(old, o.id));
    expect(frozen.success, JSON.stringify(frozen.error?.issues)).toBe(true);
    // The gate is what keeps it away: the roles receipt fails the old schema.
    expect(OldReceipt.safeParse(rawFor(d, r.id)).success).toBe(false);
    expect(old.raw.join("")).not.toContain("role_vacant");
    d.close();
    old.close();
  });

  it("the holder closes: role_vacant; its reopened session holds it again", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const old = await at(uid);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await reg(old, "o", uniq("old"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    // agent_down has no reply: a list round-trip orders it.
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "s" });
    await waitFor(d, "roster");
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "role_vacant",
    });
    expect(await send(old, "o", "lead")).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect((await roles(uid))[0]).toMatchObject({
      holderName: alice,
      vacant: true,
    });
    // Same session (agent ref) back: same agent id, so the role is held.
    expect(await reg(d, "a", alice, n)).toBe(alice);
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "pending",
      to_name: alice,
    });
    d.close();
    old.close();
  });

  it("the holder closes: the role reads vacant while the holder's held name blocks other agents and roles (OpenBus #451)", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "a" });
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "s" });
    await waitFor(d, "roster");
    // The role still resolves, to vacant: the hold never forwards.
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "role_vacant",
    });
    // The held name: another agent gets -2, and no role takes it.
    expect(await reg(d, "x", alice, n)).toBe(`${alice}-2`);
    expect(await put(uid, n, alice, null)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    // #1295: the closed agent's mailbox still takes mail while it is away.
    expect((await send(d, "s", alice)).state).toBe("pending");
    d.close();
  });

  it("a role can't be created on a name a move held, until the hour ends (OpenBus #451)", async () => {
    const uid = await owner();
    const t0 = Date.now() + 10 * GRACE;
    await setClock(uid, t0);
    const d = await at(uid, NEW);
    const [n1, n2] = [ns("ro"), ns("ro")];
    const mover = await reg(d, "m", uniq("mover"), n1);
    const bob = await reg(d, "b", uniq("bob"), n1);
    // A same-name move holds `mover` in n1.
    expect(await reg(d, "m", mover, n2)).toBe(mover);
    expect(await put(uid, n1, mover, await agentId(uid, bob))).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(await put(uid, n1, mover, null)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    await setClock(uid, t0 + GRACE);
    expect((await put(uid, n1, mover, null)).ok).toBe(true);
    d.close();
  });

  it("a holder that moved out of the namespace leaves it vacant", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    await reg(d, "a", alice, ns("elsewhere"));
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "role_vacant",
    });
    d.close();
  });

  it("a holder whose agent row is gone (purged) leaves it vacant", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    const aid = await agentId(uid, alice);
    await setRole(uid, n, "lead", aid);
    await inHub(uid, (_, s) =>
      s.storage.sql.exec("delete from agents where id = ?", aid),
    );
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "role_vacant",
    });
    expect((await roles(uid))[0]).toMatchObject({
      agentId: aid,
      holderName: null,
      vacant: true,
    });
    d.close();
  });

  it("deleted: the name is free and unknown (unknown_agent for every socket)", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "s", uniq("sender"), n);
    const r = await setRole(uid, n, "lead", await agentId(uid, alice));
    expect(await (await hubOf(uid)).deleteRole(r.id)).toBe(true);
    expect(await (await hubOf(uid)).deleteRole(r.id)).toBe(false);
    expect(await roles(uid)).toEqual([]);
    expect(await send(d, "s", "lead")).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    expect(await reg(d, "x", "lead", n)).toBe("lead");
    d.close();
  });
});

describe("role names share the agent-name space (#1296)", () => {
  it("an agent proposing a role's name gets a suffix, any case; another namespace's agent doesn't", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await setRole(uid, n, "Lead", await agentId(uid, alice));
    expect(await reg(d, "x", "lead", n)).toBe("lead-2");
    expect(await reg(d, "y", "LEAD", n)).toBe("LEAD-3");
    expect(await reg(d, "z", "lead", ns("other"))).toBe("lead");
    d.close();
  });

  it("a global agent can't take any namespace's role name", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    expect(await reg(d, "g", "lead", ns("home"), true)).toBe("lead-2");
    d.close();
  });

  it("a rename to a role's name gets a suffix", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await reg(d, "b", uniq("bob"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "b",
      proposed_name: "LEAD",
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe("LEAD-2");
    d.close();
  });

  it("a role can't take a live agent's name (in the namespace, or a global's), any case, nor for the hour after it closes", async () => {
    const uid = await owner();
    const t0 = Date.now() + 10 * GRACE;
    await setClock(uid, t0);
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    const g = await reg(d, "g", uniq("glob"), ns("home"), true);
    const aid = await agentId(uid, alice);
    expect(await put(uid, n, alice.toUpperCase(), aid)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(await put(uid, n, g, aid)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    // Another namespace's agent name is fine.
    const other = await reg(d, "o", uniq("other"), ns("x"));
    expect((await put(uid, n, other, aid)).ok).toBe(true);
    // OpenBus #451, #1295: a closed agent's name is reserved for 7 d (a
    // global's in every namespace), then free.
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "g" });
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "a" });
    await waitFor(d, "roster");
    expect(await put(uid, n, g, aid)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    await setClock(uid, t0 + GRACE);
    expect((await put(uid, n, g, aid)).ok).toBe(false);
    await setClock(uid, t0 + MAILBOX_RETAIN_MS);
    expect((await put(uid, n, g, aid)).ok).toBe(true);
    d.close();
  });

  it("a role can't take a reserved (chosen) former name in scope", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    const left = uniq("left");
    await reg(d, "b", left, n);
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "b",
      proposed_name: uniq("right"),
    });
    await waitFor(d, "renamed");
    expect(await put(uid, n, left, await agentId(uid, alice))).toEqual({
      ok: false,
      reason: "name_taken",
    });
    d.close();
  });

  it("a role can't take a chosen former name left behind by a move or flip, in the scope it was left in only (OpenBus #451)", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const [n1, n2] = [ns("ro"), ns("ro")];
    const rename = async (ref: string, to: string) => {
      d.send({
        v: 1,
        id: id("r"),
        type: "rename",
        agent_ref: ref,
        proposed_name: to,
      });
      expect((await waitFor(d, "renamed")).bus_name).toBe(to);
    };
    // A move: `left` stays reserved in n1, where it was left, not in n2.
    const left = uniq("left");
    await reg(d, "b", left, n1);
    const right = uniq("right");
    await rename("b", right);
    expect(await reg(d, "b", right, n2)).toBe(right);
    expect(await put(uid, n1, left, null)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await put(uid, n2, left, null)).ok).toBe(true);
    // A flip from global: the name was left in every scope, and stays so.
    const gleft = uniq("gleft");
    await reg(d, "c", gleft, n1, true);
    const gright = uniq("gright");
    await rename("c", gright);
    expect(await reg(d, "c", gright, n1)).toBe(gright);
    expect(await put(uid, n2, gleft, null)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    d.close();
  });

  it("a role can't take its own holder's chosen former name (#1388 review)", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const mine = uniq("mine");
    await reg(d, "a", mine, n);
    const other = uniq("other");
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "a",
      proposed_name: other,
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe(other);
    expect(await put(uid, n, mine, await agentId(uid, other))).toEqual({
      ok: false,
      reason: "name_taken",
    });
    d.close();
  });

  it("a role can't take another agent's minted name: live, former, or after a close; the agent gets it back on reopen", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const bob = await reg(d, "b", uniq("bob"), n);
    const bid = await agentId(uid, bob);
    const minted = await reg(d, "p", "pi", n, false, "default");
    expect(minted).toMatch(/^pi-[0-9a-f]{4}$/);
    const pid = await agentId(uid, minted);
    const takenFor = async (agent: string | null) =>
      expect(await put(uid, n, minted.toUpperCase(), agent)).toEqual({
        ok: false,
        reason: "name_taken",
      });
    // Live, then as a default former name.
    await takenFor(bid);
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "p",
      proposed_name: uniq("chosen"),
    });
    await waitFor(d, "renamed");
    await takenFor(bid);
    await takenFor(null);
    // Closed: the minted name stays the agent's.
    d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "p" });
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "b" });
    await waitFor(d, "roster");
    await takenFor(bid);
    expect(await roles(uid)).toEqual([]);
    // Reopened, it gets its own minted name back.
    expect(await reg(d, "p", "pi", n, false, "default")).toBe(minted);
    expect(await agentId(uid, minted)).toBe(pid);
    d.close();
  });

  it("a role may take a minted name for the agent it was minted for, once that agent left it", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const minted = await reg(d, "p", "pi", n, false, "default");
    const pid = await agentId(uid, minted);
    const chosen = uniq("chosen");
    d.send({
      v: 1,
      id: id("r"),
      type: "rename",
      agent_ref: "p",
      proposed_name: chosen,
    });
    await waitFor(d, "renamed");
    await reg(d, "s", uniq("sender"), n);
    const r = await put(uid, n, minted, pid);
    expect(r.ok).toBe(true);
    expect(await send(d, "s", minted)).toMatchObject({
      state: "pending",
      to_name: chosen,
    });
    d.close();
  });

  it("the holder must be open and visible in the role's namespace", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const elsewhere = await reg(d, "e", uniq("elsewhere"), ns("x"));
    const g = await reg(d, "g", uniq("glob"), ns("y"), true);
    expect(await put(uid, n, "lead", await agentId(uid, elsewhere))).toEqual({
      ok: false,
      reason: "agent_not_open",
    });
    expect(await put(uid, n, "lead", "nope")).toEqual({
      ok: false,
      reason: "agent_not_open",
    });
    // A global is visible in every namespace.
    expect((await put(uid, n, "lead", await agentId(uid, g))).ok).toBe(true);
    expect(await roles(uid)).toHaveLength(1);
    d.close();
  });

  it("caps the roles per member; re-pointing at the cap still works", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    const aid = await agentId(uid, alice);
    await inHub(uid, (i) => BusHub.setMaxRolesForTests(i, 3));
    try {
      for (const r of ["r1", "r2", "r3"])
        expect((await put(uid, n, r, aid)).ok).toBe(true);
      expect(await put(uid, n, "r4", aid)).toEqual({
        ok: false,
        reason: "role_limit",
      });
      expect((await put(uid, n, "R1", null)).ok).toBe(true);
      expect((await roles(uid)).map((r) => r.name)).toEqual(["R1", "r2", "r3"]);
    } finally {
      await inHub(uid, (i) => BusHub.setMaxRolesForTests(i, null));
    }
    d.close();
  });

  it("refuses an invalid or reserved role name and an invalid namespace", async () => {
    const uid = await owner();
    for (const [nsx, name, field] of [
      ["ok/ns", "open-artifacts", "name"],
      ["ok/ns", "bad@name", "name"],
      ["ok/ns", "", "name"],
      ["Not Canonical", "lead", "namespace"],
      ["Not Canonical", "bad@name", "namespace"],
    ] as const)
      expect(await put(uid, nsx, name, null)).toEqual({
        ok: false,
        reason: "invalid",
        field,
      });
  });
});

describe("only the member sets roles (#1296)", () => {
  it("no client frame sets or claims a role: each is bad_frame and nothing changes", async () => {
    expect(CLIENT_FRAMES.some((t) => /role/.test(t))).toBe(false);
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    await reg(d, "a", uniq("alice"), n);
    const tries = [
      {
        v: 1,
        id: id("x"),
        type: "role",
        namespace: n,
        role: "lead",
        agent_ref: "a",
      },
      {
        v: 1,
        id: id("x"),
        type: "set_role",
        namespace: n,
        role: "lead",
        agent_ref: "a",
      },
      { v: 1, id: id("x"), type: "claim_role", role: "lead", agent_ref: "a" },
      {
        v: 1,
        id: id("x"),
        type: "agent_up",
        agent_ref: "a",
        kind: "opencode",
        proposed_name: "alice",
        namespace: n,
        global: false,
        role: "lead",
      },
    ];
    for (const t of tries) {
      d.ws.send(JSON.stringify(t));
      const f = await waitFor(d, "error");
      expect(f.code).toBe("bad_frame");
    }
    expect(await roles(uid)).toEqual([]);
    d.close();
  });
});

describe("wipe (erase) and roles (#1296)", () => {
  it("deletes every role and leaves the table usable", async () => {
    const uid = await owner();
    const d = await at(uid, NEW);
    const n = ns("ro");
    const alice = await reg(d, "a", uniq("alice"), n);
    await setRole(uid, n, "lead", await agentId(uid, alice));
    expect(await roles(uid)).toHaveLength(1);
    await (await hubOf(uid)).wipe();
    await d.closed;
    expect(await roles(uid)).toEqual([]);
    expect(
      await inHub(
        uid,
        (_, s) =>
          s.storage.sql
            .exec<{ n: number }>("select count(*) as n from roles")
            .one().n,
      ),
    ).toBe(0);
    const d2 = await at(uid, NEW);
    const bob = await reg(d2, "b", uniq("bob"), n);
    await setRole(uid, n, "lead", await agentId(uid, bob));
    expect(await roles(uid)).toHaveLength(1);
    d2.close();
  });
});
