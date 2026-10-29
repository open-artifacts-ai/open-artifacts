// A token label is the owner's private note: everyone but the token's owner
// (the version's createdBy) sees "<owner name>'s agent" instead. A grant's
// client name is a product and stays. Every response to a non-owner is
// scanned whole for the label, so a future field can't leak it.
import { env } from "cloudflare:workers";
import { type Member, newId, R, TrashQuerySchema } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { isPrivateAgent, publicName } from "../src/services/agent-display.js";
import { publish, softDelete } from "../src/services/artifacts.js";
import { listTrash } from "../src/services/trash.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";
import { connect, tool } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const LABEL = `label-9q2x private ${tag}`;
const WORD = `zebrafy${tag}`;

type U = {
  cookie: string;
  userId: string;
  email: string;
  pat: string;
  patId: string;
};
let owner: U;
let nameless: U;
let other: U;
let guest: U;
let pubId: string;
let namelessId: string;

async function mk(
  prefix: string,
  role: "member" | "guest",
  displayName?: string,
): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  if (displayName)
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(displayName, l.userId)
      .run();
  const { token: pat, id: patId } =
    role === "member"
      ? await createPat(env, l.userId, `${prefix} ${LABEL}`)
      : { token: "", id: "" };
  return { ...l, email, pat, patId };
}

const json = async (r: Response) => {
  expect(r.status).toBe(200);
  return (await r.json()) as unknown;
};

async function share(id: string, by: U, to: U) {
  const r = await api(app, R.shares(id), by.cookie, {
    method: "PUT",
    body: { email: to.email, role: "viewer" },
  });
  expect(r.status).toBe(200);
}

