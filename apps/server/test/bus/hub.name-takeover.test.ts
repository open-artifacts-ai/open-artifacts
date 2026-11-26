// #3132 (Leo, 2026-11-26: "The name is the role, automatically"): a second
// session asking a chosen name another session holds (live, or away under its
// kept reservation) never gets it and never makes a -2 role. It gets a suffixed
// session name, `pendingRole`, and one pending repoint proposal for the role of
// that name (created for the holder). The holder is told how to hand it over;
// the newcomer is told it waits. Nothing moves until the holder hands over or
// the member decides. A true resume (the same agent_ref) is silent. Real hub,
// real daemon sockets; time is BusHub.setTestClock, waits are signals.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
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
  up,
  waitFor,
} from "./helpers.js";
import { eventually } from "./helpers.ts";

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

async function scene(opts: { holderAway?: boolean } = {}) {
  await setClock(base());
  const n = ns("nt");
  const m = await machine("Work");
  const d = await connect(m.token);
  const name = uniq("Lead");
  const holderRef = uniq("holder");
  expect(await reg(d, holderRef, name, n)).toBe(name);
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
