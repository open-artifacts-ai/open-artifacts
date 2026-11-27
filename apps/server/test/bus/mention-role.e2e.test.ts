// #3132 end to end: after a role moves, the member's @ list offers the role
// (not a session name), and picking it in a real comment POST reaches the
// session that holds the role now. Real hub, real daemon sockets, the real
// agents and comment routes; waits are frames, never sleeps.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS } from "@oa/bus-protocol";
import { type ArtifactAgent, type Member, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { publish } from "../../src/services/artifacts.js";
import { getUser } from "../../src/services/users.js";
import { api } from "../helpers.js";
import { E } from "../mcp-helpers.js";
import {
  daemon,
  e,
  fence,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const app = createApp();
let seq = 0;
const uniq = (t: string) => `${t}${++seq}x${Date.now() % 1e8}`;

describe("an @-mention of a role (#3132)", () => {
  it.each(["away", "purged", "vacated"] as const)(
    "a %s holder leaves the role mentionable until the next holder receives its notice",
    async (transition) => {
      const m = await member();
      const user = (await getUser(e, m.userId)) as Member;
      const mach = await machine("Laptop", m.userId);
      const d = await daemon(mach.token);
      d.send({ ...hello("h1"), caps: [BUS_CAPS.follow] } as never);
      await waitFor(d, "hello_ok");
      const space = ns("mention");
      const names: string[] = [];
      for (const [i, n] of [uniq("PlatL"), uniq("PlatW")].entries()) {
        d.send(up(`u${i}`, `ref${i}`, n, space));
        names.push((await waitFor(d, "agent_ok")).bus_name);
      }
      const hub = await hubOf(m.userId);
      const idOf = async (name: string) =>
        (await hub.snapshot()).agents.find((a) => a.name === name)?.id ?? "";
      const role = uniq("Platform");
      const put = (agentId: string | null) =>
        api(app, R.busRoles, m.cookie, {
          method: "PUT",
          body: { namespace: space, name: role, agentId },
        });
      expect((await put(await idOf(names[0]!))).status).toBe(200);

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
      const roster = async () => {
        const listed = await api(app, R.artifactAgents(id), m.cookie);
        expect(listed.status).toBe(200);
        const agents = (await listed.json()) as
          | ArtifactAgent[]
          | { agents: ArtifactAgent[] };
        return Array.isArray(agents) ? agents : agents.agents;
      };
      const entry = (await roster()).find((a) => a.name === role);
      expect(entry?.session).toBe(names[0]);
      const priorId = await idOf(names[0]!);
      d.send({ v: 1, id: "down", type: "agent_down", agent_ref: "ref0" });
      d.send({ v: 1, id: "barrier", type: "list", from_ref: "ref1" });
      await waitFor(d, "roster");
      expect((await roster()).find((a) => a.key === entry?.key)).toMatchObject({
        name: role,
        state: "away",
      });
      if (transition === "purged") {
        await runInDurableObject(hub, (_, state) => {
          state.storage.sql.exec("delete from agents where id = ?", priorId);
        });
      } else if (transition === "vacated") {
        expect((await put(null)).status).toBe(200);
      }
      expect(
        (await roster()).filter((a) => a.key === entry?.key),
      ).toMatchObject([{ name: role, state: "away" }]);
      const posted = await api(app, R.comments(id), m.cookie, {
        method: "POST",
        body: {
          anchor: { kind: "note" },
          body: `@${role} can you roll the host?`,
          mentions: [{ key: entry?.key }],
        },
      });
      expect(posted.status, await posted.clone().text()).toBeLessThan(300);
      expect((await put(await idOf(names[1]!))).status).toBe(200);
      const all = await roster();
      expect(all.filter((a) => a.name === role)).toHaveLength(1);
      expect(all.find((a) => a.key === entry?.key)).toMatchObject({
        name: role,
        session: names[1],
      });
      expect(all.some((a) => a.name === names[1])).toBe(false);
      // Explicitly vacating leaves the old session its own independent name.
      if (transition !== "vacated")
        expect(all.some((a) => a.name === names[0])).toBe(false);
      for (;;) {
        const f = await d.next();
        if (f.type !== "deliver" || f.body?.startsWith("Your role ")) continue;
        expect(f.to_ref).toBe("ref1");
        expect(f.body).toContain(id);
        break;
      }

      // Freeing and reusing the same name creates a new role. A stale picker
      // cannot send a comment to that unrelated holder.
      const current = (await hub.listRoles()).find((r) => r.name === role);
      expect(current).toBeDefined();
      await hub.deleteRole(current!.id);
      expect((await put(await idOf(names[1]!))).status).toBe(200);
      const replacement = (await roster()).find((a) => a.name === role);
      expect(replacement?.key).toBeTruthy();
      expect(replacement?.key).not.toBe(entry?.key);
      const stale = await api(app, R.comments(id), m.cookie, {
        method: "POST",
        body: {
          anchor: { kind: "note" },
          body: "Old picker",
          mentions: [{ key: entry?.key }],
        },
      });
      expect(stale.status).toBe(400);
    },
  );

  it("an unnamed session is hidden even when live; a role stays listed after its holder closes (#3143)", async () => {
    const m = await member();
    const user = (await getUser(e, m.userId)) as Member;
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({ ...hello("h1"), caps: [BUS_CAPS.follow] } as never);
    await waitFor(d, "hello_ok");
    const space = ns("away");
    const names: string[] = [];
    for (const [i, n] of [uniq("Plain"), uniq("Holder")].entries()) {
      d.send(up(`u${i}`, `ref${i}`, n, space));
      names.push((await waitFor(d, "agent_ok")).bus_name);
    }
    const hub = await hubOf(m.userId);
    const holderId =
      (await hub.snapshot()).agents.find((a) => a.name === names[1])?.id ?? "";
    const role = uniq("Search");
    expect(
      (
        await api(app, R.busRoles, m.cookie, {
          method: "PUT",
          body: { namespace: space, name: role, agentId: holderId },
        })
      ).status,
    ).toBe(200);
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
    const listed = async () => {
      const r = await api(app, R.artifactAgents(id), m.cookie);
      expect(r.status).toBe(200);
      const j = (await r.json()) as
        | ArtifactAgent[]
        | { agents: ArtifactAgent[] };
      return Array.isArray(j) ? j : j.agents;
    };
    const before = await listed();
    expect(before.some((a) => a.name === names[0])).toBe(false);
    expect(before.some((a) => a.name === role)).toBe(true);

    d.send({ v: 1, id: "d0", type: "agent_down", agent_ref: "ref0" });
    d.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "ref1" });
    // A frame after the downs: the hub has handled both once it answers.
    await fence(d);
    const after = await listed();
    expect(after.some((a) => a.name === names[0])).toBe(false);
    expect(after.find((a) => a.name === role)).toMatchObject({
      name: role,
      online: false,
    });
  });
});
