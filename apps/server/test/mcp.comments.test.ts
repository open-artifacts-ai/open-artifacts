import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import {
  type BusNotice,
  type Comment,
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { follow } from "../src/services/follows.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// #682 part 2: list_comments, add_comment, resolve_comment and the `comment`
// notice. The tools call the services the REST routes call, so these tests
// check the seams: permissions, the shared rate bucket, anchors, notices.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
type U = {
  cookie: string;
  userId: string;
  member: Member;
  email: string;
  client: Client;
};

type Sent = { userId: string; notice: BusNotice };
class FakeBus implements NoticeDelivery {
  sent: Sent[] = [];
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return "delivered" as const;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
const clients: Client[] = [];
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(async () => {
  installDelivery(prev);
  await Promise.all(clients.map((c) => c.close()));
});

async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email);
  const member = (await getUser(E, l.userId)) as Member;
  const { token } = await createPat(env, l.userId, prefix);
  const client = await connect(token);
  clients.push(client);
  return { ...l, member, email, client };
}

let owner: U;
let reader: U;
let stranger: U;

const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>The quick brown fox jumps over the lazy dog</p>",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const sc = <T>(r: Awaited<ReturnType<typeof tool>>) => {
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent as T;
};
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );
const comments = (id: string) => `${R.comments(id)}`;

beforeAll(async () => {
  owner = await mk("mc-owner");
  reader = await mk("mc-reader");
  stranger = await mk("mc-stranger");
});

describe("comment tools over MCP", () => {
  it("add, list, reply, resolve and reopen", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const t = sc<{ thread: Thread }>(
      (await reader.client.callTool({
        name: "add_comment",
        arguments: { id, body: "  Is this right?  " },
      })) as never,
    ).thread;
    expect(t.anchor).toEqual({ kind: "note" });
    expect(t.comments[0]).toMatchObject({
      body: "Is this right?",
      author: { kind: "user", me: true },
    });

    const reply = sc<{ comment: Comment }>(
      await tool(owner.client, "add_comment", {
        id,
        threadId: t.id,
        body: "Yes.",
      }),
    );
    expect(reply.comment.body).toBe("Yes.");

    const open = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, status: "open" }),
    );
    expect(open.open).toBe(1);
    expect(open.threads[0]?.comments.map((c) => c.body)).toEqual([
      "Is this right?",
      "Yes.",
    ]);

    const done = sc<{ thread: Thread }>(
      await tool(reader.client, "resolve_comment", { id, threadId: t.id }),
    ).thread;
    expect(done.status).toBe("resolved");
    expect(
      sc<CommentList>(
        await tool(owner.client, "list_comments", { id, status: "open" }),
      ).threads,
    ).toEqual([]);
    expect(
      sc<CommentList>(
        await tool(owner.client, "list_comments", { id, status: "resolved" }),
      ).threads,
    ).toHaveLength(1);
    const again = sc<{ thread: Thread }>(
      await tool(reader.client, "resolve_comment", {
        id,
        threadId: t.id,
        resolved: false,
      }),
    ).thread;
    expect(again.status).toBe("open");

    // The same threads over REST.
    const rest = (await (
      await api(app, comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(rest.threads.map((x) => x.id)).toEqual([t.id]);
  });

  it("a text anchor on html is verified like REST", async () => {
    const id = await pub();
    const ok = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", {
        id,
        body: "this word",
        anchor: {
          kind: "text",
          exact: "quick brown",
          prefix: "The ",
          suffix: " fox",
        },
      }),
    );
    expect(ok.thread.anchor).toMatchObject({
      kind: "text",
      exact: "quick brown",
    });
    const bad = await tool(owner.client, "add_comment", {
      id,
      body: "nope",
      anchor: {
        kind: "text",
        exact: "not in the page",
        prefix: "",
        suffix: "",
      },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^anchor_not_in_version\b/);
    const rest = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: {
        anchor: {
          kind: "text",
          exact: "not in the page",
          prefix: "",
          suffix: "",
        },
        body: "nope",
      },
    });
    expect(rest.status).toBe(422);
  });

  it("refuses an empty body, a reply with an anchor and a missing thread, saying what to do", async () => {
    const id = await pub();
    expect(
      textOf(await tool(owner.client, "add_comment", { id, body: "  " })),
    ).toMatch(/^invalid_body\b/);
    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "x" }),
    ).thread;
    expect(
      textOf(
        await tool(owner.client, "add_comment", {
          id,
          body: "y",
          threadId: t.id,
          anchor: { kind: "note" },
        }),
      ),
    ).toMatch(/^bad_request: A reply has no anchor/);
    for (const [name, args] of [
      ["add_comment", { body: "y" }],
      ["resolve_comment", {}],
    ] as const) {
      const r = await tool(owner.client, name, {
        id,
        threadId: "AAAAAAAAAAAAAAAA",
        ...args,
      });
      expect(textOf(r)).toMatch(/^not_found: No such thread.*list_comments/);
    }
  });

  it("someone who cannot open the artifact is refused; comments off is refused with a next step", async () => {
    const id = await pub({ visibility: "private" });
    for (const [name, args] of [
      ["list_comments", {}],
      ["add_comment", { body: "hi" }],
      ["resolve_comment", { threadId: "AAAAAAAAAAAAAAAA" }],
    ] as const) {
      const r = await tool(stranger.client, name, { id, ...args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^not_found\b/);
    }
    const off = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { comments: false },
    });
    expect(off.status).toBe(200);
    for (const [name, args] of [
      ["list_comments", {}],
      ["add_comment", { body: "hi" }],
    ] as const) {
      const r = await tool(owner.client, name, { id, ...args });
      expect(textOf(r)).toMatch(/^comments_off: .*turn them on/);
    }
  });

  it("shares the 30 a minute bucket with REST", async () => {
    const id = await pub();
    await inDo(id, (i) => {
      i.now = () => 1_800_000_000_000;
    });
    for (let n = 0; n < 15; n++) {
      const r = await api(app, comments(id), owner.cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: `rest ${n}` },
      });
      expect(r.status).toBe(201);
    }
    for (let n = 0; n < 15; n++)
      sc(await tool(owner.client, "add_comment", { id, body: `mcp ${n}` }));
    const over = await tool(owner.client, "add_comment", { id, body: "over" });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toMatch(/^rate_limited\b/);
    const rest = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "over" },
    });
    expect(rest.status).toBe(429);
  });
});

