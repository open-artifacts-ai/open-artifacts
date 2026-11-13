import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { type Member, newId, R, type VersionInfo } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { listVersions, publish } from "../src/services/artifacts.js";
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
  for (const n of [2, 3, 4]) {
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
  // v4: a token (t:) publish, so its label is masked to others, with an identity.
  await set(
    4,
    "t:token000000000001",
    JSON.stringify({
      identityId: "id-run-0002",
      namespace: "ns",
      name: "Secret label",
      kind: "codex",
    }),
  );
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

  it("an unlinked publish reads linked false with no animal; a person has no agent", async () => {
    for (const u of [owner, memberV]) {
      const l = await rest(u);
      expect(byV(l, 1)?.agent).toBeNull();
      const a = byV(l, 2)?.agent;
      expect(a?.linked).toBe(false);
      expect(a).not.toHaveProperty("animal");
      expect(a).not.toHaveProperty("product");
    }
  });

  it.each([
    ["logged out", () => null],
    ["guest role", () => guestV],
    ["restricted", () => restrictedV],
  ])("%s: no linked, product or animal; id never leaves", async (_n, who) => {
    const l = await rest(who());
    expect(byV(l, 3)?.agent).toBeTruthy();
    for (const v of l)
      for (const k of FACE) expect(v.agent ?? {}).not.toHaveProperty(k);
    expect(JSON.stringify(l)).not.toContain("animal");
    expect(JSON.stringify(l)).not.toContain("id-run-0001");
    // The masked v4 stays masked and gets no face either.
    const m = byV(l, 4)?.agent;
    expect(m?.masked).toBe(true);
    for (const k of FACE) expect(m ?? {}).not.toHaveProperty(k);
  });

  it("a guest cap and a restricted cap on a member row get none (service)", async () => {
    for (const [role, cap] of [
      ["guest", "guest"],
      ["member", "restricted"],
      ["guest", null],
    ] as const) {
      const u = await mk(`vf-svc-${role}-${cap}`, role);
      const caller = { kind: "user" as const, user: u.member, cap };
      const l = await listVersions(E, caller, id);
      expect(l.length).toBeGreaterThan(0);
      expect(JSON.stringify(l)).not.toContain("animal");
      expect(JSON.stringify(l)).not.toContain("linked");
    }
    // Control: the same service call uncapped keeps the face.
    const l = await listVersions(E, { kind: "user", user: memberV.member }, id);
    expect(byV(l, 3)?.agent?.animal).toBeDefined();
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
    // A capped caller never reaches the tools: canConnect refuses it on each
    // request. The real capped list is covered by the service test above.
    const r = await tool(client, "list_versions", { id }).catch(
      (e: unknown) => e,
    );
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("Only members can connect agents");
  });
});
