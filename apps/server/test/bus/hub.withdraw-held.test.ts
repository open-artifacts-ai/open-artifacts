// #2175: withdrawHeld drops the notices still held for an agent removed from a
// comment thread. Real hub; held rows seeded in the notices table directly.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  daemon,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;

async function setup() {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send(hello(id("h")) as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("wd");
  d.send(up(id("u"), id("ref"), `agent-${++seq}`, namespace));
  const ok = await waitFor(d, "agent_ok");
  const hub = await hubOf(m.userId);
  const identityId = `idn${++seq}`;
  const lname = (ok.bus_name as string).toLowerCase();
  await runInDurableObject(hub, (_i, st) => {
    st.storage.sql.exec(
      "update agents set identity_id = ? where namespace = ? and lower(name) = ?",
      identityId,
      namespace,
      lname,
    );
  });
  return { d, hub, namespace, name: ok.bus_name as string, lname, identityId };
}
type S = Awaited<ReturnType<typeof setup>>;

const ack = (a: string, c: string, key = "k") =>
  JSON.stringify({ a, c, k: "mention", key });

function put(
  s: S,
  r: {
    ckey: string;
    ack: string | null;
    foldAcks?: string[];
    foldN?: number;
    toLname?: string;
    text?: string;
  },
) {
  return runInDurableObject(s.hub, (_i, st) => {
    st.storage.sql.exec(
      `insert into notices (to_ns, to_lname, ckey, id, text, not_before, expires_at, parked, ack, fold_n, fold_ref, fold_acks)
       values (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      s.namespace,
      r.toLname ?? s.lname,
      r.ckey,
      id("n"),
      r.text ?? "hello",
      Date.now() + 3_600_000,
      r.ack,
      r.foldN ?? 0,
      (r.foldN ?? 0) > 0 ? "artX" : null,
      r.foldAcks ? JSON.stringify(r.foldAcks) : null,
    );
  });
}
const rows = (s: S) =>
  runInDurableObject(
    s.hub,
    (_i, st) =>
      st.storage.sql
        .exec(
          "select ckey, text, ack, fold_n as n, fold_ref as ref, fold_acks as fa from notices order by ckey",
        )
        .toArray() as {
        ckey: string;
        text: string;
        ack: string | null;
        n: number;
        ref: string | null;
        fa: string | null;
      }[],
  );
const call = (
  s: S,
  commentIds: string[],
  extra: Record<string, unknown> = {},
  artifactId = "artX",
) =>
  runInDurableObject(s.hub, (inst) =>
    (
      inst as unknown as {
        withdrawHeld(a: unknown): Promise<{
          withdrawn: { commentId: string; kind: string; key: string }[];
        }>;
      }
    ).withdrawHeld({
      namespace: s.namespace,
      name: s.name,
      artifactId,
      commentIds,
      ...extra,
    }),
  );

describe("withdrawHeld (#2175)", () => {
  it("removes a single held notice and returns its target", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: ack("artX", "c1") });
    expect(await call(s, ["c1"])).toEqual({
      withdrawn: [{ commentId: "c1", kind: "mention", key: "k" }],
    });
    expect(await rows(s)).toEqual([]);
  });

  it("keeps the other thread's folds and fixes fold_n", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: ack("artX", "c3"),
      foldAcks: [ack("artX", "c1"), ack("artX", "c2")],
      foldN: 2,
    });
    const r = await call(s, ["c1"]);
    expect(r.withdrawn.map((w) => w.commentId)).toEqual(["c1"]);
    const [row] = await rows(s);
    expect(row.n).toBe(1);
    expect(row.ack).toBe(ack("artX", "c3"));
    expect(JSON.parse(row.fa as string)).toEqual([ack("artX", "c2")]);
    expect(row.text).toBe("hello");
  });

  it("promotes the newest remaining fold when the row's own target goes", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: ack("artX", "c3"),
      foldAcks: [ack("artX", "c1"), ack("artX", "c2")],
      foldN: 2,
    });
    await call(s, ["c3"]);
    const [row] = await rows(s);
    expect(row.ack).toBe(ack("artX", "c2"));
    expect(row.n).toBe(1);
    expect(JSON.parse(row.fa as string)).toEqual([ack("artX", "c1")]);
    expect(row.text).toBe(
      "New comment on artifact artX. Read it with list_comments.",
    );
  });

  it("clears the fold line once no folds remain after promotion", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: ack("artX", "c2"),
      foldAcks: [ack("artX", "c1")],
      foldN: 1,
    });
    await call(s, ["c2"]);
    const [row] = await rows(s);
    expect(row.ack).toBe(ack("artX", "c1"));
    expect(row.n).toBe(0);
    expect(row.ref).toBeNull();
    expect(row.fa).toBeNull();
  });

  it("leaves a sent notice (notice_acks) alone", async () => {
    const s = await setup();
    await runInDurableObject(s.hub, (_i, st) => {
      st.storage.sql.exec(
        "insert into notice_acks (msg_id, machine_id, ack, expires_at) values ('m1', 'mach', ?, ?)",
        ack("artX", "c1"),
        Date.now() + 3_600_000,
      );
    });
    expect(await call(s, ["c1"])).toEqual({ withdrawn: [] });
    const n = await runInDurableObject(
      s.hub,
      (_i, st) =>
        st.storage.sql.exec("select count(*) as n from notice_acks").one().n,
    );
    expect(n).toBe(1);
  });

  it("leaves another agent's notices and another artifact alone", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: ack("artX", "c1"),
      toLname: "someone-else",
    });
    await put(s, { ckey: "b", ack: ack("artY", "c1") });
    expect(await call(s, ["c1"])).toEqual({ withdrawn: [] });
    expect(await rows(s)).toHaveLength(2);
  });

  it("resolves by identityId and by name, and an unknown agent withdraws nothing", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: ack("artX", "c1") });
    expect(
      (await call(s, ["c1"], { identityId: s.identityId, name: "zzz" }))
        .withdrawn,
    ).toHaveLength(1);
    await put(s, { ckey: "a", ack: ack("artX", "c1") });
    expect(
      (await call(s, ["c1"], { name: s.name.toUpperCase() })).withdrawn,
    ).toHaveLength(1);
    await put(s, { ckey: "a", ack: ack("artX", "c1") });
    expect(await call(s, ["c1"], { name: "nobody" })).toEqual({
      withdrawn: [],
    });
    expect(await rows(s)).toHaveLength(1);
  });

  it("never settles the withdrawn targets", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: ack("artX", "c1") });
    const r = await runInDurableObject(s.hub, async (inst) => {
      const h = inst as unknown as Record<string, unknown> & {
        withdrawHeld(a: unknown): Promise<unknown>;
      };
      const spy = vi.fn();
      // #settleTarget is private; any settle goes through ctx.waitUntil.
      const orig = (
        inst as unknown as { ctx: { waitUntil: (p: Promise<unknown>) => void } }
      ).ctx.waitUntil;
      (inst as unknown as { ctx: { waitUntil: unknown } }).ctx.waitUntil = spy;
      try {
        await h.withdrawHeld({
          namespace: s.namespace,
          name: s.name,
          artifactId: "artX",
          commentIds: ["c1"],
        });
      } finally {
        (inst as unknown as { ctx: { waitUntil: unknown } }).ctx.waitUntil =
          orig;
      }
      return spy.mock.calls.length;
    });
    expect(r).toBe(0);
  });
});
