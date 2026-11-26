// #3132: a comment by a linked agent whose session holds a role shows that
// role (the address to @-mention); after the role moves, the old comment
// keeps its author and says who holds the role now. Real /mcp with link
// proofs, a real hub; the per-isolate names cache is reset between reads.
import { BUS_CAPS, LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { type CommentList, type Member, R } from "@oa/shared";
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

describe("a role on a page (#3132)", () => {
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  afterAll(() => Promise.all(clients.map((c) => close(c))));

  it("the author shows its role, and after a move who holds it now", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({ ...hello("h1"), caps: [BUS_CAPS.link] } as never);
    await waitFor(d, "hello_ok");
    const space = ns("face");
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
    const { token } = await createPat(e, m.userId, "face");
    const c = await connect(token, {
      headers: { [LINK_PROOF_HEADER]: proof },
    });
    clients.push(c);
    const hub = await hubOf(m.userId);
    const idOf = async (name: string) =>
      (await hub.snapshot()).agents.find((a) => a.name === name)?.id ?? "";
    const role = uniq("Platform");
    expect((await hub.putRole(space, role, await idOf(names[0]!))).ok).toBe(
      true,
    );

    const id = (
      await publish(
        E(),
        user,
        {
          title: "doc",
          format: "html",
          content: "<p>Notes</p>",
          comments: "everyone",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    const made = await tool(c, "add_comment", { id, body: "Shipped." });
    expect(made.isError, JSON.stringify(made.content)).toBeFalsy();

    const author = async () => {
      resetNameClashCache();
      const r = await api(app, R.comments(id), m.cookie);
      expect(r.status).toBe(200);
      const list = (await r.json()) as CommentList;
      return list.threads[0]?.comments[0]?.author;
    };
    expect(await author()).toMatchObject({
      kind: "agent",
      name: role,
      session: names[0],
      role: { name: role },
    });
    expect((await author())?.role).not.toHaveProperty("holder");

    expect((await hub.putRole(space, role, await idOf(names[1]!))).ok).toBe(
      true,
    );
    expect(await author()).toMatchObject({
      name: role,
      session: names[0],
      role: { name: role, holder: names[1] },
    });
  });
});
