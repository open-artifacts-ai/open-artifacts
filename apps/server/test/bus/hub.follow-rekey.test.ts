// #1766: follows are keyed by address, so a rename or move re-keys them, and
// at the cap a member's dead follows (no live, away or reserved agent holds
// the address) are cleared. Real hub, real daemon sockets, the real follows
// service on D1. Waits are signals (a reply frame, a list round trip), never
// sleeps; the hub's re-key is awaited before the next follow request, so a
// `following` right after `renamed` is deterministic.

import type { ServerFrame } from "@oa/bus-protocol";
import { FOLLOW_LIMIT, type Member, newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/services/artifacts.js";
import { notifyChanged } from "../../src/services/follows.js";
import { getUser } from "../../src/services/users.js";
import {
  daemon,
  e,
  hello,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

type Reply<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function setup() {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), caps: ["follow", "rename"] } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("rekey");
  const reg = async (
    name: string,
    opts: { global?: boolean; namespace?: string } = {},
  ) => {
    const ref = id("ref");
    d.send(
      up(id("u"), ref, name, opts.namespace ?? namespace, opts.global ?? false),
    );
    return { ref, name: (await waitFor(d, "agent_ok")).bus_name };
  };
  return { m, d, namespace, reg };
}
type S = Awaited<ReturnType<typeof setup>>;

const owner = async (userId: string): Promise<Member> => {
  const u = await getUser(e, userId);
  if (!u) throw new Error("no user");
  return u;
};

const artifactOf = async (userId: string) =>
  (
    await publish(
      e,
      await owner(userId),
      { title: "t", format: "markdown", content: "hello" } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const rows = async (userId: string) =>
  (
    await e.DB.prepare(
      "select artifact_id as artifactId, namespace, agent_name as name, created_at as at from follows where user_id = ? order by namespace, agent_name, artifact_id",
    )
      .bind(userId)
      .all<{
        artifactId: string;
        namespace: string;
        name: string;
        at: number;
      }>()
  ).results;

const ask = async <T extends ServerFrame["type"]>(
  s: S,
  frame: Record<string, unknown>,
  type: T,
): Promise<Reply<T>> => {
  const fid = id("f");
  s.d.send({ v: 1, id: fid, ...frame } as never);
  for (;;) {
    const f = await s.d.next();
    if (f.id === fid) {
      expect(f.type).toBe(type);
      return f as Reply<T>;
    }
  }
};

const follow = (s: S, ref: string, artifact: string) =>
  ask(s, { type: "follow", from_ref: ref, artifact }, "followed");
const listed = async (s: S, ref: string) =>
  (await ask(s, { type: "following", from_ref: ref }, "follows")).follows.map(
    (f) => f.artifact_id,
  );
const rename = (s: S, ref: string, name: string) =>
  ask(s, { type: "rename", agent_ref: ref, proposed_name: name }, "renamed");

/** A round trip through the hub: every frame sent before it has been handled. */
async function settled(s: S, from: string): Promise<void> {
  await ask(s, { type: "list", from_ref: from }, "roster");
}

const insertRow = (
  userId: string,
  art: string,
  namespace: string,
  name: string,
  at: number,
) =>
  e.DB.prepare(
    "insert into follows (user_id, artifact_id, namespace, agent_name, created_at) values (?, ?, ?, ?, ?)",
  ).bind(userId, art, namespace, name, at);

describe("a rename takes the follows along", () => {
  it("rows, following, unfollow and a changed notice all work under the new name", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("alpha"));
    await follow(s, a.ref, art);
    const beta = uniq("beta");
    expect((await rename(s, a.ref, beta)).bus_name).toBe(beta);
    expect(await listed(s, a.ref)).toEqual([art]);
    expect(await rows(s.m.userId)).toMatchObject([
      { artifactId: art, namespace: s.namespace, name: beta },
    ]);
    // A publish by anyone reaches the follower at its new name.
    await notifyChanged(e, art, 2, s.m.userId, Date.now());
    const dl = await waitFor(s.d, "deliver");
    expect(dl.to_ref).toBe(a.ref);
    expect(
      (
        await ask(
          s,
          { type: "unfollow", from_ref: a.ref, artifact: art },
          "unfollowed",
        )
      ).removed,
    ).toBe(true);
    expect(await rows(s.m.userId)).toEqual([]);
  });

  it("a case-only rename moves the rows too", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const lower = uniq("case");
    const a = await s.reg(lower);
    await follow(s, a.ref, art);
    const upper = lower.toUpperCase();
    expect((await rename(s, a.ref, upper)).bus_name).toBe(upper);
    expect(await rows(s.m.userId)).toMatchObject([{ name: upper }]);
    expect(await listed(s, a.ref)).toEqual([art]);
  });

  it("a destination that already follows keeps one row and the earlier followed_at", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const only = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("alpha"));
    const dest = uniq("dest");
    await e.DB.batch([
      insertRow(s.m.userId, art, s.namespace, a.name, 100),
      insertRow(s.m.userId, only, s.namespace, a.name, 300),
      insertRow(s.m.userId, art, s.namespace, dest, 200),
    ]);
    await rename(s, a.ref, dest);
    const got = (await rows(s.m.userId)).sort((x, y) => x.at - y.at);
    expect(got).toMatchObject([
      { artifactId: art, name: dest, at: 100 },
      { artifactId: only, name: dest, at: 300 },
    ]);
  });

  it("a re-key failure never fails the rename; the rows stay where they were", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("alpha"));
    await follow(s, a.ref, art);
    const bad = uniq("boom");
    const trig = `rekey_fail_${seq}`;
    await e.DB.exec(
      `create trigger ${trig} before insert on follows when new.agent_name = '${bad}' begin select raise(abort, 'boom'); end`,
    );
    try {
      expect((await rename(s, a.ref, bad)).bus_name).toBe(bad);
      expect(await rows(s.m.userId)).toMatchObject([{ name: a.name }]);
    } finally {
      await e.DB.exec(`drop trigger ${trig}`);
    }
  });
});