/** Publishes through `u`'s PAT (REST): attributed to the token label. */
async function patCreate(u: U, title: string): Promise<string> {
  const r = await api(app, R.artifacts, u.pat, {
    method: "POST",
    body: {
      title,
      format: "html",
      content: `<p>${WORD}</p>`,
      visibility: "public",
    },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

/** Every REST read a viewer can make that carries agent attribution. */
async function restReads(id: string, auth: string | null) {
  const out: Record<string, unknown> = {
    artifact: await json(await api(app, R.artifact(id), auth)),
    versions: await json(await api(app, R.versions(id), auth)),
  };
  if (auth !== null) {
    out.list = await json(await api(app, `${R.artifacts}?limit=100`, auth));
    out.search = await json(
      await api(app, `${R.search}?q=${encodeURIComponent(WORD)}`, auth),
    );
  }
  return out;
}

beforeAll(async () => {
  owner = await mk("lbl-owner", "member", "Olive Owner");
  nameless = await mk("lbl-nameless", "member");
  other = await mk("lbl-other", "member", "Otto Other");
  guest = await mk("lbl-guest", "guest", "Gail Guest");
  pubId = await patCreate(owner, "label privacy");
  await share(pubId, owner, other);
  await share(pubId, owner, guest);
  await runIndex(pubId);
  namelessId = await patCreate(nameless, "nameless");
  await share(namelessId, nameless, other);
  await runIndex(namelessId);
});

describe("helpers", () => {
  it("publicName: cleaned, then null when it is the email (any case)", () => {
    expect(publicName({ name: " Ann ​", email: "a@x.com" })).toBe("Ann");
    expect(publicName({ name: "A@X.com ", email: "a@x.com" })).toBeNull();
    expect(publicName({ name: "a@x.com​", email: "a@x.com" })).toBeNull();
    expect(publicName({ name: "  ", email: "a@x.com" })).toBeNull();
    expect(publicName({ name: null, email: "a@x.com" })).toBeNull();
  });

  it("isPrivateAgent: tokens and rows with no via (before 0012) yes, grants no", () => {
    expect(isPrivateAgent("t:abc")).toBe(true);
    expect(isPrivateAgent("g:abc")).toBe(false);
    // Before 0012 a name could be a token label: always private.
    expect(isPrivateAgent(null)).toBe(true);
  });
});

describe("a PAT publish: REST", () => {
  it("the owner sees the label in lastAgent and versions", async () => {
    const r = (await restReads(pubId, owner.cookie)) as {
      artifact: { lastAgent: { name: string } };
      versions: { agent: { name: string } }[];
      list: { items: { id: string; lastAgent: { name: string } }[] };
      search: { items: { id: string; lastAgent: { name: string } }[] };
    };
    const name = `lbl-owner ${LABEL}`;
    // The owner's copy is the real name: no `masked`.
    expect(r.artifact.lastAgent).toEqual({ name, version: null });
    expect(r.versions[0]?.agent).toEqual({ name, version: null });
    expect(r.list.items.find((i) => i.id === pubId)?.lastAgent.name).toBe(name);
    expect(r.search.items.find((i) => i.id === pubId)?.lastAgent.name).toBe(
      name,
    );
  });

  it('another member and a guest see "<owner>\'s agent"; no response carries the label', async () => {
    for (const u of [other, guest]) {
      const r = (await restReads(pubId, u.cookie)) as {
        artifact: { lastAgent: { name: string } };
        versions: { agent: { name: string } }[];
        list: { items: { id: string; lastAgent: { name: string } }[] };
        search: { items: { id: string; lastAgent: { name: string } }[] };
      };
      const want = {
        name: "Olive Owner's agent",
        version: null,
        masked: true,
      };
      expect(r.artifact.lastAgent).toEqual(want);
      expect(r.versions[0]?.agent).toEqual(want);
      expect(r.list.items.find((i) => i.id === pubId)?.lastAgent).toEqual(want);
      expect(r.search.items.find((i) => i.id === pubId)?.lastAgent).toEqual(
        want,
      );
      expect(JSON.stringify(r)).not.toContain("9q2x");
    }
  });

  it("anonymous readers of the public link never get the label", async () => {
    const r = await restReads(pubId, null);
    expect(JSON.stringify(r)).not.toContain("9q2x");
    expect((r.versions as { agent: { name: string } }[])[0]?.agent.name).toBe(
      "Olive Owner's agent",
    );
  });

  it("the agent filter matches the label only for the owner", async () => {
    const q = `${R.artifacts}?agent=${encodeURIComponent(`lbl-owner ${LABEL}`)}`;
    const mine = (await json(await api(app, q, owner.cookie))) as {
      items: { id: string }[];
    };
    expect(mine.items.map((i) => i.id)).toContain(pubId);
    const theirs = (await json(await api(app, q, other.cookie))) as {
      items: { id: string }[];
    };
    expect(theirs.items.map((i) => i.id)).not.toContain(pubId);
  });

  it("agentVia (#589) matches only the token's owner; no response to anyone else carries the label", async () => {
    const via = `agentVia=${encodeURIComponent(`t:${owner.patId}`)}`;
    const ids = (r: unknown) =>
      (r as { items: { id: string }[] }).items.map((i) => i.id);
    const mine = await json(
      await api(app, `${R.artifacts}?${via}`, owner.cookie),
    );
    expect(ids(mine)).toEqual([pubId]);
    const found = await json(
      await api(
        app,
        `${R.search}?q=${encodeURIComponent(WORD)}&${via}`,
        owner.cookie,
      ),
    );
    expect(ids(found)).toEqual([pubId]);
    // other and guest can see pubId, but not through the owner's token.
    for (const u of [other, guest]) {
      const r = {
        list: await json(await api(app, `${R.artifacts}?${via}`, u.cookie)),
        search: await json(
          await api(
            app,
            `${R.search}?q=${encodeURIComponent(WORD)}&${via}`,
            u.cookie,
          ),
        ),
      };
      expect(ids(r.list)).toEqual([]);
      expect(ids(r.search)).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("9q2x");
    }
    const c = await connect(other.pat);
    const results = [
      await tool(c, "list_artifacts", { agentVia: `t:${owner.patId}` }),
      await tool(c, "search_artifacts", {
        q: WORD,
        agentVia: `t:${owner.patId}`,
      }),
    ];
    await c.close();
    for (const r of results) {
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as { items: unknown[] }).items).toEqual([]);
    }
    expect(JSON.stringify(results)).not.toContain("9q2x");
  });

  it('an owner with no real name: "Member\'s agent", and no email in it', async () => {
    const r = (await restReads(namelessId, other.cookie)) as {
      artifact: { lastAgent: { name: string } };
      versions: { agent: { name: string } }[];
    };
    expect(r.artifact.lastAgent.name).toBe("Member's agent");
    expect(r.versions[0]?.agent.name).toBe("Member's agent");
    expect(JSON.stringify(r)).not.toContain("9q2x");
    const anon = await restReads(namelessId, null);
    expect(JSON.stringify(anon)).not.toContain("9q2x");
    expect(JSON.stringify(anon)).not.toContain(nameless.email);
  });

  it("a version from before 0012 (no agent_via) is private, even with a version", async () => {
    await env.DB.prepare(
      "update versions set agent_via = null, agent_version = '1.0' where artifact_id = ?",
    )
      .bind(pubId)
      .run();
    await env.DB.prepare(
      "update artifacts set last_agent_version = '1.0' where id = ?",
    )
      .bind(pubId)
      .run();
    const r = (await restReads(pubId, other.cookie)) as {
      artifact: { lastAgent: unknown };
      versions: { agent: unknown }[];
    };
    expect(JSON.stringify(r)).not.toContain("9q2x");
    const want = { name: "Olive Owner's agent", version: "1.0", masked: true };
    expect(r.artifact.lastAgent).toEqual(want);
    expect(r.versions[0]?.agent).toEqual(want);
    const o = (await restReads(pubId, owner.cookie)) as {
      versions: { agent: { name: string } }[];
    };
    expect(o.versions[0]?.agent.name).toBe(`lbl-owner ${LABEL}`);
  });
});

describe("a PAT publish: MCP from another user's agent", () => {
  let client: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    client = await connect(other.pat);
  });
  afterAll(() => client.close());

  it("get_artifact, list_versions, list and search carry no label", async () => {
    const results = [
      await tool(client, "get_artifact", { id: pubId }),
      await tool(client, "list_versions", { id: pubId }),
      await tool(client, "list_artifacts", { limit: 100 }),
      await tool(client, "search_artifacts", { q: WORD }),
    ];
    for (const r of results) expect(r.isError).toBeFalsy();
    expect(JSON.stringify(results)).not.toContain("9q2x");
    const got = results[0]?.structuredContent as {
      artifact: { lastAgent: unknown };
      version: { agent: unknown };
    };
    expect(got.artifact.lastAgent).toMatchObject({
      name: "Olive Owner's agent",
      masked: true,
    });
    expect(got.version.agent).toMatchObject({
      name: "Olive Owner's agent",
      masked: true,
    });
  });

  it("the owner's own agent still sees the label", async () => {
    const c = await connect(owner.pat);
    const r = await tool(c, "list_versions", { id: pubId });
    expect(JSON.stringify(r)).toContain("9q2x");
    await c.close();
  });
});

