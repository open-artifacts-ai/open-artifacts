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
import { faceOf } from "../src/services/agent-display.js";
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

// #1890: a mentioned, assigned or asked agent shows its own face, from the
// identity the server resolved at write time on the OWNER's hub.

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

/** A bus env: every hub lists "Runner"; identityOf answers from `ident` and logs the hub asked. */
type Ident = {
  current: { identityId: string; kind: string } | null;
  /** identityOf never answers. */
  hang?: boolean;
  /** identityOf throws. */
  fail?: boolean;
};
function busEnv(ident: Ident, n = 1) {
  const asked: string[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: (hubName: string) => ({
      snapshot: async () => ({
        connected: [],
        agents: Array.from({ length: n }, (_, i) => ({
          id: newId(),
          namespace: "ns-o",
          name: i === 0 ? "Runner" : `Runner${i + 1}`,
          kind: "claude",
          machineId: "m",
          machineLabel: "m",
          global: false,
          state: "live",
          running: true,
          since: null,
          updatedAt: new Date().toISOString(),
        })),
      }),
      identityOf: async (ns: string, name: string) => {
        asked.push(hubName);
        if (ident.fail) throw new Error("hub down");
        if (ident.hang) return new Promise<never>(() => {});
        return ns === "ns-o" && name.startsWith("Runner")
          ? ident.current
          : null;
      },
    }),
  };
  return { e2: { ...E, BUS_HUB: ns } as unknown as Env, asked };
}

const IDENT = { identityId: "id-run-0001", kind: "claude-code" };

async function scene(ident: Ident, n = 1) {
  resetNameClashCache();
  const owner = await mk("i-own", `Ona ${tag} ${++seq}`);
  const other = await mk("i-oth", `Bea ${tag} ${++seq}`);
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
  const { e2, asked } = busEnv(ident, n);
  const roster = await agentRoster(e2, id, owner.userId, true, true);
  const key = roster[0]?.key as string;
  const keys = roster.map((r) => r.key);
  const post = (extra: object) =>
    addThread(
      e2,
      { id, format: "html", currentVersion: 1 } as never,
      { kind: "user", id: owner.userId },
      signedIn(owner),
      { anchor: { kind: "note" }, body: "hi @Runner", ...extra },
      { moderator: true },
    ) as Promise<Thread>;
  const list = async (v: CommentViewer) =>
    (await listComments(e2, id, "all", v)) as CommentList;
  return { owner, other, id, key, keys, asked, post, list };
}

const asks = (key: string) => ({
  ask: {
    question: "ok?",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    to: [{ key }],
  },
});

describe("party faces (#1890)", () => {
  it("a linked agent's mention, assignment and ask target carry its face", async () => {
    const s = await scene({ current: IDENT });
    await s.post({
      mentions: [{ key: s.key }],
      assign: { key: s.key },
      ...asks(s.key),
    });
    const face = faceOf(IDENT.identityId);
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    expect(c?.mentions?.[0]).toMatchObject({
      linked: true,
      product: "Claude Code",
      animal: face,
      name: "Runner",
    });
    expect(c?.assigned).toMatchObject({ linked: true, animal: face });
    expect(c?.ask?.to[0]).toMatchObject({
      kind: "agent",
      linked: true,
      product: "Claude Code",
      animal: face,
      name: "Runner",
    });
    // Same icon on the author-style fields: a third member sees it too, and
    // nothing of the hub beyond the face.
    const json = JSON.stringify(c);
    expect(json).not.toContain(IDENT.identityId);
    expect(json).not.toContain("ns-o");
  });

  it("a party with no stored identity keeps today's shape", async () => {
    const s = await scene({ current: null });
    await s.post({
      mentions: [{ key: s.key }],
      assign: { key: s.key },
      ...asks(s.key),
    });
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    for (const p of [c?.mentions?.[0], c?.assigned, c?.ask?.to[0]]) {
      expect(p).toBeDefined();
      expect(p).not.toHaveProperty("linked");
      expect(p).not.toHaveProperty("product");
      expect(p).not.toHaveProperty("animal");
      expect(p?.name).toBe("Runner");
    }
  });

  it("the owner comes from the roster, not the body", async () => {
    const s = await scene({ current: IDENT });
    await s.post({
      mentions: [
        { key: s.key, owner: s.other.userId, identity: IDENT } as never,
      ],
    });
    expect(new Set(s.asked)).toEqual(new Set([`bus:${s.owner.userId}`]));
  });

  it("a reclaimed name later still shows the original identity", async () => {
    const ident = { current: IDENT as typeof IDENT | null };
    const s = await scene(ident);
    await s.post({ mentions: [{ key: s.key }] });
    ident.current = { identityId: "id-other-9999", kind: "codex" };
    const m = (await s.list(signedIn(s.other))).threads[0]?.comments[0]
      ?.mentions?.[0];
    expect(m?.animal).toEqual(faceOf(IDENT.identityId));
    expect(m?.product).toBe("Claude Code");
  });

  it("a guest still gets the masked name and the body mask", async () => {
    const s = await scene({ current: IDENT });
    await s.post({ mentions: [{ key: s.key }], ...asks(s.key) });
    const c = (await s.list(GUEST)).threads[0]?.comments[0];
    expect(c?.mentions?.[0]).not.toHaveProperty("animal");
    expect(c?.mentions?.[0]).not.toHaveProperty("linked");
    expect(c?.mentions?.[0]?.name).toBe(`${s.owner.member.name}'s agent`);
    expect(JSON.stringify(c)).not.toContain("Runner");
  });
});

