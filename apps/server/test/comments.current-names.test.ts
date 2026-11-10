import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type CommentList,
  type Member,
  newId,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { agentRoster } from "../src/services/comment-agents.js";
import {
  addThread,
  type CommentViewer,
  listComments,
  resetNameClashCache,
} from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

// #1889: a linked agent shows its CURRENT bus name on past comments, mention
// chips and ask targets, read at list time from its owner's own hub.

const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
let seq = 0;

class FakeBus implements NoticeDelivery {
  async deliver(_e: Env, _u: string, _n: BusNotice): Promise<DeliveryOutcome> {
    return "delivered";
  }
}
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(new FakeBus());
});
afterAll(() => installDelivery(prev));

type U = { cookie: string; userId: string; member: Member };
async function mk(prefix: string, displayName: string): Promise<U> {
  const l = await login(`${prefix}-${tag}-${++seq}@x.com`, "member");
  await E.DB.prepare("update users set display_name = ? where id = ?")
    .bind(displayName, l.userId)
    .run();
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m };
}
const signedIn = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
});
const GUEST: CommentViewer = { userId: null, short: "gst", guest: true };

const IDENT = { identityId: "id-ren-0001", kind: "claude-code" };

type Hubs = {
  /** hub name -> identity id -> current name */
  names: Map<string, Map<string, string>>;
  mode: "ok" | "hang" | "fail";
  namesAsked: { hub: string; ids: string[] }[];
};

