// #2175: withdrawHeld drops the notices still held for an agent removed from a
// comment thread. Real hub; held rows seeded in the notices table directly.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { agentKey } from "../../src/services/comment-agents.js";
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
  const name = ok.bus_name as string;
  // The roster key notifyAgent gives this agent on artX.
  const key = await agentKey("artX", m.userId, { namespace, name });
  const ack = (a: string, c: string, k = key, kind = "mention") =>
    JSON.stringify({ a, c, k: kind, key: k });
  return { d, hub, namespace, name, lname, identityId, key, ack, m };
}
type S = Awaited<ReturnType<typeof setup>>;

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
      threadId: "T",
      commentIds,
      ...extra,
    }),
  );

describe("withdrawHeld (#2175)", () => {
  it("removes a single held notice and returns its target", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: s.ack("artX", "c1") });
    expect(await call(s, ["c1"])).toEqual({
      withdrawn: [{ commentId: "c1", kind: "mention", key: s.key }],
    });
    expect(await rows(s)).toEqual([]);
  });

  it("keeps the other thread's folds and fixes fold_n", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: s.ack("artX", "c3"),
      foldAcks: [s.ack("artX", "c1"), s.ack("artX", "c2")],
      foldN: 2,
    });
    const r = await call(s, ["c1"]);
    expect(r.withdrawn.map((w) => w.commentId)).toEqual(["c1"]);
    const [row] = await rows(s);
    expect(row.n).toBe(1);
    expect(row.ack).toBe(s.ack("artX", "c3"));
    expect(JSON.parse(row.fa as string)).toEqual([s.ack("artX", "c2")]);
    expect(row.text).toBe("hello");
  });

  it("promotes the newest remaining fold when the row's own target goes", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: s.ack("artX", "c3"),
      foldAcks: [s.ack("artX", "c1"), s.ack("artX", "c2")],
      foldN: 2,
    });
    await call(s, ["c3"]);
    const [row] = await rows(s);
    expect(row.ack).toBe(s.ack("artX", "c2"));
    expect(row.n).toBe(1);
    expect(JSON.parse(row.fa as string)).toEqual([s.ack("artX", "c1")]);
    expect(row.text).toBe(
      "New comment on artifact artX. Read it with list_comments.",
    );
  });

  it("clears the fold line once no folds remain after promotion", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: s.ack("artX", "c2"),
      foldAcks: [s.ack("artX", "c1")],
      foldN: 1,
    });
    await call(s, ["c2"]);
    const [row] = await rows(s);
    expect(row.ack).toBe(s.ack("artX", "c1"));
    expect(row.n).toBe(0);
    expect(row.ref).toBeNull();
    expect(row.fa).toBeNull();
  });

  it("leaves a sent notice (notice_acks) alone", async () => {
    const s = await setup();
    await runInDurableObject(s.hub, (_i, st) => {
      st.storage.sql.exec(
        "insert into notice_acks (msg_id, machine_id, ack, expires_at) values ('m1', 'mach', ?, ?)",
        s.ack("artX", "c1"),
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
      ack: s.ack("artX", "c1"),
      toLname: "someone-else",
    });
    await put(s, { ckey: "b", ack: s.ack("artY", "c1") });
    expect(await call(s, ["c1"])).toEqual({ withdrawn: [] });
    expect(await rows(s)).toHaveLength(2);
  });

  it("resolves by identityId and by name, and an unknown agent withdraws nothing", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: s.ack("artX", "c1") });
    expect(
      (await call(s, ["c1"], { identityId: s.identityId, name: "zzz" }))
        .withdrawn,
    ).toHaveLength(1);
    await put(s, { ckey: "a", ack: s.ack("artX", "c1") });
    expect(
      (await call(s, ["c1"], { name: s.name.toUpperCase() })).withdrawn,
    ).toHaveLength(1);
    await put(s, { ckey: "a", ack: s.ack("artX", "c1") });
    expect(await call(s, ["c1"], { name: "nobody" })).toEqual({
      withdrawn: [],
    });
    expect(await rows(s)).toHaveLength(1);
  });

  it("never settles the withdrawn targets", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: s.ack("artX", "c1") });
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
          threadId: "T",
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

  it("withdraws the thread's targeted thread_reply row and returns its reply target", async () => {
    const s = await setup();
    await put(s, {
      ckey: `artX:T:thread_reply:${s.key}:others`,
      ack: s.ack("artX", "c5", s.key, "reply"),
    });
    await put(s, {
      ckey: `artX:U:thread_reply:${s.key}:others`,
      ack: s.ack("artX", "c6", s.key, "reply"),
    });
    expect(await call(s, [])).toEqual({
      withdrawn: [{ commentId: "c5", kind: "reply", key: s.key }],
    });
    expect((await rows(s)).map((r) => r.ckey)).toEqual([
      `artX:U:thread_reply:${s.key}:others`,
    ]);
  });

  it("deletes the thread's legacy untargeted thread_reply row, returns nothing, keeps another thread's", async () => {
    const s = await setup();
    await put(s, { ckey: `artX:T:thread_reply:${s.key}:others`, ack: null });
    await put(s, { ckey: `artX:U:thread_reply:${s.key}:others`, ack: null });
    expect(await call(s, [])).toEqual({ withdrawn: [] });
    expect((await rows(s)).map((r) => r.ckey)).toEqual([
      `artX:U:thread_reply:${s.key}:others`,
    ]);
  });

  it("withdraws the thread's asker row and returns its targets, whatever commentIds lists", async () => {
    const s = await setup();
    await put(s, {
      ckey: "artX:T:asker:others",
      ack: s.ack("artX", "c9", s.key, "asker"),
      foldAcks: [s.ack("artX", "c8", s.key, "asker")],
      foldN: 1,
    });
    await put(s, {
      ckey: "artX:U:asker:others",
      ack: s.ack("artX", "c7", s.key, "asker"),
    });
    const r = await call(s, ["elsewhere"]);
    expect(r.withdrawn).toEqual([
      { commentId: "c8", kind: "asker", key: s.key },
      { commentId: "c9", kind: "asker", key: s.key },
    ]);
    expect((await rows(s)).map((x) => x.ckey)).toEqual(["artX:U:asker:others"]);
  });

  it("leaves targets and thread_reply rows keyed to another agent", async () => {
    const s = await setup();
    await put(s, { ckey: "a", ack: s.ack("artX", "c1", "agent:other") });
    await put(s, { ckey: "artX:T:thread_reply:agent:other:others", ack: null });
    await put(s, {
      ckey: "artX:T:asker:others",
      ack: s.ack("artX", "c9", "agent:other", "asker"),
    });
    expect(await call(s, ["c1"])).toEqual({ withdrawn: [] });
    expect(await rows(s)).toHaveLength(3);
  });

  it("also reads rows at the passed address when no agent holds it", async () => {
    const s = await setup();
    const key = await agentKey("artX", s.m.userId, {
      namespace: s.namespace,
      name: "Ghost",
    });
    await put(s, {
      ckey: "a",
      ack: s.ack("artX", "c1", key),
      toLname: "ghost",
    });
    await put(s, {
      ckey: `artX:T:thread_reply:${key}:yours`,
      ack: null,
      toLname: "ghost",
    });
    expect(await call(s, ["c1"], { name: "Ghost" })).toEqual({
      withdrawn: [{ commentId: "c1", kind: "mention", key }],
    });
    expect(await rows(s)).toEqual([]);
  });

  it("a promoted row keeps the original URL and tier tail", async () => {
    const s = await setup();
    await put(s, {
      ckey: "a",
      ack: s.ack("artX", "c2"),
      foldAcks: [s.ack("artX", "c1")],
      foldN: 1,
      text: "Open Artifacts: header (version 3).\nhttps://x.test/a/artX\nThread T, comment c2.\nTail line.",
    });
    await call(s, ["c2"]);
    const [row] = await rows(s);
    expect(row.text).toBe(
      "New comment on artifact artX. Read it with list_comments.\nhttps://x.test/a/artX\nTail line.",
    );
  });
});