describe("the comment notice", () => {
  /** Notices are sent after the response (waitUntil): wait for `n` for this artifact. */
  const heard = async (id: string, n: number) => {
    await vi.waitFor(() =>
      expect(bus.sent.filter((s) => s.notice.artifactId === id)).toHaveLength(
        n,
      ),
    );
    return bus.sent.filter((s) => s.notice.artifactId === id);
  };

  it("goes once per comment to followers, never to the author, and carries no text", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });
    const addr = (name: string) => ({ namespace: "github.com/acme/app", name });
    await follow(E, owner.userId, addr("owner-agent"), id);
    await follow(E, reader.userId, addr("reader-agent"), id);

    const t = sc<{ thread: Thread }>(
      await tool(owner.client, "add_comment", { id, body: "SECRET BODY" }),
    ).thread;
    // Only the follower who is not the author hears it.
    let got = await heard(id, 1);
    expect(got.map((s) => [s.userId, s.notice.kind, s.notice.to.name])).toEqual(
      [[reader.userId, "comment", "reader-agent"]],
    );
    const n = got[0]?.notice as BusNotice;
    expect(n.text).toContain("has a new comment");
    expect(n.text).toContain("list_comments");
    expect(n.text).not.toContain("SECRET");
    expect(n.text).not.toContain(owner.email);
    expect(n.notBefore).toBeUndefined();

    // A reply is a comment: one more, from the other side.
    sc(
      await tool(reader.client, "add_comment", {
        id,
        threadId: t.id,
        body: "hi",
      }),
    );
    got = await heard(id, 2);
    expect(got[1]?.userId).toBe(owner.userId);

    // A resolve is not a comment, and a refused comment is not one either.
    sc(await tool(owner.client, "resolve_comment", { id, threadId: t.id }));
    await tool(owner.client, "add_comment", { id, body: " " });
    // REST comments notify the same way; this one is the marker that the
    // two above sent nothing.
    const r = await api(app, comments(id), owner.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "via rest" },
    });
    expect(r.status).toBe(201);
    got = await heard(id, 3);
    expect(got.map((s) => s.userId)).toEqual([
      reader.userId,
      owner.userId,
      reader.userId,
    ]);
  });
});