/** A bus env: each member's hub lists "Runner", knows its identity, and answers namesOf from `hubs`. */
function busEnv(hubs: Hubs) {
  const ns = {
    idFromName: (n: string) => n,
    get: (hub: string) => ({
      snapshot: async () => ({
        connected: [],
        agents: [
          {
            id: newId(),
            namespace: "ns-o",
            name: "Runner",
            kind: "claude",
            machineId: "m",
            machineLabel: "m",
            global: false,
            state: "live",
            running: true,
            since: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      identityOf: async (ns: string, name: string) =>
        ns === "ns-o" && name === "Runner" ? IDENT : null,
      namesOf: async (ids: string[]) => {
        hubs.namesAsked.push({ hub, ids });
        if (hubs.mode === "fail") throw new Error("hub down");
        if (hubs.mode === "hang") return new Promise<never>(() => {});
        const mine = hubs.names.get(hub);
        return ids.flatMap((identityId) => {
          const name = mine?.get(identityId);
          return name ? [{ identityId, name }] : [];
        });
      },
    }),
  };
  return { ...E, BUS_HUB: ns } as unknown as Env;
}

async function scene(mode: Hubs["mode"] = "ok") {
  resetNameClashCache();
  const owner = await mk("n-own", `Ona ${tag} ${++seq}`);
  const other = await mk("n-oth", `Bea ${tag} ${++seq}`);
  const id = (
    await publish(
      E,
      owner.member,
      { title: "doc", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
  await E.DB.prepare(
    "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, ?, ?)",
  )
    .bind(newId(), owner.userId, newId(), Date.now(), Date.now())
    .run();
  const hubs: Hubs = {
    names: new Map([[`bus:${owner.userId}`, new Map()]]),
    mode,
    namesAsked: [],
  };
  const e2 = busEnv(hubs);
  const key = (await agentRoster(e2, id, owner.userId, true, true))[0]
    ?.key as string;
  const rename = (name: string) =>
    hubs.names.get(`bus:${owner.userId}`)?.set(IDENT.identityId, name);
  const agentWho = (identified: boolean) => ({
    kind: "user" as const,
    id: owner.userId,
    agent: {
      name: "Runner",
      version: null,
      via: { kind: "token" as const, id: "tok" },
      ...(identified
        ? {
            identity: {
              identityId: IDENT.identityId,
              namespace: "ns-o",
              name: "Runner",
              kind: "claude-code",
            },
          }
        : {}),
    },
  });
  const post = (extra: object, identified = true) =>
    addThread(
      e2,
      { id, format: "html", currentVersion: 1 } as never,
      agentWho(identified),
      signedIn(owner),
      { anchor: { kind: "note" }, body: "hi @Runner", ...extra },
      { moderator: true },
    ) as Promise<Thread>;
  const list = async (v: CommentViewer) =>
    (await listComments(e2, id, "all", v)) as CommentList;
  return { owner, other, id, key, hubs, rename, post, list, e2 };
}

const ask = (key: string) => ({
  ask: {
    question: "ok @Runner?",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    to: [{ key }],
  },
});

describe("a renamed agent shows its current name (#1889)", () => {
  it("an old comment, mention chip, ask target and body show the new name", async () => {
    const s = await scene();
    await s.post({ mentions: [{ key: s.key }], ...ask(s.key) });
    s.rename("Runner Two");
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    expect(c?.author.name).toBe("Runner Two");
    expect(c?.mentions?.[0]?.name).toBe("Runner Two");
    expect(c?.ask?.to[0]?.name).toBe("Runner Two");
    expect(c?.body).toBe("hi @Runner Two");
    expect(c?.ask?.question).toBe("ok @Runner Two?");
    // Nothing of the hub beyond the name.
    expect(JSON.stringify(c)).not.toContain(IDENT.identityId);
    expect(JSON.stringify(c)).not.toContain("ns-o");
  });

  it("a legacy row without a stored identity keeps its name", async () => {
    const s = await scene();
    // An unlinked author and a mention resolved while the hub had no identity.
    await s.post({ mentions: [{ key: s.key }] }, false);
    s.rename("Runner Two");
    // The author is unlinked (no identity): not renamed. The mention was
    // written with an identity, so only it is renamed.
    const c = (await s.list(signedIn(s.owner))).threads[0]?.comments[0];
    expect(c?.author.name).not.toContain("Runner Two");
    expect(c?.author.linked).toBeFalsy();
  });

  it("a slow hub gives the stored name quickly", async () => {
    const s = await scene("hang");
    await s.post({ mentions: [{ key: s.key }], ...ask(s.key) });
    const t0 = Date.now();
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c?.author.name).toBe("Runner");
    expect(c?.mentions?.[0]?.name).toBe("Runner");
    expect(c?.ask?.to[0]?.name).toBe("Runner");
  });

  it("a failing hub gives the stored name", async () => {
    const s = await scene("fail");
    await s.post({ mentions: [{ key: s.key }] });
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    expect(c?.author.name).toBe("Runner");
    expect(c?.mentions?.[0]?.name).toBe("Runner");
  });

  it("a guest sees the masked current name, never the bus name", async () => {
    const s = await scene();
    await s.post({ mentions: [{ key: s.key }], ...ask(s.key) });
    s.rename("Runner Two");
    const c = (await s.list(GUEST)).threads[0]?.comments[0];
    const masked = `${s.owner.member.name}'s agent`;
    expect(c?.author.name).toBe(masked);
    expect(c?.mentions?.[0]?.name).toBe(masked);
    expect(c?.ask?.to[0]?.name).toBe(masked);
    const json = JSON.stringify(c);
    expect(json).not.toContain("Runner");
    expect(json).not.toContain("Runner Two");
  });

  it("one batched read per owner, on that owner's own hub only", async () => {
    const s = await scene();
    await s.post({ mentions: [{ key: s.key }], ...ask(s.key) });
    await s.post({ mentions: [{ key: s.key }] });
    s.hubs.namesAsked.length = 0;
    await s.list(signedIn(s.other));
    expect(s.hubs.namesAsked).toHaveLength(1);
    expect(s.hubs.namesAsked[0]?.hub).toBe(`bus:${s.owner.userId}`);
    expect(s.hubs.namesAsked[0]?.ids).toEqual([IDENT.identityId]);
  });

  it("another member's identity id on the owner's hub renames nothing", async () => {
    const s = await scene();
    // `other` wrote a comment claiming the owner's identity id; `other` has
    // no machine, so no hub is asked for them and the owner's hub is never
    // asked about an id that is not the owner's.
    resetNameClashCache();
    await addThread(
      s.e2,
      { id: s.id, format: "html", currentVersion: 1 } as never,
      {
        kind: "user",
        id: s.other.userId,
        agent: {
          name: "Runner",
          version: null,
          via: { kind: "token", id: "tok2" },
          identity: {
            identityId: IDENT.identityId,
            namespace: "ns-o",
            name: "Impostor",
            kind: "claude-code",
          },
        },
      },
      signedIn(s.other),
      { anchor: { kind: "note" }, body: "hello" },
      { moderator: true },
    );
    s.rename("Runner Two");
    s.hubs.namesAsked.length = 0;
    const c = (await s.list(signedIn(s.owner))).threads[0]?.comments[0];
    expect(c?.author.name).toBe("Impostor");
    expect(s.hubs.namesAsked.map((x) => x.hub)).not.toContain(
      `bus:${s.owner.userId}`,
    );
  });
});
