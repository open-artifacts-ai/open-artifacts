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
function busEnv(ident: {
  current: { identityId: string; kind: string } | null;
}) {
  const asked: string[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: (hubName: string) => ({
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
      identityOf: async (n: string, name: string) => {
        asked.push(hubName);
        return n === "ns-o" && name === "Runner" ? ident.current : null;
      },
    }),
  };
  return { e2: { ...E, BUS_HUB: ns } as unknown as Env, asked };
}

const IDENT = { identityId: "id-run-0001", kind: "claude-code" };

async function scene(ident: { current: typeof IDENT | null }) {
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
  const { e2, asked } = busEnv(ident);
  const key = (await agentRoster(e2, id, owner.userId, true, true))[0]
    ?.key as string;
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
  return { owner, other, id, key, asked, post, list };
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
    expect(c?.mentions?.[0]).toMatchObject({
      linked: true,
      animal: faceOf(IDENT.identityId),
    });
    expect(c?.mentions?.[0]?.name).toBe(`${s.owner.member.name}'s agent`);
    expect(JSON.stringify(c)).not.toContain("Runner");
  });
});
