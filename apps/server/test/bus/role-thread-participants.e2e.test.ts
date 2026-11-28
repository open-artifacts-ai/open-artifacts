// #3335 end to end: a role is one thread participant across @role mentions,
// holder replies, page-publisher joins, asks and moves to another session.
// Real hub, real daemon sockets, real /mcp with link proofs, real comment
// routes; waits are frames, never sleeps.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, LINK_PROOF_HEADER } from "@oa/bus-protocol";
import {
  type ArtifactAgent,
  type CommentList,
  type CommentThread,
  type Member,
  R,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { type ArtifactRuntime, runtimeStub } from "../../src/runtime/do.js";
import { publish } from "../../src/services/artifacts.js";
import { agentKey } from "../../src/services/comment-agents.js";
import { resetNameClashCache } from "../../src/services/comments.js";
import { getUser } from "../../src/services/users.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { api } from "../helpers.js";
import { close, connect, E, tool } from "../mcp-helpers.js";
import {
  type Daemon,
  daemon,
  e,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const app = createApp();
const proofOf = () =>
  `${"p".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;
let seq = 0;
const uniq = (t: string) => `${t}${++seq}x${Date.now() % 1e8}`;

/** Next comment notice delivery frame on `d`, skipping role-moved notices. */
async function nextCommentDeliver(d: Daemon) {
  for (;;) {
    const f = await d.next();
    if (f.type !== "deliver") continue;
    if (f.body?.startsWith("Your role ")) continue;
    return f;
  }
}

/** Flush queued frames on `d` with a list barrier so no unexpected deliver slipped through. */
async function barrier(d: Daemon, ref: string) {
  const seen: Awaited<ReturnType<Daemon["next"]>>[] = [];
  const id = `bar-${++seq}`;
  d.send({ v: 1, id, type: "list", from_ref: ref });
  for (;;) {
    const f = await d.next();
    if (f.type === "roster" && f.id === id) return seen;
    seen.push(f);
  }
}

describe("a role is one thread participant (#3335)", () => {
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  afterAll(() => Promise.all(clients.map((c) => close(c))));

  async function setupTwoHolders(tag: string) {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const laptop = await machine("Laptop", m.userId);
    const workstation = await machine("Workstation", m.userId);
    const dL = await daemon(laptop.token);
    const dW = await daemon(workstation.token);
    dL.send({
      ...hello(`hL-${++seq}`),
      caps: [BUS_CAPS.link, BUS_CAPS.follow],
    } as never);
    await waitFor(dL, "hello_ok");
    dW.send({
      ...hello(`hW-${++seq}`),
      caps: [BUS_CAPS.link, BUS_CAPS.follow],
    } as never);
    await waitFor(dW, "hello_ok");
    const space = ns(tag);
    dL.send(up(`uL-${++seq}`, "refL", uniq("MgrL"), space));
    const nameL = (await waitFor(dL, "agent_ok")).bus_name;
    dW.send(up(`uW-${++seq}`, "refW", uniq("MgrW"), space));
    const nameW = (await waitFor(dW, "agent_ok")).bus_name;

    const proofL = proofOf();
    const proofW = proofOf();
    dL.send({
      v: 1,
      id: `bL-${++seq}`,
      type: "link_bind",
      agent_ref: "refL",
      hash: await sha256Hex(proofL),
    } as never);
    await waitFor(dL, "link_bound");
    dW.send({
      v: 1,
      id: `bW-${++seq}`,
      type: "link_bind",
      agent_ref: "refW",
      hash: await sha256Hex(proofW),
    } as never);
    await waitFor(dW, "link_bound");

    const { token } = await createPat(e, m.userId, tag);
    const mcpL = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofL },
    });
    const mcpW = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proofW },
    });
    clients.push(mcpL, mcpW);

    const hub = await hubOf(m.userId);
    const idOf = async (name: string) =>
      (await hub.snapshot()).agents.find((a) => a.name === name)?.id ?? "";
    const role = uniq("Manager");
    const putRole = (agentId: string | null) =>
      api(app, R.busRoles, m.cookie, {
        method: "PUT",
        body: { namespace: space, name: role, agentId },
      });
    expect((await putRole(await idOf(nameL))).status).toBe(200);

    const id = (
      await publish(
        E(),
        user,
        {
          title: "doc",
          format: "html",
          content: "<p>Plan</p>",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;

    const roster = async () => {
      const r = await api(app, R.artifactAgents(id), m.cookie);
      expect(r.status).toBe(200);
      const body = (await r.json()) as
        | ArtifactAgent[]
        | { agents: ArtifactAgent[] };
      return Array.isArray(body) ? body : body.agents;
    };
    const roleEntry = (await roster()).find((a) => a.name === role);
    expect(roleEntry?.key).toMatch(/^role:/);
    const rKey = roleEntry!.key;

    const readThread = async (
      threadId: string,
      cookie: string | null = m.cookie,
    ) => {
      resetNameClashCache();
      const r = await api(app, R.comments(id), cookie);
      expect(r.status).toBe(200);
      const list = (await r.json()) as CommentList;
      return list.threads.find((t) => t.id === threadId) as CommentThread;
    };

    return {
      m,
      user,
      dL,
      dW,
      space,
      nameL,
      nameW,
      mcpL,
      mcpW,
      hub,
      idOf,
      role,
      putRole,
      id,
      rKey,
      readThread,
    };
  }

  it("mention @Manager, reply as holder, hand role to new session: one participant, follows move, removal stops replies", async () => {
    const s = await setupTwoHolders("mention-reply");

    const started = await api(app, R.comments(s.id), s.m.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: `@${s.role} please take a look`,
        mentions: [{ key: s.rKey }],
      },
    });
    expect(started.status, await started.clone().text()).toBe(201);
    const created = (await started.json()) as CommentThread;
    expect(created.agents).toHaveLength(1);
    expect(created.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameL,
      machine: "Laptop",
      linked: true,
    });
    expect(created.agents?.[0]?.animal).toBeDefined();
    expect(created.comments[0]?.mentions?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      linked: true,
    });
    expect(created.comments[0]?.mentions?.[0]?.animal).toBeDefined();

    const mentionFrame = await nextCommentDeliver(s.dL);
    expect(mentionFrame.to_ref).toBe("refL");
    expect(mentionFrame.body).toContain(created.id);

    // Holder replies over real MCP: must attribute to the role, NOT add a second agent.
    const replied = await tool(s.mcpL, "add_comment", {
      id: s.id,
      threadId: created.id,
      body: "On it.",
    });
    expect(replied.isError, JSON.stringify(replied.content)).toBeFalsy();

    const afterReply = await s.readThread(created.id);
    expect(afterReply.agents).toHaveLength(1);
    expect(afterReply.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameL,
      machine: "Laptop",
      linked: true,
    });
    expect(afterReply.comments[1]?.author).toMatchObject({
      kind: "agent",
      name: s.role,
      session: s.nameL,
      role: { name: s.role, machine: "Laptop" },
    });

    // Follow-up reply from member notifies the holder ONCE (no duplicate session row).
    const followUp = await api(
      app,
      R.commentReplies(s.id, created.id),
      s.m.cookie,
      { method: "POST", body: { body: "Any update?" } },
    );
    expect(followUp.status).toBe(201);
    const f1 = await nextCommentDeliver(s.dL);
    expect(f1.to_ref).toBe("refL");
    expect(f1.body).toContain(created.id);
    const extraL = (await barrier(s.dL, "refL")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(extraL).toHaveLength(0);

    // Hand role to Workstation session (keeping Laptop session live!).
    expect((await s.putRole(await s.idOf(s.nameW))).status).toBe(200);

    const afterMove = await s.readThread(created.id);
    expect(afterMove.agents).toHaveLength(1);
    expect(afterMove.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameW,
      machine: "Workstation",
      linked: true,
    });

    // Reply now notifies the new holder (refW) and NOT the old holder (refL).
    const afterMoveReply = await api(
      app,
      R.commentReplies(s.id, created.id),
      s.m.cookie,
      { method: "POST", body: { body: "Handed over?" } },
    );
    expect(afterMoveReply.status).toBe(201);
    const fW = await nextCommentDeliver(s.dW);
    expect(fW.to_ref).toBe("refW");
    expect(fW.body).toContain(created.id);
    const staleL = (await barrier(s.dL, "refL")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(staleL).toHaveLength(0);

    // New holder replies over MCP: still exactly ONE participant.
    const replyW = await tool(s.mcpW, "add_comment", {
      id: s.id,
      threadId: created.id,
      body: "Picked up on Workstation.",
    });
    expect(replyW.isError, JSON.stringify(replyW.content)).toBeFalsy();
    const afterReplyW = await s.readThread(created.id);
    expect(afterReplyW.agents).toHaveLength(1);
    expect(afterReplyW.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameW,
      machine: "Workstation",
    });

    // Removing the role removes the one participant and stops replies to the holder.
    const rm = await api(
      app,
      R.commentThreadAgent(s.id, created.id, s.rKey),
      s.m.cookie,
      { method: "DELETE" },
    );
    expect(rm.status).toBe(204);
    const afterRemove = await s.readThread(created.id);
    expect(afterRemove.agents).toHaveLength(1);
    expect(afterRemove.agents?.[0]).toMatchObject({
      key: s.rKey,
      removed: true,
    });
    expect(
      (
        await api(app, R.commentReplies(s.id, created.id), s.m.cookie, {
          method: "POST",
          body: { body: "Quiet now" },
        })
      ).status,
    ).toBe(201);
    const quietW = (await barrier(s.dW, "refW")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(quietW).toHaveLength(0);
  });

  it("holder-started ask thread keys by role, survives move (even with old session live), and delivers answer + reply to new holder", async () => {
    const s = await setupTwoHolders("ask-role");

    const askRes = await tool(s.mcpL, "add_comment", {
      id: s.id,
      body: "Deploy now?",
      ask: {
        question: "Deploy now?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        to: [{ key: s.m.userId }],
      },
    });
    expect(askRes.isError, JSON.stringify(askRes.content)).toBeFalsy();
    const { threadId, commentId } = askRes.structuredContent as {
      threadId: string;
      commentId: string;
    };

    const t0 = await s.readThread(threadId);
    expect(t0.agents).toHaveLength(1);
    expect(t0.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameL,
      machine: "Laptop",
      linked: true,
    });

    // Mentioning @Manager in the same thread must NOT create a second participant.
    expect(
      (
        await api(app, R.commentReplies(s.id, threadId), s.m.cookie, {
          method: "POST",
          body: {
            body: `@${s.role} checking`,
            mentions: [{ key: s.rKey }],
          },
        })
      ).status,
    ).toBe(201);
    await nextCommentDeliver(s.dL);
    expect((await s.readThread(threadId)).agents).toHaveLength(1);

    // Move role to Workstation and answer the ask: answer goes to Workstation.
    expect((await s.putRole(await s.idOf(s.nameW))).status).toBe(200);
    const ans = await api(
      app,
      R.commentAnswer(s.id, threadId, commentId),
      s.m.cookie,
      { method: "POST", body: { optionId: "yes" } },
    );
    expect(ans.status).toBe(200);
    const ansFrame = await nextCommentDeliver(s.dW);
    expect(ansFrame.to_ref).toBe("refW");
    expect(ansFrame.body).toContain(commentId);
  });

  it("page publisher holding a role joins a page-wide note under the role key (no duplicate on holder reply)", async () => {
    const s = await setupTwoHolders("pub-role");
    const pub = await tool(s.mcpL, "publish_artifact", {
      title: "Role page",
      format: "html",
      content: "<p>Published by role</p>",
    });
    expect(pub.isError, JSON.stringify(pub.content)).toBeFalsy();
    const pageId = (pub.structuredContent as { id: string }).id;

    const started = await api(app, R.comments(pageId), s.m.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "Nice draft" },
    });
    expect(started.status).toBe(201);
    const thread = (await started.json()) as CommentThread;
    expect(thread.agents).toHaveLength(1);
    expect(thread.agents?.[0]?.key).toMatch(/^role:/);
    expect(thread.agents?.[0]?.name).toBe(s.role);

    const reply = await tool(s.mcpL, "add_comment", {
      id: pageId,
      threadId: thread.id,
      body: "Thanks!",
    });
    expect(reply.isError, JSON.stringify(reply.content)).toBeFalsy();

    resetNameClashCache();
    const listed = await api(app, R.comments(pageId), s.m.cookie);
    const threads = ((await listed.json()) as CommentList).threads;
    const t = threads.find((x) => x.id === thread.id);
    expect(t?.agents).toHaveLength(1);
    expect(t?.agents?.[0]?.key).toBe(thread.agents?.[0]?.key);
  });

  it("legacy duplicate session+role rows deduplicate on read, notify once, remove together, and mask machine from other members", async () => {
    const s = await setupTwoHolders("legacy-dedup");
    const editor = await member();
    const editorUser = (await getUser(e, editor.userId)) as Member;
    expect(
      (
        await api(app, R.shares(s.id), s.m.cookie, {
          method: "PUT",
          body: { email: editorUser.email, role: "editor" },
        })
      ).status,
    ).toBe(200);

    const started = await api(app, R.comments(s.id), s.m.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: `@${s.role} legacy check`,
        mentions: [{ key: s.rKey }],
      },
    });
    expect(started.status).toBe(201);
    const thread = (await started.json()) as CommentThread;
    await nextCommentDeliver(s.dL);

    // Simulate pre-fix state: a legacy agent:<hash> row for the holding session
    // sitting alongside role:<roleId>:<hash> in comment_participants.
    const identityL = await s.hub.identityOf(s.space, s.nameL);
    expect(identityL?.identityId).toBeTruthy();
    const legacyKey = await agentKey(s.id, s.m.userId, {
      namespace: s.space,
      name: s.nameL,
    });
    await runInDurableObject(
      runtimeStub(E(), s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          `insert into comment_participants (thread_id, key, name, owner, namespace, page, identity, joined_at)
           values (?, ?, ?, ?, ?, 0, ?, ?)`,
          thread.id,
          legacyKey,
          s.nameL,
          s.m.userId,
          s.space,
          JSON.stringify(identityL),
          new Date().toISOString(),
        );
      },
    );

    // Owner sees ONE participant (the role) with session and machine.
    const ownerView = await s.readThread(thread.id, s.m.cookie);
    expect(ownerView.agents).toHaveLength(1);
    expect(ownerView.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameL,
      machine: "Laptop",
    });

    // Another member sees ONE participant with session and NO machine.
    const editorView = await s.readThread(thread.id, editor.cookie);
    expect(editorView.agents).toHaveLength(1);
    expect(editorView.agents?.[0]).toMatchObject({
      key: s.rKey,
      name: s.role,
      session: s.nameL,
    });
    expect(editorView.agents?.[0]?.machine).toBeUndefined();

    // Replying notifies the holder ONCE (never twice for role + legacy session).
    expect(
      (
        await api(app, R.commentReplies(s.id, thread.id), s.m.cookie, {
          method: "POST",
          body: { body: "Once only" },
        })
      ).status,
    ).toBe(201);
    await nextCommentDeliver(s.dL);
    const extras = (await barrier(s.dL, "refL")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(extras).toHaveLength(0);

    // Explicit @Manager in a reply on the same legacy two-row thread also delivers
    // ONCE (excluding the role from threadReplyTake must not leak a second notice
    // through the legacy session row).
    const explicit = await api(
      app,
      R.commentReplies(s.id, thread.id),
      s.m.cookie,
      {
        method: "POST",
        body: {
          body: `@${s.role} explicit ping`,
          mentions: [{ key: s.rKey }],
        },
      },
    );
    expect(explicit.status).toBe(201);
    const explicitBody = (await explicit.json()) as {
      notified?: { key: string }[];
    };
    expect(explicitBody.notified ?? []).toHaveLength(0);
    await nextCommentDeliver(s.dL);
    const explicitExtras = (await barrier(s.dL, "refL")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(explicitExtras).toHaveLength(0);

    // Removing the role removes the legacy shadow row too: later replies notify nobody.
    expect(
      (
        await api(
          app,
          R.commentThreadAgent(s.id, thread.id, s.rKey),
          s.m.cookie,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await api(app, R.commentReplies(s.id, thread.id), s.m.cookie, {
          method: "POST",
          body: { body: "After remove" },
        })
      ).status,
    ).toBe(201);
    const afterRm = (await barrier(s.dL, "refL")).filter(
      (f) => f.type === "deliver" && !f.body?.startsWith("Your role "),
    );
    expect(afterRm).toHaveLength(0);
  });

  it("retains #2577 askedBy provenance for both role-keyed and legacy session-keyed requests", async () => {
    const s = await setupTwoHolders("askedby");

    // 1. Role-keyed mention -> holder replies with requestCommentId -> askedBy set.
    const roleThreadRes = await api(app, R.comments(s.id), s.m.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: `@${s.role} please confirm`,
        mentions: [{ key: s.rKey }],
      },
    });
    expect(roleThreadRes.status).toBe(201);
    const roleThread = (await roleThreadRes.json()) as CommentThread;
    await nextCommentDeliver(s.dL);
    const roleRootId = roleThread.comments[0]?.id as string;

    const replyRole = await tool(s.mcpL, "add_comment", {
      id: s.id,
      threadId: roleThread.id,
      body: "Confirmed as role.",
      requestCommentId: roleRootId,
    });
    expect(replyRole.isError, JSON.stringify(replyRole.content)).toBeFalsy();
    const roleView = await s.readThread(roleThread.id);
    expect(roleView.comments[1]?.askedBy).toBeDefined();

    // 2. Legacy session-keyed mention delivered before taking the role -> holder
    // replies with requestCommentId -> askedBy still verified via sessionKey + identityId.
    const legacyKey = await agentKey(s.id, s.m.userId, {
      namespace: s.space,
      name: s.nameL,
    });
    const identityL = await s.hub.identityOf(s.space, s.nameL);
    expect(identityL?.identityId).toBeTruthy();

    const plainThreadRes = await api(app, R.comments(s.id), s.m.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "Legacy ping" },
    });
    expect(plainThreadRes.status).toBe(201);
    const plainThread = (await plainThreadRes.json()) as CommentThread;
    const legacyRootId = plainThread.comments[0]?.id as string;
    await runInDurableObject(
      runtimeStub(E(), s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          `insert into comment_targets (comment_id, thread_id, kind, key, name, state, owner, identity)
           values (?, ?, 'mention', ?, ?, 'delivered', ?, ?)`,
          legacyRootId,
          plainThread.id,
          legacyKey,
          s.nameL,
          s.m.userId,
          JSON.stringify(identityL),
        );
      },
    );

    // The matching session (now holding Manager) retains askedBy provenance.
    const replyLegacy = await tool(s.mcpL, "add_comment", {
      id: s.id,
      threadId: plainThread.id,
      body: "Answering legacy request.",
      requestCommentId: legacyRootId,
    });
    expect(
      replyLegacy.isError,
      JSON.stringify(replyLegacy.content),
    ).toBeFalsy();
    const legacyView = await s.readThread(plainThread.id);
    expect(legacyView.comments[1]?.askedBy).toBeDefined();

    // Another session (Workstation, even after taking Manager) must NOT claim askedBy
    // for Laptop's legacy session-keyed request.
    expect((await s.putRole(await s.idOf(s.nameW))).status).toBe(200);
    const replyOther = await tool(s.mcpW, "add_comment", {
      id: s.id,
      threadId: plainThread.id,
      body: "Different session.",
      requestCommentId: legacyRootId,
    });
    expect(replyOther.isError, JSON.stringify(replyOther.content)).toBeFalsy();
    const afterOther = await s.readThread(plainThread.id);
    expect(afterOther.comments[2]?.askedBy).toBeUndefined();
  });

  it("hides private takeover routing suffixes from thread participants and strips participants for outsiders (#3252, #3335)", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const editor = await member();
    const restricted = await member();
    await e.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(restricted.userId)
      .run();
    const guest = await member("guest");

    const laptop = await machine("Laptop", m.userId);
    const workstation = await machine("Workstation", m.userId);
    const dL = await daemon(laptop.token);
    const dW = await daemon(workstation.token);
    dL.send({
      ...hello(`hL-${++seq}`),
      caps: [BUS_CAPS.link, BUS_CAPS.follow, BUS_CAPS.roles],
    } as never);
    await waitFor(dL, "hello_ok");
    dW.send({
      ...hello(`hW-${++seq}`),
      caps: [BUS_CAPS.link, BUS_CAPS.follow, BUS_CAPS.roles],
    } as never);
    await waitFor(dW, "hello_ok");

    const space = ns("private-suffix");
    const role = uniq("Lead");
    // First chosen name creates the role held by Laptop.
    dL.send({
      ...up(`uL-${++seq}`, "refL", role, space),
      name_chosen: true,
    } as never);
    expect((await waitFor(dL, "agent_ok")).bus_name).toBe(role);
    // Bind a proof so Laptop has a real identity for the legacy moved-row check.
    dL.send({
      v: 1,
      id: `bL-${++seq}`,
      type: "link_bind",
      agent_ref: "refL",
      hash: await sha256Hex(proofOf()),
    } as never);
    await waitFor(dL, "link_bound");

    // Second session asking for the held name gets a private routing suffix ("Lead-2").
    dW.send({
      ...up(`uW-${++seq}`, "refW", role, space),
      name_chosen: true,
    } as never);
    const privateName = (await waitFor(dW, "agent_ok")).bus_name;
    expect(privateName).toBe(`${role}-2`);
    dW.send({
      v: 1,
      id: `bW-${++seq}`,
      type: "link_bind",
      agent_ref: "refW",
      hash: await sha256Hex(proofOf()),
    } as never);
    await waitFor(dW, "link_bound");

    const id = (
      await publish(
        E(),
        user,
        {
          title: "public-doc",
          format: "html",
          content: "<p>Public</p>",
          visibility: "public",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;

    // Seed a legacy agent:<hash> participant written while Laptop held the role.
    const hub = await hubOf(m.userId);
    const identityL = await hub.identityOf(space, role);
    expect(identityL?.identityId).toBeTruthy();
    const legacyKey = await agentKey(id, m.userId, {
      namespace: space,
      name: role,
    });
    const legacyThreadRes = await api(app, R.comments(id), m.cookie, {
      method: "POST",
      body: { anchor: { kind: "note" }, body: "Pre-move legacy thread" },
    });
    expect(legacyThreadRes.status).toBe(201);
    const legacyThread = (await legacyThreadRes.json()) as CommentThread;
    await runInDurableObject(
      runtimeStub(E(), id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          `insert into comment_participants (thread_id, key, name, owner, namespace, page, identity, joined_at)
           values (?, ?, ?, ?, ?, 0, ?, ?)`,
          legacyThread.id,
          legacyKey,
          role,
          m.userId,
          space,
          JSON.stringify(identityL),
          new Date().toISOString(),
        );
      },
    );

    // Hand the role over to the contending session on Workstation (which keeps privateName).
    const idW = (await hub.snapshot()).agents.find(
      (a) => a.name === privateName,
    )?.id;
    expect(idW).toBeTruthy();
    expect(
      (
        await api(app, R.busRoles, m.cookie, {
          method: "PUT",
          body: { namespace: space, name: role, agentId: idW },
        })
      ).status,
    ).toBe(200);

    const rosterRes = await api(app, R.artifactAgents(id), m.cookie);
    expect(rosterRes.status).toBe(200);
    const rosterBody = (await rosterRes.json()) as
      | ArtifactAgent[]
      | { agents: ArtifactAgent[] };
    const roster = Array.isArray(rosterBody) ? rosterBody : rosterBody.agents;
    const roleEntry = roster.find((a) => a.name === role);
    expect(roleEntry?.key).toMatch(/^role:/);
    const rKey = roleEntry!.key;

    const started = await api(app, R.comments(id), m.cookie, {
      method: "POST",
      body: {
        anchor: { kind: "note" },
        body: `@${role} check routing privacy`,
        mentions: [{ key: rKey }],
      },
    });
    expect(started.status).toBe(201);
    const roleThread = (await started.json()) as CommentThread;
    await nextCommentDeliver(dW);

    const listAs = async (cookie: string | null) => {
      resetNameClashCache();
      const res = await api(app, R.comments(id), cookie);
      expect(res.status).toBe(200);
      return (await res.json()) as CommentList;
    };

    // Owner sees role name + machine, NEVER the private "-2" routing suffix.
    const ownerList = await listAs(m.cookie);
    const ownerRole = ownerList.threads.find((t) => t.id === roleThread.id);
    expect(ownerRole?.agents).toHaveLength(1);
    expect(ownerRole?.agents?.[0]).toMatchObject({
      key: rKey,
      name: role,
      linked: true,
      machine: "Workstation",
    });
    expect(ownerRole?.agents?.[0]?.session).toBeUndefined();
    expect(JSON.stringify(ownerRole?.agents)).not.toContain(privateName);

    // Legacy moved session-keyed row also omits the private "-2" suffix.
    const ownerLegacy = ownerList.threads.find((t) => t.id === legacyThread.id);
    expect(ownerLegacy?.agents).toHaveLength(1);
    expect(ownerLegacy?.agents?.[0]).toMatchObject({
      key: legacyKey,
      name: role,
      machine: "Workstation",
    });
    expect(ownerLegacy?.agents?.[0]?.session).toBeUndefined();
    expect(JSON.stringify(ownerLegacy?.agents)).not.toContain(privateName);

    // Another member sees role name, NO private suffix, and NO machine.
    const memberList = await listAs(editor.cookie);
    const memberRole = memberList.threads.find((t) => t.id === roleThread.id);
    expect(memberRole?.agents).toHaveLength(1);
    expect(memberRole?.agents?.[0]).toMatchObject({
      key: rKey,
      name: role,
      linked: true,
    });
    expect(memberRole?.agents?.[0]?.session).toBeUndefined();
    expect(memberRole?.agents?.[0]?.machine).toBeUndefined();

    // Outsiders (anonymous, guest, restricted/capped) see no thread participants at all.
    for (const cookie of [null, guest.cookie, restricted.cookie]) {
      const out = await listAs(cookie);
      for (const t of out.threads) expect(t.agents).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain(privateName);
      expect(JSON.stringify(out)).not.toContain("Workstation");
    }
  });
});
