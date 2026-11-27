// #3132 (Leo, 2026-11-26: "The name is the role, automatically"): a second
// session asking a chosen name another session holds (live, or away under its
// kept reservation) never gets it and never makes a -2 role. It gets a suffixed
// session name, `pendingRole`, and one pending repoint proposal for the role of
// that name (created for the holder). The holder is told how to hand it over;
// the newcomer is told it waits. Nothing moves until the holder hands over or
// the member decides. A true resume (the same agent_ref) is silent. Real hub,
// real daemon sockets; time is BusHub.setTestClock, waits are signals.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  LIMITS,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  fence,
  framesSeen,
  hubOf,
  machine,
  ns,
  up as plainUp,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

/** #3143: only a name a person gave is a role, so these tests' sessions choose theirs. */
const up = (...a: Parameters<typeof plainUp>): ReturnType<typeof plainUp> =>
  ({ ...plainUp(...a), name_chosen: true }) as ClientFrame;

const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await hubOf(), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));
const sqlOf = <T extends Record<string, SqlStorageValue>>(
  q: string,
  ...binds: SqlStorageValue[]
) =>
  inHub(
    (_, s) => s.storage.sql.exec<T>(q, ...binds).toArray() as unknown as T[],
  );

afterEach(async () => {
  await setClock(null);
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

const CAPS = [BUS_CAPS.follow, BUS_CAPS.roles, BUS_CAPS.mailbox];

async function connect(token: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "M",
    client_version: "0.0.0",
    caps: CAPS,
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  opts: { global?: boolean; kind?: string } = {},
): Promise<string> {
  const f = up(id("u"), ref, name, namespace, opts.global ?? false);
  d.send({
    ...f,
    ...(opts.kind === undefined ? {} : { kind: opts.kind }),
  } as ClientFrame);
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function rename(d: Daemon, ref: string, name: string): Promise<string> {
  const fid = id("r");
  d.send({
    v: 1,
    id: fid,
    type: "rename",
    name_chosen: true,
    agent_ref: ref,
    proposed_name: name,
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "error" && f.id === fid) throw new Error(JSON.stringify(f));
    if (f.type === "renamed" && f.id === fid) return f.bus_name;
  }
}

const close = async (d: Daemon, ref: string) => {
  d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: [ref] });
  await eventually(async () => {
    const r = await sqlOf<{ live: number }>(
      "select live from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    );
    expect(r[0]?.live).toBe(0);
  });
};

type Deliver = Extract<ServerFrame, { type: "deliver" }>;
/** The hub's own texts a session received. */
const said = (d: Daemon, ref: string): string[] =>
  framesSeen(d)
    .flatMap((f) => (f.type === "deliver" ? [f as Deliver] : []))
    .filter((f) => f.from_name === "open-artifacts" && f.to_ref === ref)
    .map((f) => ("body" in f ? String(f.body) : ""));

const agentIdOf = async (ref: string) =>
  (
    await sqlOf<{ id: string }>(
      "select id from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    )
  )[0]?.id ?? "";

const asks = (ref: string) =>
  sqlOf<{ name: string; action: string; credential: string | null }>(
    "select p.name as name, p.action as action, p.credential as credential from role_proposals p join agents a on a.id = p.agent_id where a.native_ref = ? and p.status = 'pending'",
    ref,
  );

const roleOf = (namespace: string, name: string) =>
  sqlOf<{ ref: string | null }>(
    "select a.native_ref as ref from roles r left join agents a on a.id = r.agent_id where r.namespace = ? and r.lname = ?",
    namespace,
    name.toLowerCase(),
  );

const roleCount = (namespace: string) =>
  sqlOf<{ n: number }>(
    "select count(*) as n from roles where namespace = ?",
    namespace,
  ).then((r) => r[0]?.n ?? 0);

async function scene(opts: { holderAway?: boolean; global?: boolean } = {}) {
  await setClock(base());
  const n = ns("nt");
  const m = await machine("Work");
  const d = await connect(m.token);
  const name = uniq("Lead");
  const holderRef = uniq("holder");
  expect(await reg(d, holderRef, name, n, { global: opts.global })).toBe(name);
  if (opts.holderAway) await close(d, holderRef);
  return { d, m, n, name, holderRef };
}

describe("a held chosen name asks to take over its role (#3132)", () => {
  it("live holder: suffixed bus_name, pendingRole, one repoint proposal, the role made for the holder, both told", async () => {
    const s = await scene();
    const ref = uniq("new");
    const got = await reg(s.d, ref, s.name, s.n);
    expect(got).toBe(`${s.name}-2`);
    // The role of the name exists, held by the holder (no -2 role).
    expect(await roleOf(s.n, s.name)).toEqual([{ ref: s.holderRef }]);
    expect(await roleOf(s.n, got)).toEqual([]);
    expect(await roleCount(s.n)).toBe(1);
    // One pending proposal: the newcomer takes the role over, no credential.
    expect(await asks(ref)).toEqual([
      { name: s.name, action: "repoint", credential: null },
    ]);
    const snap = (await (await hubOf()).snapshot()).agents.filter(
      (a) => a.namespace === s.n,
    );
    expect(snap.find((a) => a.name === got)?.pendingRole).toBe(s.name);
    expect(snap.find((a) => a.name === s.name)?.pendingRole).toBeUndefined();
    // Both are told.
    await eventually(() => {
      expect(
        said(s.d, s.holderRef).some((t) =>
          t.includes(`${got} asks to take over your role "${s.name}"`),
        ),
      ).toBe(true);
      expect(
        said(s.d, ref).some((t) =>
          t.includes(`"${s.name}" is another session's role`),
        ),
      ).toBe(true);
    });
    s.d.close();
  });

  it.each(["rename", "agent_up"])(
    "%s keeps the role ID and expires the old address after grace",
    async (method) => {
      const s = await scene();
      const observer = uniq("observer");
      await reg(s.d, observer, s.name, s.n);
      const hub = await hubOf();
      const original = (await hub.listRoles()).find((r) => r.name === s.name)!;
      const next = uniq("Research");
      const at = base();
      await setClock(at);
      expect(
        await (method === "rename"
          ? rename(s.d, s.holderRef, next)
          : reg(s.d, s.holderRef, next, s.n)),
      ).toBe(next);
      const roles = (await hub.listRoles()).filter((r) => r.namespace === s.n);
      expect(roles).toMatchObject([
        { id: original.id, name: next, agentId: original.agentId },
      ]);
      const send = async (to: string) => {
        s.d.send({
          v: 1,
          id: id("s"),
          type: "send",
          from_ref: observer,
          to_name: to,
          body: "rename check",
        } as ClientFrame);
        return waitFor(s.d, "receipt");
      };
      await setClock(at + LIMITS.formerNameGraceMs - 1);
      expect((await send(s.name)).state).toBe("pending");
      await setClock(at + LIMITS.formerNameGraceMs);
      expect(await send(s.name)).toMatchObject({
        state: "refused",
        reason: "unknown_agent",
      });
      expect((await send(next)).state).toBe("pending");
      s.d.close();
    },
  );

  it("a second agent_up of the newcomer files no second proposal", async () => {
    const s = await scene();
    const ref = uniq("new");
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    expect(await reg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await fence(s.d);
    expect(await asks(ref)).toHaveLength(1);
    expect(await roleCount(s.n)).toBe(1);
    s.d.close();
  });

  it("away holder: the same pending flow, no reclaim; its mail and role stay", async () => {
    const s = await scene({ holderAway: true });
    const snd = uniq("snd");
    await reg(s.d, snd, uniq("Snd"), s.n);
    const ref = uniq("new");
    const got = await reg(s.d, ref, s.name, s.n);
    expect(got).toBe(`${s.name}-2`);
    expect(await roleOf(s.n, s.name)).toEqual([{ ref: s.holderRef }]);
    expect(await asks(ref)).toEqual([
      { name: s.name, action: "repoint", credential: null },
    ]);
    // The away row still holds its reservation: nothing was released.
    expect(
      await sqlOf<{ ref: string }>(
        "select a.native_ref as ref from former_names f join agents a on a.id = f.agent_id where f.kind = 'away' and f.lname = ?",
        s.name.toLowerCase(),
      ),
    ).toEqual([{ ref: s.holderRef }]);
    // A gone holder cannot be told; the newcomer is.
    await eventually(() =>
      expect(
        said(s.d, ref).some((t) => t.includes("another session's role")),
      ).toBe(true),
    );
    expect(said(s.d, s.holderRef)).toEqual([]);
    s.d.close();
  });

  it("the member confirming moves the role and clears pendingRole; the newcomer keeps its session name", async () => {
    const s = await scene({ holderAway: true });
    const ref = uniq("new");
    const got = await reg(s.d, ref, s.name, s.n);
    const hub = await hubOf();
    const put = await hub.putRole(s.n, s.name, await agentIdOf(ref));
    expect(put.ok).toBe(true);
    expect(await roleOf(s.n, s.name)).toEqual([{ ref }]);
    const row = (await hub.snapshot()).agents.find((a) => a.name === got);
    expect(row?.pendingRole).toBeUndefined();
    // The ask the move answered is settled: no card is left for it.
    expect(await asks(ref)).toEqual([]);
    s.d.close();
  });

  it("deciding the proposal by its token confirms it the same way", async () => {
    const s = await scene({ holderAway: true });
    const ref = uniq("new");
    await reg(s.d, ref, s.name, s.n);
    const hash = (
      await sqlOf<{ h: string }>(
        "select p.token_hash as h from role_proposals p join agents a on a.id = p.agent_id where a.native_ref = ? and p.status = 'pending'",
        ref,
      )
    )[0]?.h as string;
    const r = await (await hubOf()).decideRoleProposal(hash, "confirm");
    expect(r.ok).toBe(true);
    expect(await roleOf(s.n, s.name)).toEqual([{ ref }]);
    expect(await asks(ref)).toEqual([]);
    s.d.close();
  });

  it("a rename into a held chosen name takes the same pending path", async () => {
    const s = await scene();
    const ref = uniq("other");
    expect(await reg(s.d, ref, uniq("Plain"), s.n)).not.toContain("-2");
    const got = await rename(s.d, ref, s.name);
    expect(got).toBe(`${s.name}-2`);
    expect(await roleOf(s.n, s.name)).toEqual([{ ref: s.holderRef }]);
    expect(await asks(ref)).toEqual([
      { name: s.name, action: "repoint", credential: null },
    ]);
    s.d.close();
  });

  it("a harness default name asks for nothing: no role, no proposal, no pendingRole", async () => {
    await setClock(base());
    const n = ns("nt");
    const m = await machine("Work");
    const d = await connect(m.token);
    const a = await reg(d, uniq("a"), "claude-12345", n, {
      kind: "claude-code",
    });
    expect(a).toBe("claude-12345");
    const ref = uniq("b");
    const b = await reg(d, ref, "claude-12345", n, { kind: "claude-code" });
    expect(b).toBe("claude-12345-2");
    expect(await asks(ref)).toEqual([]);
    expect(await roleCount(n)).toBe(0);
    d.close();
  });

  it.each([
    { away: false, global: false },
    { away: true, global: false },
    { away: false, global: true },
  ])(
    "a /clear of a role holder (away: $away, global: $global) requires a decision",
    async ({ away, global }) => {
      const s = await scene({ global });
      const hub = await hubOf();
      const prior = await agentIdOf(s.holderRef);
      const role = away ? s.name : uniq("Manager");
      if (role === s.name) {
        await reg(s.d, uniq("contender"), role, s.n);
        expect(await roleOf(s.n, role)).toEqual([{ ref: s.holderRef }]);
      } else {
        expect((await hub.putRole(s.n, role, prior)).ok).toBe(true);
      }
      if (away) await close(s.d, s.holderRef);
      const ref = uniq("clear");
      const replace = () =>
        s.d.send({
          ...plainUp(id("u"), ref, s.name, s.n, global),
          replaces: s.holderRef,
        } as ClientFrame);
      replace();
      await waitFor(s.d, "agent_ok");
      const successor = await agentIdOf(ref);
      expect(successor).not.toBe(prior);
      expect(await agentIdOf(s.holderRef)).toBe(prior);
      expect(await roleOf(s.n, role)).toEqual([{ ref: s.holderRef }]);
      expect(await asks(ref)).toEqual([
        { name: role, action: "repoint", credential: null },
      ]);
      replace();
      await waitFor(s.d, "agent_ok");
      expect(await asks(ref)).toHaveLength(1);
      expect(await roleOf(s.n, role)).toEqual([{ ref: s.holderRef }]);
      expect((await hub.putRole(s.n, role, successor)).ok).toBe(true);
      expect(await roleOf(s.n, role)).toEqual([{ ref }]);
      s.d.close();
    },
  );

  it("a true resume (the same agent_ref reopening) keeps its name silently", async () => {
    const s = await scene({ holderAway: true });
    expect(await reg(s.d, s.holderRef, s.name, s.n)).toBe(s.name);
    await fence(s.d);
    expect(await roleCount(s.n)).toBe(0);
    expect(
      await sqlOf("select 1 as x from role_proposals where namespace = ?", s.n),
    ).toEqual([]);
    expect(said(s.d, s.holderRef)).toEqual([]);
    s.d.close();
  });

  it("global agents get no role and no proposal", async () => {
    await setClock(base());
    const n = ns("nt");
    const m = await machine("Work");
    const d = await connect(m.token);
    const name = uniq("Glob");
    expect(await reg(d, uniq("g1"), name, n, { global: true })).toBe(name);
    const ref = uniq("g2");
    expect(await reg(d, ref, name, n, { global: true })).toBe(`${name}-2`);
    expect(await asks(ref)).toEqual([]);
    expect(await roleCount(n)).toBe(0);
    // A namespace agent asking a global's name: a suffix, still no role.
    const ref3 = uniq("n3");
    expect(await reg(d, ref3, name, n)).toBe(`${name}-3`);
    expect(await asks(ref3)).toEqual([]);
    expect(await roleCount(n)).toBe(0);
    d.close();
  });
});

// #3143 (Leo, 2026-11-26): only a name a PERSON gave is a role. A frame without
// name_chosen is an agent's own pick: the pre-#3132 rules apply (#1742 reclaim
// of an away name of the same kind, else a plain suffix), with no proposal,
// no pendingRole and no hub text to the holder.
describe("a self-picked name is no role (#3143)", () => {
  const plainReg = async (d: Daemon, ref: string, name: string, n: string) => {
    d.send(plainUp(id("u"), ref, name, n));
    return (await waitFor(d, "agent_ok")).bus_name;
  };
  const plainRename = async (d: Daemon, ref: string, name: string) => {
    const fid = id("r");
    d.send({
      v: 1,
      id: fid,
      type: "rename",
      agent_ref: ref,
      proposed_name: name,
    } as ClientFrame);
    for (;;) {
      const f = await d.next();
      if (f.type === "error" && f.id === fid)
        throw new Error(JSON.stringify(f));
      if (f.type === "renamed" && f.id === fid) return f.bus_name;
    }
  };
  const proposalCount = async (n: string) =>
    (
      await sqlOf<{ c: number }>(
        "select count(*) as c from role_proposals where namespace = ?",
        n,
      )
    )[0]?.c ?? 0;
  const noCardFor = async (
    s: Awaited<ReturnType<typeof scene>>,
    ref: string,
  ) => {
    await fence(s.d);
    expect(await asks(ref)).toEqual([]);
    expect(await proposalCount(s.n)).toBe(0);
    expect(
      said(s.d, s.holderRef).some((t) => t.includes("asks to take over")),
    ).toBe(false);
    const row = (await (await hubOf()).snapshot()).agents.find(
      (a) => a.namespace === s.n && a.pendingRole !== undefined,
    );
    expect(row).toBeUndefined();
  };

  it("agent_up asking a live holder's name: a plain suffix, no proposal, no text to the holder", async () => {
    const s = await scene();
    const ref = uniq("new");
    expect(await plainReg(s.d, ref, s.name, s.n)).toBe(`${s.name}-2`);
    await noCardFor(s, ref);
    s.d.close();
  });

  it("rename to a live holder's name: a plain suffix, no proposal, no text to the holder", async () => {
    const s = await scene();
    const ref = uniq("new");
    expect(await plainReg(s.d, ref, uniq("Other"), s.n)).not.toBe(s.name);
    expect(await plainRename(s.d, ref, s.name)).toBe(`${s.name}-2`);
    await noCardFor(s, ref);
    s.d.close();
  });

  it("agent_up asking an away holder's name of the same kind: the #1742 reclaim, with its queued mail", async () => {
    const s = await scene({ holderAway: true });
    const sm = await machine("Snd");
    const snd = await connect(sm.token);
    await reg(snd, "snd", uniq("Snd"), s.n);
    const fid = id("s");
    snd.send({
      v: 1,
      id: fid,
      type: "send",
      from_ref: "snd",
      to_name: s.name,
      body: "queued",
    } as ClientFrame);
    const rc = await waitFor(snd, "receipt");
    expect(rc.state).toBe("pending");
    const ref = uniq("new");
    expect(await plainReg(s.d, ref, s.name, s.n)).toBe(s.name);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(rc.msg_id);
    expect(dl.to_ref).toBe(ref);
    await noCardFor(s, ref);
    snd.close();
    s.d.close();
  });

  it("rename to an away holder's name of the same kind: the #1742 reclaim, with its queued mail", async () => {
    const s = await scene({ holderAway: true });
    const sm = await machine("Snd");
    const snd = await connect(sm.token);
    await reg(snd, "snd", uniq("Snd"), s.n);
    snd.send({
      v: 1,
      id: id("s"),
      type: "send",
      from_ref: "snd",
      to_name: s.name,
      body: "queued",
    } as ClientFrame);
    const rc = await waitFor(snd, "receipt");
    expect(rc.state).toBe("pending");
    const ref = uniq("new");
    await plainReg(s.d, ref, uniq("Other"), s.n);
    expect(await plainRename(s.d, ref, s.name)).toBe(s.name);
    const dl = await waitFor(s.d, "deliver");
    expect(dl.msg_id).toBe(rc.msg_id);
    expect(dl.to_ref).toBe(ref);
    await noCardFor(s, ref);
    snd.close();
    s.d.close();
  });
});
