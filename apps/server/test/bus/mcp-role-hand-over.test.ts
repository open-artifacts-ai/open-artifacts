// #3132: through the real /mcp transport with bus link proofs, the role's
// live holder hands its role to another open agent of the member at once
// (bus_role_propose set, no link), and its open ask's answer then reaches the
// new holder. Any other session only proposes. Waits are signals (frames,
// tool replies), never sleeps.
import { BUS_CAPS, LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { type Member, R } from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { publish } from "../../src/services/artifacts.js";
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

type Clients = Awaited<ReturnType<typeof connect>>[];

/** A member, one daemon, agents `Old` and `New` linked over MCP, and an unlinked client. */
async function setup(clients: Clients) {
  const m = await member();
  const user = (await getUser(e, m.userId)) as Member;
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({
    ...hello("h1"),
    caps: [BUS_CAPS.link, BUS_CAPS.follow],
  } as never);
  await waitFor(d, "hello_ok");
  const space = ns("hand");
  const names = [uniq("Old"), uniq("New")];
  const proofs = [proofOf(), proofOf()];
  const agents: { ref: string; name: string }[] = [];
  for (const [i, proof] of proofs.entries()) {
    d.send(up(`u${i}`, `ref${i}`, names[i] as string, space));
    const name = (await waitFor(d, "agent_ok")).bus_name;
    d.send({
      v: 1,
      id: `b${i}`,
      type: "link_bind",
      agent_ref: `ref${i}`,
      hash: await sha256Hex(proof),
    } as never);
    await waitFor(d, "link_bound");
    agents.push({ ref: `ref${i}`, name });
  }
  const { token } = await createPat(e, m.userId, "hand");
  const linked = await Promise.all(
    proofs.map((p) => connect(token, { headers: { [LINK_PROOF_HEADER]: p } })),
  );
  const unlinked = await connect(token);
  clients.push(...linked, unlinked);
  const hub = await hubOf(m.userId);
  const agentId = async (name: string) => {
    const a = (await hub.snapshot()).agents.find((x) => x.name === name);
    if (!a) throw new Error(`no open agent ${name}`);
    return a.id;
  };
  const role = uniq("platform");
  const set = await hub.putRole(space, role, await agentId(agents[0]!.name));
  if (!set.ok) throw new Error(set.reason);
  return {
    m,
    user,
    d,
    hub,
    space,
    role,
    agents,
    old: linked[0]!,
    next: linked[1]!,
    unlinked,
  };
}

const audits = async (uid: string) =>
  (
    await e.DB.prepare(
      "select action from audit_events where target_id = ? and action like 'bus.role.%' order by at",
    )
      .bind(uid)
      .all<{ action: string }>()
  ).results.map((r) => r.action);

describe("the holder hands its role over (#3132)", () => {
  const clients: Clients = [];
  afterAll(() => Promise.all(clients.map((c) => close(c))));

  it("moves at once; the old session's ask answer then reaches the new holder", async () => {
    const s = await setup(clients);
    const [old, next] = s.agents;
    const id = (
      await publish(
        E(),
        s.user,
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
    const made = await tool(s.old, "add_comment", {
      id,
      body: "Ready to roll?",
      ask: {
        question: "Roll the PostHog host?",
        options: [
          { id: "roll", label: "Roll it" },
          { id: "wait", label: "Not yet" },
        ],
        to: [{ key: s.m.userId }],
      },
    });
    expect(made.isError, JSON.stringify(made.content)).toBeFalsy();

    const r = await tool(s.old, "bus_role_propose", {
      action: "set",
      namespace: s.space,
      name: s.role,
      agent: next!.name,
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      handedOver: true,
      role: { name: s.role, holderName: next!.name, vacant: false },
    });
    expect(await audits(s.m.userId)).toEqual(["bus.role.moved"]);

    // The old session closes; Leo answers its ask in the web app.
    s.d.send({ v: 1, id: "down", type: "agent_down", agent_ref: old!.ref });
    const t = (
      made.structuredContent as {
        thread: { id: string; comments: { id: string }[] };
      }
    ).thread;
    const res = await api(
      app,
      R.commentAnswer(id, t.id, t.comments[0]?.id ?? ""),
      s.m.cookie,
      { method: "POST", body: { optionId: "roll" } },
    );
    expect(res.status).toBe(200);
    let moved = "";
    for (;;) {
      const f = await s.d.next();
      if (f.type !== "deliver") continue;
      // The old session heard of the move first (#3132), while still open.
      if (f.body?.startsWith("Your role ")) {
        expect(f.to_ref).toBe(old!.ref);
        moved = f.body;
        continue;
      }
      expect(f.to_ref).toBe(next!.ref);
      break;
    }
    expect(moved).toContain(`moved to ${next!.name}`);
  });

  it("a session that doesn't hold the role only proposes, linked or not", async () => {
    const s = await setup(clients);
    const [old, next] = s.agents;
    for (const c of [s.next, s.unlinked]) {
      const r = await tool(c, "bus_role_propose", {
        action: "set",
        namespace: s.space,
        name: s.role,
        agent: next!.name,
      });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      expect(r.structuredContent).toHaveProperty("confirmUrl");
      expect(r.structuredContent).not.toHaveProperty("handedOver");
    }
    const [role] = (await s.hub.listRoles()).filter((x) => x.name === s.role);
    expect(role?.holderName).toBe(old!.name);
    expect(await audits(s.m.userId)).toEqual([
      "bus.role.proposed",
      "bus.role.proposed",
    ]);
  });

  it("the holder naming itself, or no open agent, changes nothing", async () => {
    const s = await setup(clients);
    const [old] = s.agents;
    const self = await tool(s.old, "bus_role_propose", {
      action: "set",
      namespace: s.space,
      name: s.role,
      agent: old!.name,
    });
    // Falls through to the proposal path, which refuses it as unchanged.
    expect(self.isError).toBe(true);
    const none = await tool(s.old, "bus_role_propose", {
      action: "set",
      namespace: s.space,
      name: s.role,
      agent: uniq("nobody"),
    });
    expect(none.isError).toBe(true);
    const [role] = (await s.hub.listRoles()).filter((x) => x.name === s.role);
    expect(role?.holderName).toBe(old!.name);
    expect(await audits(s.m.userId)).toEqual([]);
  });
});
