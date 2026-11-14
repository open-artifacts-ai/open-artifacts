import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { type CommentList, type Member, newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { capsReads } from "../src/auth/policy.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { agentRoster } from "../src/services/comment-agents.js";
import { addThread, resetNameClashCache } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// Outsiders (signed out, guest role, restricted) see an agent's masked name
// only: no linked, product or animal, a stable id that would join one agent's
// masked comments across artifacts. Members, plan-capped ones too, keep them.
// The server pushes no comment frames to viewers (the shell frames carry no
// names), so the REST list and the MCP list are every path a face takes.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
const IDENT = { identityId: "id-run-0001", kind: "claude-code" };
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const member = (await getUser(E, l.userId)) as Member;
  return { ...l, member, email } as U;
}

const FACE = ["linked", "product", "animal"];
const faces = (l: CommentList) => {
  const out: Record<string, unknown>[] = [];
  for (const t of l.threads)
    for (const c of t.comments) {
      out.push(c.author as never);
      for (const p of [...(c.mentions ?? []), ...(c.ask?.to ?? [])])
        out.push(p as never);
    }
  return out;
};

let owner: U;
let id: string;
let memberV: U;
let guestV: U;
let restrictedV: U;

beforeAll(async () => {
  resetNameClashCache();
  owner = await mk("of-owner");
  memberV = await mk("of-member");
  guestV = await mk("of-guest", "guest");
  restrictedV = await mk("of-restricted");
  await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
    .bind(restrictedV.userId)
    .run();
  id = (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>x</p>",
        visibility: "public",
      } as never,
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
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
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
      identityOf: async () => IDENT,
    }),
  };
  const e2 = { ...E, BUS_HUB: ns } as unknown as Env;
  const key = (await agentRoster(e2, id, owner.userId, true, true))[0]
    ?.key as string;
  const art = { id, format: "html", currentVersion: 1 } as never;
  const viewer = { userId: owner.userId, short: null, moderator: true };
  // A thread with a linked mention and ask target ...
  await addThread(
    e2,
    art,
    { kind: "user", id: owner.userId },
    viewer,
    {
      anchor: { kind: "note" },
      body: "hi @Runner",
      mentions: [{ key }],
      ask: {
        question: "ok?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        to: [{ key }],
      },
    },
    { moderator: true },
  );
  // ... and a comment written by the linked agent itself.
  await addThread(
    e2,
    art,
    {
      kind: "user",
      id: owner.userId,
      agent: {
        name: "Runner",
        version: null,
        via: { kind: "token", id: "tok" },
        identity: { ...IDENT, namespace: "ns-o", name: "Runner" },
      },
    },
    viewer,
    { anchor: { kind: "note" }, body: "from the agent" },
    { moderator: true },
  );
});

const rest = async (u: U | null) =>
  (await (
    await api(app, R.comments(id), u?.cookie ?? null)
  ).json()) as CommentList;

describe("outsiders get no face fields (REST)", () => {
  it.each([
    ["logged out", () => null],
    ["guest role", () => guestV],
    ["restricted", () => restrictedV],
  ])("%s: authors and every party are stripped", async (_n, who) => {
    const l = await rest(who());
    const all = faces(l);
    // The agent's own comment, a mention and the ask target.
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) for (const k of FACE) expect(a).not.toHaveProperty(k);
    expect(JSON.stringify(l)).not.toContain("animal");
    // The masked name stays as it is today: guests and signed-out visitors
    // never see the bus name (a restricted member still does).
    if (_n !== "restricted") expect(JSON.stringify(l)).not.toContain("Runner");
  });

  it.each([
    ["logged out", () => null],
    ["guest role", () => guestV],
    ["restricted", () => restrictedV],
  ])("%s: a mention carries no delivery state (#2004)", async (_n, who) => {
    const l = await rest(who());
    const ms = l.threads.flatMap((t) =>
      t.comments.flatMap((c) => c.mentions ?? []),
    );
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(m).not.toHaveProperty("delivery");
  });

  it("a member's mention keeps its delivery state", async () => {
    const l = await rest(memberV);
    const ms = l.threads.flatMap((t) =>
      t.comments.flatMap((c) => c.mentions ?? []),
    );
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(m.delivery).toBeDefined();
  });

  it("a member keeps the face on authors, mention and ask.to", async () => {
    const all = faces(await rest(memberV)).filter(
      (a) => a.kind !== "user" && a.kind !== "guest",
    );
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) {
      expect(a.linked).toBe(true);
      expect(a.animal).toBeDefined();
    }
  });

  it("the plan cap hides no face (capsReads is guest or restricted only)", () => {
    expect(capsReads("plan")).toBe(false);
    expect(capsReads("guest")).toBe(true);
    expect(capsReads("restricted")).toBe(true);
  });
});