describe("identity lookups are bounded (#1890)", () => {
  const legacy = (p: object | undefined) => {
    expect(p).toBeDefined();
    expect(p).not.toHaveProperty("linked");
    expect(p).not.toHaveProperty("animal");
  };
  it("a slow hub: the comment posts fast with legacy party shapes", async () => {
    const s = await scene({ current: IDENT, hang: true });
    const t0 = Date.now();
    await s.post({ mentions: [{ key: s.key }], ...asks(s.key) });
    expect(Date.now() - t0).toBeLessThan(2000);
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    legacy(c?.mentions?.[0]);
    legacy(c?.ask?.to[0]);
  });
  it("a failing hub: the comment still posts", async () => {
    const s = await scene({ current: IDENT, fail: true });
    await s.post({ mentions: [{ key: s.key }], assign: { key: s.key } });
    const c = (await s.list(signedIn(s.other))).threads[0]?.comments[0];
    legacy(c?.mentions?.[0]);
    legacy(c?.assigned);
  });
  it("ten ask targets on a slow hub cost about one bound, not ten", async () => {
    const s = await scene({ current: IDENT, hang: true }, 10);
    expect(s.keys).toHaveLength(10);
    const t0 = Date.now();
    await s.post({
      ask: {
        question: "ok?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        to: s.keys.map((key) => ({ key })),
      },
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.asked).toHaveLength(10);
  });
});

describe("outsiders get no face fields (#1890)", () => {
  const AGENT_IDENT = {
    identityId: "id-author-0001",
    namespace: "ns-o",
    name: "Runner",
    kind: "claude-code",
  };
  const faceKeys = (a: object | undefined) =>
    ["linked", "product", "animal"].filter((k) => a && k in a);

  async function posted() {
    const s = await scene({ current: IDENT });
    await s.post({
      mentions: [{ key: s.key }],
      assign: { key: s.key },
      ...asks(s.key),
    });
    // An agent-authored comment with a linked identity.
    await addThread(
      (await import("cloudflare:workers")).env as unknown as Env,
      { id: s.id, format: "html", currentVersion: 1 } as never,
      {
        kind: "user",
        id: s.owner.userId,
        agent: {
          name: "Runner",
          version: null,
          via: { kind: "token", id: "tok" },
          identity: AGENT_IDENT,
        },
      },
      signedIn(s.owner),
      { anchor: { kind: "note" }, body: "from the agent" },
      { moderator: true },
    );
    return s;
  }
  const all = (l: CommentList) =>
    l.threads.flatMap((t) => t.comments).flatMap((c) => c.author);
  const parties = (l: CommentList) =>
    l.threads.flatMap((t) =>
      t.comments.flatMap((c) => [
        ...(c.mentions ?? []),
        ...(c.assigned ? [c.assigned] : []),
        ...(c.ask?.to ?? []),
      ]),
    );

  it("signed-out, guest-role and capped viewers get no linked, product or animal", async () => {
    const s = await posted();
    const outsiders: CommentViewer[] = [
      GUEST,
      { userId: s.other.userId, short: null, guest: true },
      { userId: s.other.userId, short: null, capped: true },
    ];
    for (const v of outsiders) {
      const l = await s.list(v);
      expect(JSON.stringify(l)).not.toContain("animal");
      for (const a of [...all(l), ...parties(l)])
        expect(faceKeys(a)).toEqual([]);
      expect(parties(l).length).toBeGreaterThan(0);
    }
  });

  it("members, plan-capped included, keep the face", async () => {
    const s = await posted();
    // The plan cap does not set `capped`: the viewer is a plain member.
    for (const v of [
      signedIn(s.other),
      { userId: s.other.userId, short: null },
    ]) {
      const l = await s.list(v);
      const authors = all(l).filter((a) => a.kind === "agent");
      expect(authors.length).toBeGreaterThan(0);
      for (const a of authors) expect(a.linked).toBe(true);
      for (const p of parties(l)) expect(p.linked).toBe(true);
    }
  });
});

describe("MCP list_comments for a capped client (#1890)", () => {
  it("a restricted client gets no linked, product or animal", async () => {
    const { createPat } = await import("../src/auth/pat.js");
    const { connect, textOf, tool } = await import("./mcp-helpers.js");
    const s = await scene({ current: IDENT });
    await s.post({ mentions: [{ key: s.key }], ...asks(s.key) });
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    const { token } = await createPat(env, s.other.userId, "capped");
    const client = await connect(token);
    try {
      const member = await tool(client, "list_comments", { id: s.id });
      expect(member.isError, textOf(member)).toBeFalsy();
      const has = (l: CommentList) =>
        l.threads
          .flatMap((t) => t.comments)
          .flatMap((c) => [...(c.mentions ?? []), ...(c.ask?.to ?? [])]);
      for (const p of has(member.structuredContent as CommentList))
        expect(p.animal).toBeDefined();
      // The cap lands after the connection: the next call is a capped viewer.
      await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
        .bind(s.other.userId)
        .run();
      const capped = await tool(client, "list_comments", { id: s.id }).catch(
        (e: unknown) => e,
      );
      if (capped instanceof Error || (capped as { isError?: boolean }).isError)
        return; // refused outright: no face can leak
      const parties = has(
        (capped as { structuredContent: unknown })
          .structuredContent as CommentList,
      );
      expect(parties.length).toBeGreaterThan(0);
      for (const p of parties)
        for (const k of ["linked", "product", "animal"])
          expect(p).not.toHaveProperty(k);
    } finally {
      await client.close();
    }
  });
});
