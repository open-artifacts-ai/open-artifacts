// #1317 step 2: the follow, unfollow and following frames (BUS_CAPS.follow).
// A real hub and real daemon sockets, and the real follows service on D1. The
// hub takes the member from its own name and the address from the agent the
// socket registered: no frame names either. Waits are signals (the reply
// frame), never sleeps.

import { MAX_FOLLOWS, type ServerFrame } from "@oa/bus-protocol";
import { FOLLOW_LIMIT, type Member } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/services/artifacts.js";
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

/** A member with a machine and a daemon that said hello with `caps`, and `names` registered. */
async function setup(caps: string[] | undefined, names = ["alpha"]) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), ...(caps ? { caps } : {}) } as never);
  const ok = await waitFor(d, "hello_ok");
  const namespace = ns("follow");
  const agents: { ref: string; name: string }[] = [];
  for (const n of names) {
    const ref = id("ref");
    d.send(up(id("u"), ref, n, namespace));
    agents.push({ ref, name: (await waitFor(d, "agent_ok")).bus_name });
  }
  return { m, d, ok, namespace, agents };
}

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
      "select artifact_id as artifactId, namespace, agent_name as name from follows where user_id = ? order by agent_name",
    )
      .bind(userId)
      .all<{ artifactId: string; namespace: string; name: string }>()
  ).results;

type S = Awaited<ReturnType<typeof setup>>;
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