describe("an agent_up that moves a session takes the follows along", () => {
  it("a namespace move", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("mover"));
    await follow(s, a.ref, art);
    const to = ns("moved");
    s.d.send(up(id("u"), a.ref, a.name, to));
    await waitFor(s.d, "agent_ok");
    expect(await listed(s, a.ref)).toEqual([art]);
    expect(await rows(s.m.userId)).toMatchObject([
      { namespace: to, name: a.name },
    ]);
  });

  it("a global flip that changes the home namespace; one that keeps it leaves the address alone", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("flip"));
    await follow(s, a.ref, art);
    // Same address: nothing to move, the rows stay.
    s.d.send(up(id("u"), a.ref, a.name, s.namespace, true));
    await waitFor(s.d, "agent_ok");
    expect(await rows(s.m.userId)).toMatchObject([
      { namespace: s.namespace, name: a.name },
    ]);
    // Flip back and move at once.
    const to = ns("flipped");
    s.d.send(up(id("u"), a.ref, a.name, to, false));
    await waitFor(s.d, "agent_ok");
    expect(await listed(s, a.ref)).toEqual([art]);
    expect(await rows(s.m.userId)).toMatchObject([
      { namespace: to, name: a.name },
    ]);
  });

  it("a repeat agent_up that renames", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("first"));
    await follow(s, a.ref, art);
    const next = uniq("second");
    s.d.send(up(id("u"), a.ref, next, s.namespace));
    expect((await waitFor(s.d, "agent_ok")).bus_name).toBe(next);
    expect(await listed(s, a.ref)).toEqual([art]);
    expect(await rows(s.m.userId)).toMatchObject([{ name: next }]);
  });
});

describe("a reclaimed or restarted name keeps its follows (#1742)", () => {
  it("a new session that reclaims an away name inherits the follows at that address", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const keep = await s.reg(uniq("keeper"));
    const old = await s.reg(uniq("Lead"));
    await follow(s, old.ref, art);
    s.d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [keep.ref],
      closed: [old.ref],
    } as never);
    await settled(s, keep.ref);
    const fresh = await s.reg(old.name);
    expect(fresh.name).toBe(old.name);
    expect(await listed(s, fresh.ref)).toEqual([art]);
    expect(await rows(s.m.userId)).toMatchObject([{ name: old.name }]);
  });

  it("a restarted session (same ref, same name) keeps its follows", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const keep = await s.reg(uniq("keeper"));
    const a = await s.reg(uniq("Named"));
    await follow(s, a.ref, art);
    s.d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [keep.ref],
      closed: [a.ref],
    } as never);
    await settled(s, keep.ref);
    s.d.send(up(id("u"), a.ref, a.name, s.namespace));
    expect((await waitFor(s.d, "agent_ok")).bus_name).toBe(a.name);
    expect(await listed(s, a.ref)).toEqual([art]);
  });
});

describe("a closed session that reopens (#1766 review)", () => {
  const closeP = async (s: S, keep: string, ref: string) => {
    s.d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [keep],
      closed: [ref],
    } as never);
    await settled(s, keep);
  };
  const reopen = async (s: S, ref: string, name: string) => {
    s.d.send(up(id("u"), ref, name, s.namespace));
    return (await waitFor(s.d, "agent_ok")).bus_name;
  };
  const taken = async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const y = await artifactOf(s.m.userId);
    const keep = await s.reg(uniq("keeper"));
    const p = await s.reg(uniq("Lead"));
    await follow(s, p.ref, x);
    await closeP(s, keep.ref, p.ref);
    // Q reclaims P's name and follows another artifact.
    const q = await s.reg(p.name);
    expect(q.name).toBe(p.name);
    await follow(s, q.ref, y);
    return { s, x, y, p, q };
  };

  it("P reopens under a suffixed name after Q reclaimed: Q's rows stay, nothing moves", async () => {
    const { s, x, y, p, q } = await taken();
    const got = await reopen(s, p.ref, p.name);
    expect(got).not.toBe(p.name);
    expect((await listed(s, q.ref)).sort()).toEqual([x, y].sort());
    expect((await rows(s.m.userId)).every((r) => r.name === p.name)).toBe(true);
  });

  it("P reopens under a different name after Q reclaimed: Q's rows stay, nothing moves", async () => {
    const { s, x, y, p, q } = await taken();
    const got = await reopen(s, p.ref, uniq("Other"));
    expect(got).not.toBe(p.name);
    expect((await listed(s, q.ref)).sort()).toEqual([x, y].sort());
    expect((await rows(s.m.userId)).every((r) => r.name === p.name)).toBe(true);
  });

  it("an ordinary reopen under a new name of a session holding its away reservation moves its rows", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const keep = await s.reg(uniq("keeper"));
    const p = await s.reg(uniq("Lead"));
    await follow(s, p.ref, x);
    await closeP(s, keep.ref, p.ref);
    const next = uniq("Next");
    expect(await reopen(s, p.ref, next)).toBe(next);
    expect(await listed(s, p.ref)).toEqual([x]);
    expect(await rows(s.m.userId)).toMatchObject([{ name: next }]);
  });
});

