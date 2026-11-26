// #3132 end to end, on the real paths: a linked session posts an ask over
// /mcp, the member moves its role to another session in the dashboard (PUT
// R.busRoles), the old session closes and is gone from the hub entirely, and
// the member's answer in the web app reaches the new holder, and so does a
// reply in that thread; a reply in a thread it joined before it held the role
// does not. (The time rules in full are hub.role-move.test.ts.) Real hub, real daemon
// sockets, real comment and answer routes; waits are frames, never sleeps.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { type Member, R } from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { publish } from "../../src/services/artifacts.js";
import { resetNameClashCache } from "../../src/services/comments.js";
import { getUser } from "../../src/services/users.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { api } from "../helpers.js";
import { close, connect, E, tool } from "../mcp-helpers.js";
import {
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

describe("a moved role on the real paths (#3132)", () => {
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  afterAll(() => Promise.all(clients.map((c) => close(c))));

  it("the answer to an ask posted while the role was held reaches the new holder after the old session is gone", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({
      ...hello("h1"),
      caps: [BUS_CAPS.link, BUS_CAPS.follow],
    } as never);
    await waitFor(d, "hello_ok");
    const space = ns("e2e");
    const proof = proofOf();
    const names: string[] = [];
    for (const [i, n] of [uniq("PlatL"), uniq("PlatW")].entries()) {
      d.send(up(`u${i}`, `ref${i}`, n, space));
      names.push((await waitFor(d, "agent_ok")).bus_name);
    }
    d.send({
      v: 1,
      id: "b0",
      type: "link_bind",
      agent_ref: "ref0",
      hash: await sha256Hex(proof),
    } as never);
    await waitFor(d, "link_bound");
    const { token } = await createPat(e, m.userId, "e2e");
    const old = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proof },
    });
    clients.push(old);
    const hub = await hubOf(m.userId);
    const idOf = async (name: string) =>
      (await hub.snapshot()).agents.find((a) => a.name === name)?.id ?? "";

    const id = (
      await publish(
        E(),
        user,
        {
          title: "doc",
          format: "html",
          content: "<p>Roll the host?</p>",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const askOf = async (question: string) => {
      const r = await tool(old, "add_comment", {
        id,
        body: question,
        ask: {
          question,
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          to: [{ key: m.userId }],
        },
      });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      // #3163: add_comment returns the short result.
      const t = r.structuredContent as { threadId: string; commentId: string };
      return { threadId: t.threadId, commentId: t.commentId };
    };
    const put = (agentId: string) =>
      api(app, R.busRoles, m.cookie, {
        method: "PUT",
        body: { namespace: space, name: role, agentId },
      });
    const role = uniq("Platform");

    // A thread the old session joined before it held the role.
    const pre = await tool(old, "add_comment", { id, body: "Before the role" });
    expect(pre.isError, JSON.stringify(pre.content)).toBeFalsy();
    const preThread = (pre.structuredContent as { threadId: string }).threadId;
    expect((await put(await idOf(names[0]!))).status).toBe(200);
    const asked = await askOf("Roll the PostHog host?");
    expect((await put(await idOf(names[1]!))).status).toBe(200);

    // The old session closes and is gone from the hub for good.
    d.send({ v: 1, id: "down", type: "agent_down", agent_ref: "ref0" });
    await runInDurableObject(hub, (_, s) => {
      s.storage.sql.exec(
        "delete from former_names where agent_id in (select id from agents where native_ref = 'ref0')",
      );
      s.storage.sql.exec("delete from agents where native_ref = 'ref0'");
    });
    resetNameClashCache();

    const res = await api(
      app,
      R.commentAnswer(id, asked.threadId, asked.commentId),
      m.cookie,
      { method: "POST", body: { optionId: "yes" } },
    );
    expect(res.status).toBe(200);
    for (;;) {
      const f = await d.next();
      if (f.type !== "deliver") continue;
      // The old session heard of the move while still open (#3132).
      if (f.body?.startsWith("Your role ")) continue;
      expect(f.to_ref).toBe("ref1");
      expect(f.body).toContain(asked.commentId);
      break;
    }

    // The member replies in both threads, the old one first. Only the thread
    // the old session joined while it held the role reaches the new holder.
    const reply = (threadId: string) =>
      api(app, R.commentReplies(id, threadId), m.cookie, {
        method: "POST",
        body: { body: "Any news?" },
      });
    expect((await reply(preThread)).status).toBeLessThan(300);
    expect((await reply(asked.threadId)).status).toBeLessThan(300);
    for (;;) {
      const f = await d.next();
      if (f.type !== "deliver") continue;
      expect(f.to_ref).toBe("ref1");
      expect(f.body).toContain(asked.threadId);
      expect(f.body).not.toContain(preThread);
      break;
    }
  });
});
