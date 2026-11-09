import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import {
  type CommentList,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// #1789: a comment written over MCP or with a token reads as an agent, set by
// the server only; a cookie comment stays a person; a guest stays a guest.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
const NOTE = { kind: "note" };
type U = { cookie: string; userId: string; member: Member; email: string };

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email);
  return { ...l, member: (await getUser(E, l.userId)) as Member, email };
}

let owner: U;
let other: U;
const pub = async () =>
  (
    await publish(
      E,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>hi there</p>",
        visibility: "team",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );
const list = async (id: string, auth: string | null) =>
  (await (await api(app, R.comments(id), auth)).json()) as CommentList;
let ip = 0;
const post = (id: string, auth: string | null, extra: object = {}) =>
  api(app, R.comments(id), auth, {
    method: "POST",
    body: { anchor: NOTE, body: "hello", ...extra },
    headers: auth ? {} : { "cf-connecting-ip": `198.18.7.${++ip}` },
  });

beforeAll(async () => {
  owner = await mk("ag-owner");
  other = await mk("ag-other");
});

describe("comment author kind (#1789)", () => {
  it("MCP comment reads as the agent, with the name and who it acts for", async () => {
    const id = await pub();
    const { token } = await createPat(E, owner.userId, "Release bot");
    const client = await connect(token);
    clients.push(client);
    const r = await tool(client, "add_comment", { id, body: "from mcp" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const out = (await tool(client, "list_comments", { id }))
      .structuredContent as CommentList;
    const a = out.threads[0]?.comments[0]?.author;
    expect(a).toMatchObject({
      kind: "agent",
      name: "Release bot",
      id: owner.userId,
      me: true,
    });
    expect(a?.for).toBeTruthy();
    expect(a?.for).not.toBe("Release bot");
    expect(a?.for).not.toContain("@");
    expect(JSON.stringify(out)).not.toContain(owner.email);
  });

  it("a PAT over REST shows its label, not the person", async () => {
    const id = await pub();
    const { token } = await createPat(E, owner.userId, "ci token");
    const t = (await (await post(id, token)).json()) as Thread;
    const a = t.comments[0]?.author;
    expect(a?.kind).toBe("agent");
    expect(a?.name).toBe("ci token");
    expect(a?.name).not.toBe(owner.member.name);
  });

  it("a private token label shows others as the owner's agent, still kind agent", async () => {
    const id = await pub();
    const { token } = await createPat(E, owner.userId, "secret bot");
    await post(id, token);
    const seen = (await list(id, other.cookie)).threads[0]?.comments[0]?.author;
    expect(seen?.kind).toBe("agent");
    expect(seen?.name).not.toContain("secret bot");
    expect(seen?.me).toBe(false);
  });

  it("a cookie comment stays a user, even for a member who has agents", async () => {
    const id = await pub();
    await createPat(E, owner.userId, "has agents");
    const t = (await (await post(id, owner.cookie)).json()) as Thread;
    expect(t.comments[0]?.author).toEqual({
      kind: "user",
      id: owner.userId,
      name: "Member",
      // (the test member has no real name: the email never shows)
      me: true,
    });
  });

  it("a guest stays a guest", async () => {
    const id = await pub();
    await api(app, `/api/v1/artifacts/${id}`, owner.cookie, {
      method: "PATCH",
      body: { visibility: "public" },
    });
    const r = await post(id, null, { guestName: "Ada" });
    if (r.status === 201) {
      const t = (await r.json()) as Thread;
      expect(t.comments[0]?.author).toMatchObject({
        kind: "guest",
        name: "Ada",
      });
    } else {
      expect([401, 403, 404]).toContain(r.status);
    }
  });

  it("an old stored comment with an agent maps to the agent kind at read time", async () => {
    const id = await pub();
    await inDo(id, (i) => {
      i.commentsAdd({
        actor: {
          kind: "user",
          ref: owner.userId,
          agent: { name: "Old Bot", via: "g:old" },
        },
        rate: "u:old",
        anchor: NOTE as never,
        version: 1,
        body: "old",
      });
      i.commentsAdd({
        actor: { kind: "user", ref: owner.userId },
        rate: "u:old2",
        anchor: NOTE as never,
        version: 1,
        body: "older",
      });
    });
    const by = Object.fromEntries(
      (await list(id, other.cookie)).threads.map((t) => [
        t.comments[0]?.body,
        t.comments[0]?.author,
      ]),
    );
    expect(by.old).toMatchObject({ kind: "agent", name: "Old Bot" });
    expect(by.older).toMatchObject({ kind: "user" });
  });

  it("a client cannot set the kind or the agent name", async () => {
    const id = await pub();
    const t = (await (
      await post(id, owner.cookie, {
        author: { kind: "agent", name: "Fake" },
        kind: "agent",
        agent: "Fake",
      })
    ).json()) as Thread;
    expect(t.comments[0]?.author.kind).toBe("user");
    expect(t.comments[0]?.author.name).not.toBe("Fake");
  });

  it("the for name is never an email, even when the member's name is one", async () => {
    const id = await pub();
    const mate = await mk("ag-mail");
    await E.DB.prepare("update users set name = ? where id = ?")
      .bind(mate.email, mate.userId)
      .run();
    const { token } = await createPat(E, mate.userId, "mail bot");
    await post(id, token);
    const out = await list(id, other.cookie);
    const a = out.threads[0]?.comments[0]?.author;
    expect(a).toMatchObject({
      kind: "agent",
      name: "A member's agent",
      for: "Member",
    });
    expect(JSON.stringify(out)).not.toContain(mate.email);
  });

  it("edit and delete stay with the owning member, agent comment included", async () => {
    const id = await pub();
    const { token } = await createPat(E, owner.userId, "editor bot");
    const t = (await (await post(id, token)).json()) as Thread;
    const c = t.comments[0];
    expect(c?.can).toEqual({ edit: true, delete: true });
    const mine = (await list(id, owner.cookie)).threads[0]?.comments[0];
    expect(mine?.can.edit).toBe(true);
    const theirs = (await list(id, other.cookie)).threads[0]?.comments[0];
    expect(theirs?.can.edit).toBe(false);
    const path = `${R.comments(id)}/${t.id}/comments/${c?.id}`;
    const denied = await api(app, path, other.cookie, {
      method: "PATCH",
      body: { body: "no" },
    });
    expect(denied.status).toBe(403);
    const ok = await api(app, path, owner.cookie, {
      method: "PATCH",
      body: { body: "yes" },
    });
    expect(ok.status).toBe(200);
    const del = await api(app, path, owner.cookie, { method: "DELETE" });
    expect([200, 204]).toContain(del.status);
  });
});