describe("a grant publish", () => {
  it("shows the client name to everyone", async () => {
    const m = await getUser(env, owner.userId);
    if (!m) throw new Error("no user");
    const { id } = await publish(
      env,
      m,
      {
        title: "grant",
        format: "html",
        content: "<p>g</p>",
        visibility: "public",
      } as never,
      {
        name: "Claude Code",
        version: "2.1",
        via: { kind: "grant", id: newId() },
      },
      undefined,
      "create",
    );
    const want = { name: "Claude Code", version: "2.1" };
    for (const auth of [owner.cookie, other.cookie, null]) {
      const r = (await restReads(id, auth)) as {
        artifact: { lastAgent: unknown };
        versions: { agent: unknown }[];
      };
      expect(r.artifact.lastAgent).toEqual(want);
      expect(r.versions[0]?.agent).toEqual(want);
    }
  });
});

describe("trash", () => {
  it("a space manager who isn't the publisher sees the label masked", async () => {
    const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;
    const spaceId = newId();
    const run = (q: string, ...b: unknown[]) =>
      env.DB.prepare(q)
        .bind(...b)
        .run();
    await run(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, 1)",
      spaceId,
      `Lbl ${tag}`,
    );
    for (const [u, role] of [
      [other, "manager"],
      [owner, "editor"],
    ] as const)
      await run(
        "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', 1)",
        spaceId,
        u.userId,
        role,
      );
    const pubM = (await getUser(SPACES, owner.userId)) as Member;
    const mgr = (await getUser(SPACES, other.userId)) as Member;
    const { id } = await publish(
      SPACES,
      pubM,
      { title: "tr", format: "html", content: "<p>t</p>", spaceId } as never,
      {
        name: `lbl-owner ${LABEL}`,
        version: null,
        via: { kind: "token", id: newId() },
      },
    );
    await softDelete(SPACES, mgr, id);
    const page = await listTrash(
      SPACES,
      callerOf(mgr),
      TrashQuerySchema.parse({ spaceId }),
    );
    const item = page.items.find((i) => i.id === id);
    expect(item?.lastAgent).toEqual({
      name: "Olive Owner's agent",
      version: null,
      masked: true,
    });
    expect(JSON.stringify(page)).not.toContain("9q2x");
  });
});