describe("MCP list_comments", () => {
  // A guest or restricted account cannot connect an agent at all ("Only
  // members can connect agents"), so only a member reaches this path; the
  // tool still passes the cap through, for a cap set after the connection.
  it("a member keeps the face", async () => {
    const { token } = await createPat(env, memberV.userId, "of");
    const client = await connect(token);
    clients.push(client);
    const r = await tool(client, "list_comments", { id });
    expect(r.isError, textOf(r)).toBeFalsy();
    const all = faces(r.structuredContent as CommentList).filter(
      (a) => a.kind !== "user" && a.kind !== "guest",
    );
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) expect(a.animal).toBeDefined();
  });

  it("a client restricted after it connected gets no linked, product or animal", async () => {
    const u = await mk("of-late");
    const { token } = await createPat(env, u.userId, "late");
    const client = await connect(token);
    clients.push(client);
    const before = await tool(client, "list_comments", { id });
    expect(before.isError, textOf(before)).toBeFalsy();
    for (const a of faces(before.structuredContent as CommentList).filter(
      (x) => x.kind !== "user" && x.kind !== "guest",
    ))
      expect(a.animal).toBeDefined();
    // The cap lands after the connection: the next call is a capped viewer.
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(u.userId)
      .run();
    // Either the server already refuses the capped caller outright (canConnect
    // on each request), or, while it still serves the call, nothing of a face.
    const capped = await tool(client, "list_comments", { id }).catch(
      (e: unknown) => e,
    );
    if (capped instanceof Error) {
      expect(capped.message).toContain("Only members can connect agents");
      return;
    }
    const r = capped as Awaited<ReturnType<typeof tool>>;
    expect(r.isError, textOf(r)).toBeFalsy();
    const all = faces(r.structuredContent as CommentList);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) for (const k of FACE) expect(a).not.toHaveProperty(k);
  });

  // #2247 (from #2243's review): REST drops a mention's delivery for the
  // capped; the MCP list is the other path, and had no test.
  const mentionsOf = (l: CommentList) =>
    l.threads.flatMap((t) => t.comments.flatMap((c) => c.mentions ?? []));

  it("a member's mention keeps its delivery state over MCP", async () => {
    const { token } = await createPat(env, memberV.userId, "ofd");
    const client = await connect(token);
    clients.push(client);
    const r = await tool(client, "list_comments", { id });
    expect(r.isError, textOf(r)).toBeFalsy();
    const ms = mentionsOf(r.structuredContent as CommentList);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(m.delivery).toBeDefined();
  });

  it("a client capped after it connected gets mentions without delivery", async () => {
    const u = await mk("of-late-d");
    const { token } = await createPat(env, u.userId, "late-d");
    const client = await connect(token);
    clients.push(client);
    const before = await tool(client, "list_comments", { id });
    expect(before.isError, textOf(before)).toBeFalsy();
    for (const m of mentionsOf(before.structuredContent as CommentList))
      expect(m.delivery).toBeDefined();
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(u.userId)
      .run();
    const capped = await tool(client, "list_comments", { id }).catch(
      (e: unknown) => e,
    );
    if (capped instanceof Error) {
      expect(capped.message).toContain("Only members can connect agents");
      return;
    }
    const r = capped as Awaited<ReturnType<typeof tool>>;
    expect(r.isError, textOf(r)).toBeFalsy();
    const ms = mentionsOf(r.structuredContent as CommentList);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(m).not.toHaveProperty("delivery");
  });
});