describe("follow frames (BUS_CAPS.follow)", () => {
  it("the hub lists the cap to a hello that listed only it", async () => {
    const s = await setup(["follow"]);
    expect(s.ok.caps).toContain("follow");
  });

  it("follows as the registered agent, keeps the first time, lists and unfollows", async () => {
    const s = await setup(["follow"]);
    const art = await artifactOf(s.m.userId);
    const [a] = s.agents;
    const first = await ask(
      s,
      { type: "follow", from_ref: a?.ref, artifact: art },
      "followed",
    );
    expect(first.artifact_id).toBe(art);
    expect(first.url).toContain(`/a/${art}`);
    const again = await ask(
      s,
      { type: "follow", from_ref: a?.ref, artifact: first.url },
      "followed",
    );
    expect(again.followed_at).toBe(first.followed_at);
    expect(await rows(s.m.userId)).toEqual([
      { artifactId: art, namespace: s.namespace, name: a?.name },
    ]);
    const list = await ask(
      s,
      { type: "following", from_ref: a?.ref },
      "follows",
    );
    expect(list.follows).toEqual([
      { artifact_id: art, url: first.url, followed_at: first.followed_at },
    ]);
    expect(
      (
        await ask(
          s,
          { type: "unfollow", from_ref: a?.ref, artifact: art },
          "unfollowed",
        )
      ).removed,
    ).toBe(true);
    expect(
      (
        await ask(
          s,
          { type: "unfollow", from_ref: a?.ref, artifact: art },
          "unfollowed",
        )
      ).removed,
    ).toBe(false);
    expect(await rows(s.m.userId)).toEqual([]);
  });

  it("the address is the registered agent's: a frame cannot name another, and each agent lists only its own", async () => {
    const s = await setup(["follow"], ["alpha", "beta"]);
    const art = await artifactOf(s.m.userId);
    const [a, b] = s.agents;
    // A client that adds an address field is refused whole (strict frame).
    const fid = id("x");
    s.d.send({
      v: 1,
      id: fid,
      type: "follow",
      from_ref: a?.ref,
      artifact: art,
      name: b?.name,
      namespace: "evil.example/ns",
    } as never);
    const bad = await waitFor(s.d, "error");
    expect(bad).toMatchObject({ id: fid, code: "bad_frame" });
    expect(await rows(s.m.userId)).toEqual([]);

    await ask(
      s,
      { type: "follow", from_ref: b?.ref, artifact: art },
      "followed",
    );
    expect(await rows(s.m.userId)).toEqual([
      { artifactId: art, namespace: s.namespace, name: b?.name },
    ]);
    expect(
      (await ask(s, { type: "following", from_ref: a?.ref }, "follows"))
        .follows,
    ).toEqual([]);
    expect(
      (await ask(s, { type: "following", from_ref: b?.ref }, "follows"))
        .follows,
    ).toHaveLength(1);
    // A ref this socket did not register is not an agent here.
    const nf = id("n");
    s.d.send({ v: 1, id: nf, type: "following", from_ref: "someone-else" });
    expect(await waitFor(s.d, "error")).toMatchObject({
      id: nf,
      code: "not_registered",
    });
  });

  it("a member cannot follow what they cannot read: not_found, and no row for anyone", async () => {
    const s1 = await setup(["follow"]);
    const s2 = await setup(["follow"]);
    const art = await artifactOf(s1.m.userId);
    // s2 cannot read s1's private artifact: not_found, and no row for anyone.
    const r = await ask(
      s2,
      { type: "follow", from_ref: s2.agents[0]?.ref, artifact: art },
      "error",
    );
    expect(r).toMatchObject({ code: "not_found", message: "Not found" });
    expect(await rows(s1.m.userId)).toEqual([]);
    expect(await rows(s2.m.userId)).toEqual([]);
  });

  it("not_found for an unknown id, a foreign link and nonsense: one answer", async () => {
    const s = await setup(["follow"]);
    const ref = s.agents[0]?.ref;
    for (const artifact of [
      "nosuchartifact01",
      "https://evil.example/a/abcdefghijklmnop",
      "not an artifact",
    ]) {
      const r = await ask(
        s,
        { type: "follow", from_ref: ref, artifact },
        "error",
      );
      expect(r).toMatchObject({ code: "not_found", message: "Not found" });
    }
    const u = await ask(
      s,
      { type: "unfollow", from_ref: ref, artifact: "not an artifact" },
      "error",
    );
    expect(u.code).toBe("not_found");
  });

  it("at the member's cap, dead rows are cleared (#1766) and an existing follow still answers", async () => {
    expect(MAX_FOLLOWS).toBe(FOLLOW_LIMIT);
    const s = await setup(["follow"]);
    const art = await artifactOf(s.m.userId);
    const other = await artifactOf(s.m.userId);
    const a = s.agents[0];
    await ask(
      s,
      { type: "follow", from_ref: a?.ref, artifact: art },
      "followed",
    );
    await e.DB.batch(
      Array.from({ length: FOLLOW_LIMIT - 1 }, (_, i) =>
        e.DB.prepare(
          "insert into follows (user_id, artifact_id, namespace, agent_name, created_at) values (?, ?, 'ns', ?, ?)",
        ).bind(s.m.userId, art, `fill${i}`, i),
      ),
    );
    // An existing follow answers without touching anything.
    await ask(
      s,
      { type: "follow", from_ref: a?.ref, artifact: art },
      "followed",
    );
    expect(await rows(s.m.userId)).toHaveLength(FOLLOW_LIMIT);
    // The fill rows belong to no agent: a new follow clears them. (The
    // refusal with live rows is in hub.follow-rekey.test.ts.)
    await ask(
      s,
      { type: "follow", from_ref: a?.ref, artifact: other },
      "followed",
    );
    expect((await rows(s.m.userId)).map((r) => r.artifactId).sort()).toEqual(
      [art, other].sort(),
    );
  });

  it("an old client (no follow cap) gets bad_frame, as an older hub would, and no row", async () => {
    for (const caps of [undefined, ["ids", "mailbox"]]) {
      const s = await setup(caps);
      const art = await artifactOf(s.m.userId);
      const ref = s.agents[0]?.ref;
      for (const frame of [
        { type: "follow", from_ref: ref, artifact: art },
        { type: "unfollow", from_ref: ref, artifact: art },
        { type: "following", from_ref: ref },
      ]) {
        const fid = id("o");
        s.d.send({ v: 1, id: fid, ...frame } as never);
        expect(await waitFor(s.d, "error")).toMatchObject({
          id: fid,
          code: "bad_frame",
        });
      }
      expect(await rows(s.m.userId)).toEqual([]);
    }
  });
});
