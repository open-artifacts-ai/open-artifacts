import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import {
  type BusNotice,
  type CommentList,
  type CompactCommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { insertThread } from "../src/runtime/comments-store.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { listenEachOther } from "./held-listens.js";
import { api, login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";

// #3168: list_comments cursor and `since` delta read.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class QuietBus implements NoticeDelivery {
  async deliver(_e: Env, _u: string, _n: BusNotice) {
    return "delivered" as const;
  }
}
let prev: NoticeDelivery;
const clients: Client[] = [];
beforeAll(() => {
  prev = installDelivery(new QuietBus());
});
afterAll(async () => {
  installDelivery(prev);
  await Promise.all(clients.map((c) => close(c)));
});

type U = {
  cookie: string;
  userId: string;
  member: Member;
  email: string;
  client: Client;
};
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
beforeAll(async () => {
  owner = await mk("cs-owner");
  reader = await mk("cs-reader");
  await listenEachOther(E, [owner.userId, reader.userId]);
});

const pub = async () =>
  (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>Hello world</p>",
        comments: "everyone",
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

/** Sets the DO's fake clock to `ms` (no real timers or sleeps). */
const setClock = (id: string, ms: number) =>
  inDo(id, (i) => {
    i.now = () => ms;
  });

/**
 * Starts a thread and reads it back whole, whatever add_comment returns
 * (the full thread today; ids only after #3163).
 */
async function newThread(
  client: Client,
  args: Record<string, unknown>,
): Promise<Thread> {
  const made = sc<{ thread?: Thread; threadId?: string }>(
    await tool(client, "add_comment", args),
  );
  const threadId = made.thread?.id ?? (made.threadId as string);
  const one = sc<CommentList>(
    await tool(client, "list_comments", { id: args.id, threadId }),
  );
  return one.threads[0] as Thread;
}

const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);

describe("list_comments cursor and since (#3168)", () => {
  it("unchanged busy page (~30 threads) returns under 200 chars total", async () => {
    const id = await pub();
    await setClock(id, T0);
    // Create one thread via MCP so schema is ready, then seed 29 more threads.
    const first = await newThread(owner.client, { id, body: "Thread 0" });
    expect(first.id).toBeTruthy();

    await inDo(id, (i) => {
      const sql = (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (let n = 1; n < 30; n++)
        insertThread(sql, new Date(T0 + n * 1000).toISOString(), {
          actor: { kind: "user", ref: owner.userId },
          anchor: { kind: "note" },
          version: 1,
          body: `Thread ${n} with a long enough body to make a full read hefty on a busy page.`,
        });
    });

    const full = await tool(owner.client, "list_comments", { id });
    const fullData = sc<CommentList>(full);
    expect(fullData.threads).toHaveLength(30);
    expect(fullData.open).toBe(30);
    expect(typeof fullData.cursor).toBe("string");
    expect(fullData.cursor?.startsWith("c1.")).toBe(true);

    // Second read with the cursor: nothing changed -> under 200 chars total.
    const second = await tool(owner.client, "list_comments", {
      id,
      since: fullData.cursor,
    });
    const secondData = sc<CommentList>(second);
    expect(secondData).toEqual({
      threads: [],
      open: 30,
      truncated: false,
      cursor: fullData.cursor,
    });
    const text = textOf(second);
    expect(text).toBe(`No changes on ${id} since your cursor.`);
    const totalChars = text.length + JSON.stringify(secondData).length;
    expect(totalChars).toBeLessThan(200);
  });

  it("a change in the same millisecond as the cursor is not missed", async () => {
    const id = await pub();
    await setClock(id, T0);
    sc(await tool(owner.client, "add_comment", { id, body: "A" }));
    const first = sc<CommentList>(
      await tool(owner.client, "list_comments", { id }),
    );
    // The clock has not moved: the next write carries the cursor's instant.
    sc(await tool(owner.client, "add_comment", { id, body: "B" }));
    const next = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: first.cursor }),
    );
    expect(next.threads.map((t) => t.comments[0]?.body)).toContain("B");
    // The new cursor counts both changes at that instant: nothing new now.
    const again = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: next.cursor }),
    );
    expect(again.threads).toEqual([]);
  });

  it("tracks reply, resolve, reopen, edit, ask answer, and ask withdrawal; cursor advances each step", async () => {
    const id = await pub();
    await putShare(E, owner.member, id, {
      email: reader.email,
      role: "viewer",
    });

    // Empty page has a cursor; first thread appears after it.
    const empty = sc<CommentList>(
      await tool(owner.client, "list_comments", { id }),
    );
    expect(empty.threads).toEqual([]);
    expect(empty.cursor).toBeTruthy();

    await setClock(id, T0 + 1_000);
    const t1 = await newThread(owner.client, { id, body: "First thread" });

    await setClock(id, T0 + 2_000);
    const t2 = await newThread(owner.client, {
      id,
      body: "Second thread",
      ask: {
        question: "Ship?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        to: [{ key: "me" }],
      },
    });

    await setClock(id, T0 + 3_000);
    const t3 = await newThread(owner.client, {
      id,
      body: "Third thread",
      ask: {
        question: "Withdraw me?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        to: [{ key: "me" }],
      },
    });

    const afterSeed = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: empty.cursor }),
    );
    expect(afterSeed.threads.map((t) => t.id).sort()).toEqual(
      [t1.id, t2.id, t3.id].sort(),
    );
    expect(afterSeed.cursor).not.toBe(empty.cursor);
    let cursor = afterSeed.cursor as string;

    // 1. New reply on t1 -> returns only t1, in full; cursor advances.
    await setClock(id, T0 + 4_000);
    await tool(reader.client, "add_comment", {
      id,
      threadId: t1.id,
      body: "Reply on t1",
    });
    const rReply = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rReply.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(rReply.threads[0]?.comments.map((c) => c.body)).toEqual([
      "First thread",
      "Reply on t1",
    ]);
    expect(rReply.cursor).not.toBe(cursor);
    cursor = rReply.cursor as string;

    // 2. Resolve t1 -> returns only t1; cursor advances.
    await setClock(id, T0 + 5_000);
    await tool(owner.client, "resolve_comment", { id, threadId: t1.id });
    const rResolve = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rResolve.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(rResolve.threads[0]?.status).toBe("resolved");
    expect(rResolve.open).toBe(2);
    expect(rResolve.cursor).not.toBe(cursor);
    // `since` combines with `status`: asking for open excludes the newly resolved t1.
    const rResolveOpen = sc<CommentList>(
      await tool(owner.client, "list_comments", {
        id,
        status: "open",
        since: cursor,
      }),
    );
    expect(rResolveOpen.threads).toEqual([]);
    expect(rResolveOpen.cursor).toBe(rResolve.cursor);
    cursor = rResolve.cursor as string;

    // 3. Reopen t1 -> returns only t1; cursor advances.
    await setClock(id, T0 + 6_000);
    await tool(owner.client, "resolve_comment", {
      id,
      threadId: t1.id,
      resolved: false,
    });
    const rReopen = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rReopen.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(rReopen.threads[0]?.status).toBe("open");
    expect(rReopen.cursor).not.toBe(cursor);
    cursor = rReopen.cursor as string;

    // 4. Ask answer on t2 -> returns only t2; cursor advances.
    await setClock(id, T0 + 7_000);
    const ans = await api(
      app,
      R.commentAnswer(id, t2.id, t2.comments[0]?.id as string),
      owner.cookie,
      { method: "POST", body: { optionId: "yes" } },
    );
    expect(ans.status).toBe(200);
    const rAnswer = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rAnswer.threads.map((t) => t.id)).toEqual([t2.id]);
    expect(rAnswer.threads[0]?.comments[0]?.ask?.answer?.optionId).toBe("yes");
    expect(rAnswer.cursor).not.toBe(cursor);
    cursor = rAnswer.cursor as string;

    // 5. Ask withdrawal on t3 -> returns only t3; cursor advances.
    await setClock(id, T0 + 8_000);
    sc(
      await tool(owner.client, "withdraw_ask", {
        id,
        threadId: t3.id,
        commentId: t3.comments[0]?.id as string,
      }),
    );
    const rWithdraw = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rWithdraw.threads.map((t) => t.id)).toEqual([t3.id]);
    expect(rWithdraw.threads[0]?.comments[0]?.ask?.withdrawn).toBeTruthy();
    expect(rWithdraw.cursor).not.toBe(cursor);
    cursor = rWithdraw.cursor as string;

    // 6. Edit comment on t1 -> returns only t1; cursor advances.
    await setClock(id, T0 + 9_000);
    sc(
      await tool(owner.client, "edit_comment", {
        id,
        threadId: t1.id,
        commentId: t1.comments[0]?.id as string,
        body: "First thread (edited)",
      }),
    );
    const rEdit = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rEdit.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(rEdit.threads[0]?.comments[0]?.body).toBe("First thread (edited)");
    expect(rEdit.threads[0]?.comments[0]?.editedAt).toBeTruthy();
    expect(rEdit.cursor).not.toBe(cursor);
    cursor = rEdit.cursor as string;

    // 7. Nothing after edit -> empty delta, same cursor.
    const rQuiet = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, since: cursor }),
    );
    expect(rQuiet.threads).toEqual([]);
    expect(rQuiet.cursor).toBe(cursor);
  });

  it("every list_comments mode carries a cursor from ALL threads on the artifact", async () => {
    const id = await pub();
    await setClock(id, T0 + 1_000);
    const oldOpen = await newThread(owner.client, { id, body: "Older open" });
    await setClock(id, T0 + 5_000);
    const newerResolved = await newThread(owner.client, {
      id,
      body: "Newer resolved",
    });
    await setClock(id, T0 + 6_000);
    await tool(owner.client, "resolve_comment", {
      id,
      threadId: newerResolved.id,
    });

    const full = sc<CommentList>(
      await tool(owner.client, "list_comments", { id }),
    );
    const openOnly = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, status: "open" }),
    );
    const oneThread = sc<CommentList>(
      await tool(owner.client, "list_comments", { id, threadId: oldOpen.id }),
    );
    const answeredFull = sc<CommentList>(
      await tool(owner.client, "list_comments", {
        id,
        answeredSince: new Date(T0).toISOString(),
      }),
    );
    const answeredCompact = sc<CompactCommentList>(
      await tool(owner.client, "list_comments", {
        id,
        answeredSince: new Date(T0).toISOString(),
        compact: true,
      }),
    );

    // Every mode carries the exact same cursor reflecting the newest activity across ALL threads.
    expect(full.cursor).toBeTruthy();
    expect(openOnly.cursor).toBe(full.cursor);
    expect(oneThread.cursor).toBe(full.cursor);
    expect(answeredFull.cursor).toBe(full.cursor);
    expect(answeredCompact.cursor).toBe(full.cursor);
  });

  it("refuses malformed cursors and incompatible parameter combinations", async () => {
    const id = await pub();
    await setClock(id, T0);
    const t = await newThread(owner.client, { id, body: "Hi" });
    const validCursor = sc<CommentList>(
      await tool(owner.client, "list_comments", { id }),
    ).cursor as string;

    const badMsg =
      "bad_request: That cursor is not one list_comments gave. Read without since to get a fresh one.";
    for (const bad of [
      "",
      "garbage",
      "c2.MA",
      "c1.",
      "c1.!!!",
      "c1.YWJj", // base64url("abc")
      "c1.LTF", // invalid/negative
      "c1.OTk5OTk5OTk5OTk5OTk5", // > year 9999
      `${validCursor}=`, // padded
    ]) {
      const r = await tool(owner.client, "list_comments", { id, since: bad });
      expect(r.isError, `expected error for ${JSON.stringify(bad)}`).toBe(true);
      expect(textOf(r)).toBe(badMsg);
    }

    // Incompatible combinations with `since`.
    for (const args of [
      { id, since: validCursor, threadId: t.id },
      { id, since: validCursor, answeredSince: new Date(T0).toISOString() },
      { id, since: validCursor, mentionedSince: new Date(T0).toISOString() },
      { id, since: validCursor, compact: true },
    ]) {
      const r = await tool(owner.client, "list_comments", args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^bad_request: /);
    }
  });
});