describe("the follow cap and dead follows", () => {
  /** `n` bare artifact rows (never read, only followed by raw inserts): publishing 200 takes seconds. */
  const fillers = async (userId: string, n: number) => {
    const ids = Array.from({ length: n }, () => newId());
    await e.DB.batch(
      ids.map((i) =>
        e.DB.prepare(
          "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values (?, ?, 'f', 'markdown', 1, 1)",
        ).bind(i, userId),
      ),
    );
    return ids;
  };

  it("one address at the cap lists exactly the cap and refuses a new follow", async () => {
    const s = await setup();
    const arts = await fillers(s.m.userId, FOLLOW_LIMIT);
    const target = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("full"));
    await e.DB.batch(
      arts
        .slice(0, FOLLOW_LIMIT)
        .map((art, i) => insertRow(s.m.userId, art, s.namespace, a.name, i)),
    );
    const r = await ask(
      s,
      { type: "follow", from_ref: a.ref, artifact: target },
      "error",
    );
    expect(r.code).toBe("follow_limit");
    expect(await listed(s, a.ref)).toHaveLength(FOLLOW_LIMIT);
    expect(await rows(s.m.userId)).toHaveLength(FOLLOW_LIMIT);
  });

  it("at the cap with dead rows, follow clears them and succeeds; live and away rows stay", async () => {
    const s = await setup();
    const art = await artifactOf(s.m.userId);
    const other = await artifactOf(s.m.userId);
    const live = await s.reg(uniq("live"));
    const gone = await s.reg(uniq("gone"));
    await follow(s, live.ref, art);
    await follow(s, gone.ref, art);
    // gone is closed: its address is held (away), so its row stays.
    s.d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [live.ref],
      closed: [gone.ref],
    } as never);
    await settled(s, live.ref);
    await e.DB.batch(
      Array.from({ length: FOLLOW_LIMIT - 2 }, (_, i) =>
        insertRow(s.m.userId, art, "dead/ns", `dead${i}`, i),
      ),
    );
    expect(await rows(s.m.userId)).toHaveLength(FOLLOW_LIMIT);
    await follow(s, live.ref, other);
    const left = await rows(s.m.userId);
    expect(left.map((r) => `${r.name}:${r.artifactId}`).sort()).toEqual(
      [
        `${live.name}:${art}`,
        `${live.name}:${other}`,
        `${gone.name}:${art}`,
      ].sort(),
    );
  });

  it("at the cap with only live (and away) rows, follow_limit stays and nothing is removed", async () => {
    const s = await setup();
    const arts = await fillers(s.m.userId, FOLLOW_LIMIT - 1);
    const target = await artifactOf(s.m.userId);
    const live = await s.reg(uniq("live"));
    const gone = await s.reg(uniq("gone"));
    await e.DB.batch([
      ...arts
        .slice(0, FOLLOW_LIMIT - 1)
        .map((art, i) => insertRow(s.m.userId, art, s.namespace, live.name, i)),
      insertRow(s.m.userId, arts[0] as string, s.namespace, gone.name, 1),
    ]);
    s.d.send({
      v: 1,
      id: id("c"),
      type: "sessions",
      open: [live.ref],
      closed: [gone.ref],
    } as never);
    await settled(s, live.ref);
    const r = await ask(
      s,
      { type: "follow", from_ref: live.ref, artifact: target },
      "error",
    );
    expect(r.code).toBe("follow_limit");
    expect(await rows(s.m.userId)).toHaveLength(FOLLOW_LIMIT);
  });
});

describe("small items", () => {
  it("a malformed link (bad percent-encoding) is not_found", async () => {
    const s = await setup();
    const a = await s.reg(uniq("link"));
    const origin = (
      await follow(s, a.ref, await artifactOf(s.m.userId))
    ).url.split("/a/")[0];
    for (const artifact of [`${origin}/a/%E0%A4%A`, `${origin}/a/%zz`]) {
      const r = await ask(
        s,
        { type: "follow", from_ref: a.ref, artifact },
        "error",
      );
      expect(r).toMatchObject({ code: "not_found", message: "Not found" });
    }
  });
});
