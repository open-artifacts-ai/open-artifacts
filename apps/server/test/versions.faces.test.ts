import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { type Member, newId, R, type VersionInfo } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// #2118 item 11: a version's agent carries linked, product and animal for a
// bus-linked publish, to members only. Signed-out, guest-role and capped
// viewers get none (#2004), over REST and MCP, as comments do.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
const FACE = ["linked", "product", "animal"];
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

type U = { cookie: string; userId: string; member: Member };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const l = await login(`${prefix}-${tag}@x.com`, role);
  return { ...l, member: (await getUser(E, l.userId)) as Member } as U;
}

let owner: U;
let memberV: U;
let guestV: U;
let restrictedV: U;
let id: string;

beforeAll(async () => {
  owner = await mk("vf-owner");
  memberV = await mk("vf-member");
  guestV = await mk("vf-guest", "guest");
  restrictedV = await mk("vf-restricted");
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
        content: "<p>1</p>",
        visibility: "public",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
  for (const n of [2, 3]) {
    await publish(
      E,
      owner.member,
      { id, content: `<p>${n}</p>`, format: "html" } as never,
      null,
      undefined,
      "version",
    );
  }
  // v1: a person. v2: an unlinked grant. v3: a linked grant.
  const set = (v: number, via: string, identity: string | null) =>
    E.DB.prepare(
      "update versions set agent_name = 'Claude Code', agent_via = ?, agent_identity = ? where artifact_id = ? and version = ?",
    )
      .bind(via, identity, id, v)
      .run();
  await set(2, "g:grant000000000001", null);
  await set(
    3,
    "g:grant000000000002",
    JSON.stringify({
      identityId: "id-run-0001",
      namespace: "ns",
      name: "Runner",
      kind: "claude-code",
    }),
  );
});

const rest = async (u: U | null) =>
  (await (
    await api(app, R.versions(id), u?.cookie ?? null)
  ).json()) as VersionInfo[];
const byV = (l: VersionInfo[], v: number) => l.find((x) => x.version === v);

describe("version faces (REST)", () => {
  it("a member sees the animal for a linked publish", async () => {
    const l = await rest(memberV);
    const a = byV(l, 3)?.agent;
    expect(a?.linked).toBe(true);
    expect(a?.product).toBe("Claude Code");
    expect(a?.animal?.id).toEqual(expect.any(String));
    expect(a?.animal?.color).toBeGreaterThanOrEqual(0);
  });

  it("an unlinked publish and a person have none", async () => {
    for (const u of [owner, memberV]) {
      const l = await rest(u);
      for (const v of [1, 2]) {
        const a = byV(l, v)?.agent;
        for (const k of FACE) expect(a ?? {}).not.toHaveProperty(k);
      }
    }
  });

  it.each([
    ["signed out", () => null],
    ["guest role", () => guestV],
    ["restricted", () => restrictedV],
  ])("%s: no linked, product or animal; id never leaves", async (_n, who) => {
    const l = await rest(who());
    expect(byV(l, 3)?.agent).toBeTruthy();
    for (const v of l)
      for (const k of FACE) expect(v.agent ?? {}).not.toHaveProperty(k);
    expect(JSON.stringify(l)).not.toContain("animal");
    expect(JSON.stringify(l)).not.toContain("id-run-0001");
  });
});

describe("version faces (MCP)", () => {
  it("a member keeps the face on list_versions and get_artifact", async () => {
    const { token } = await createPat(env, memberV.userId, "vf");
    const client = await connect(token);
    clients.push(client);
    const r = await tool(client, "list_versions", { id });
    expect(r.isError, textOf(r)).toBeFalsy();
    const items = (r.structuredContent as { items: VersionInfo[] }).items;
    expect(byV(items, 3)?.agent?.animal).toBeDefined();
    const g = await tool(client, "get_artifact", { id, version: 3 });
    expect(JSON.stringify(g.structuredContent)).toContain("animal");
  });

  it("a client restricted after it connected gets none", async () => {
    const u = await mk("vf-late");
    const { token } = await createPat(env, u.userId, "late");
    const client = await connect(token);
    clients.push(client);
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(u.userId)
      .run();
    // Refused outright (canConnect on each request), or served with no face.
    const r = await tool(client, "list_versions", { id }).catch(
      (e: unknown) => e,
    );
    if (r instanceof Error) {
      expect(r.message).toContain("Only members can connect agents");
      return;
    }
    const ok = r as Awaited<ReturnType<typeof tool>>;
    expect(JSON.stringify(ok.structuredContent)).not.toContain("animal");
    expect(JSON.stringify(ok.structuredContent)).not.toContain("id-run-0001");
  });
});
