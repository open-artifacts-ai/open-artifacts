// A token label stays its publisher's, past the publisher's removal and past a
// read that races a publish. Without spaces, deleteMember moves created_by to
// the instance owner, so the label is overwritten with the stand-in first
// (agent_via "r:"): nobody reads it, nobody is credited with the version, and
// no filter finds it. With spaces the row stays and created_by stays true.
import { env } from "cloudflare:workers";
import {
  ArtifactSummarySchema,
  type Member,
  newId,
  PageSchema,
  R,
  VersionInfoSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { withCap } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import {
  agentFor,
  MEMBERS_AGENT,
  ownersAgent,
  publicName,
  SCRUBBED_VIA,
} from "../src/services/agent-display.js";
import { publish, shownLastAgent } from "../src/services/artifacts.js";
import { removeMember } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;
const tag = newId().slice(0, 6).toLowerCase();
const LABEL = `label-7k3w private ${tag}`;
const SCRUBBED = { name: MEMBERS_AGENT, version: "1", masked: true };

type U = { cookie: string; userId: string; email: string };
let n = 0;
async function mk(
  role: "member" | "admin" | "owner",
  displayName?: string,
): Promise<U> {
  const email = `scrub-${n++}-${tag}@x.com`;
  const l = await login(email, role);
  if (displayName)
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(displayName, l.userId)
      .run();
  return { ...l, email };
}

let instance: U;
let admin: U;
let carol: U;
let adminActor: Member;

beforeAll(async () => {
  // First, so it is the owner a spaces-off removal reassigns to.
  instance = await mk("owner", "Ivy Instance");
  admin = await mk("admin", "Ada Admin");
  carol = await mk("member", "Carol Colleague");
  adminActor = withCap({ id: admin.userId, role: "admin" } as Member, null);
});

/** A version of artifact `id` (a new one when undefined), attributed as asked. */
async function pub(
  u: U,
  agent: { name: string; via: { kind: "token" | "grant"; id: string } },
  id?: string,
  e: Env = env,
): Promise<string> {
  const m = await getUser(env, u.userId);
  if (!m) throw new Error("no user");
  const r = await publish(
    e,
    m,
    {
      ...(id ? { id } : {}),
      title: `scrub ${tag}`,
      format: "html",
      content: `<p>${newId()}</p>`,
      ...(id ? {} : { visibility: "public" }),
    } as never,
    { ...agent, version: "1" },
    undefined,
    id ? "version" : "create",
  );
  return r.id;
}
async function makeEditor(id: string, by: U, to: U) {
  const r = await api(app, R.shares(id), by.cookie, {
    method: "PUT",
    body: { email: to.email, role: "editor" },
  });
  expect(r.status).toBe(200);
}
const token = (name = LABEL) => ({
  name,
  via: { kind: "token" as const, id: newId() },
});

async function reads(id: string, auth: string | null) {
  const artifact = (await (await api(app, R.artifact(id), auth)).json()) as {
    lastAgent: unknown;
  };
  const versions = (await (await api(app, R.versions(id), auth)).json()) as {
    version: number;
    agent: unknown;
  }[];
  return { artifact, versions };
}
const row = (id: string, version: number) =>
  env.DB.prepare(
    "select agent_name, agent_via, created_by from versions where artifact_id = ? and version = ?",
  )
    .bind(id, version)
    .first<{
      agent_name: string;
      agent_via: string | null;
      created_by: string;
    }>();
const lastAgentCol = async (id: string) =>
  (
    await env.DB.prepare("select last_agent_name n from artifacts where id = ?")
      .bind(id)
      .first<{ n: string | null }>()
  )?.n;
const listed = async (query: string, auth: string) => {
  const r = await api(app, `${R.artifacts}?limit=100&${query}`, auth);
  expect(r.status).toBe(200);
  return ((await r.json()) as { items: { id: string }[] }).items.map(
    (x) => x.id,
  );
};
const agentQuery = (name: string) => `agent=${encodeURIComponent(name)}`;

describe("removal, spaces off: the label is scrubbed", () => {
  it("nobody reads it and nobody is credited with the version", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await removeMember(env, bob.userId, adminActor, ctx);
    for (const auth of [instance.cookie, admin.cookie, carol.cookie, null]) {
      const r = await reads(id, auth);
      const text = JSON.stringify(r);
      expect(text).not.toContain("7k3w");
      expect(text).not.toContain("Ivy Instance's agent");
      expect(r.artifact.lastAgent).toEqual(SCRUBBED);
      expect(r.versions[0]?.agent).toEqual(SCRUBBED);
    }
    expect(await row(id, 1)).toEqual({
      agent_name: MEMBERS_AGENT,
      agent_via: SCRUBBED_VIA,
      created_by: instance.userId,
    });
  });

  it("a row with no via (before 0012) is private, so it is scrubbed too", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await env.DB.prepare(
      "update versions set agent_via = null where artifact_id = ?",
    )
      .bind(id)
      .run();
    await removeMember(env, bob.userId, adminActor, ctx);
    expect(JSON.stringify(await reads(id, instance.cookie))).not.toContain(
      "7k3w",
    );
    expect((await row(id, 1))?.agent_via).toBe(SCRUBBED_VIA);
  });

  it("a grant's client name is a product and stays", async () => {
    const bob = await mk("member", "Bob Builder");
    const via = { kind: "grant" as const, id: newId() };
    const id = await pub(bob, { name: "Claude Code", via });
    await removeMember(env, bob.userId, adminActor, ctx);
    const r = await reads(id, carol.cookie);
    expect(r.artifact.lastAgent).toEqual({ name: "Claude Code", version: "1" });
    expect((await row(id, 1))?.agent_via).toBe(`g:${via.id}`);
  });

  it("a session publish has no agent, so nothing is scrubbed", async () => {
    const bob = await mk("member", "Bob Builder");
    const m = await getUser(env, bob.userId);
    if (!m) throw new Error("no user");
    const { id } = await publish(
      env,
      m,
      { title: "s", format: "html", content: "<p>s</p>" } as never,
      null,
      undefined,
      "create",
    );
    await removeMember(env, bob.userId, adminActor, ctx);
    expect(await row(id, 1)).toMatchObject({
      agent_name: null,
      agent_via: null,
    });
    expect(await lastAgentCol(id)).toBeNull();
  });

  it("no filter finds it, the instance owner included", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    expect(await listed(agentQuery(LABEL), bob.cookie)).toContain(id);
    await removeMember(env, bob.userId, adminActor, ctx);
    for (const auth of [instance.cookie, admin.cookie, carol.cookie]) {
      expect(await listed(agentQuery(MEMBERS_AGENT), auth)).not.toContain(id);
      expect(await listed(agentQuery(LABEL), auth)).not.toContain(id);
    }
  });

  it("lastAgent keeps a later publisher's label; only the removed member's version changes", async () => {
    const bob = await mk("member", "Bob Builder");
    const dana = await mk("member", "Dana Doer");
    const id = await pub(bob, token());
    await makeEditor(id, bob, dana);
    const danas = `dana ${LABEL}`;
    await pub(dana, token(danas), id);
    await removeMember(env, bob.userId, adminActor, ctx);
    expect(await lastAgentCol(id)).toBe(danas);
    expect((await row(id, 1))?.agent_via).toBe(SCRUBBED_VIA);
    expect((await row(id, 2))?.agent_name).toBe(danas);
    expect((await reads(id, dana.cookie)).artifact.lastAgent).toEqual({
      name: danas,
      version: "1",
    });
    const shown = await reads(id, instance.cookie);
    expect(shown.artifact.lastAgent).toEqual({
      name: "Dana Doer's agent",
      version: "1",
      masked: true,
    });
    expect(shown.versions.map((v) => v.agent)).toEqual([
      { name: "Dana Doer's agent", version: "1", masked: true },
      SCRUBBED,
    ]);
  });

  it("a removal refused at the batch scrubs nothing", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    // Promoted between the precheck and the batch: `target` refuses every write.
    let raced = false;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        if (k !== "batch") return v.bind(t);
        return async (s: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await t
              .prepare("update users set role = 'admin' where id = ?")
              .bind(bob.userId)
              .run();
          }
          return t.batch(s);
        };
      },
    });
    await expect(
      removeMember({ ...env, DB } as Env, bob.userId, adminActor, ctx),
    ).rejects.toMatchObject({ code: "owner_only" });
    expect(await row(id, 1)).toMatchObject({
      agent_name: LABEL,
      created_by: bob.userId,
    });
    expect(await lastAgentCol(id)).toBe(LABEL);
  });
});

describe("removal, spaces on: the row stays, so nothing is scrubbed", () => {
  it("created_by stays true and the stand-in names the publisher", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await removeMember(SPACES, bob.userId, adminActor, ctx);
    expect(await row(id, 1)).toMatchObject({
      agent_name: LABEL,
      created_by: bob.userId,
    });
    const shown = await reads(id, instance.cookie);
    expect(JSON.stringify(shown)).not.toContain("7k3w");
    expect(shown.artifact.lastAgent).toEqual({
      name: "Bob Builder's agent",
      version: "1",
      masked: true,
    });
  });
});

describe("agentFor", () => {
  const publisher = { id: "p", name: "Ivy", email: "ivy@x.com" };
  const scrubbed = { name: MEMBERS_AGENT, version: null };
  it("a scrubbed row reads the same for everyone, createdBy included", () => {
    for (const viewer of ["p", "other", null])
      expect(agentFor(scrubbed, SCRUBBED_VIA, publisher, viewer)).toEqual({
        ...scrubbed,
        masked: true,
      });
  });
  it("a token row: its publisher sees the label, others the stand-in", () => {
    const a = { name: LABEL, version: null };
    expect(agentFor(a, "t:x", publisher, "p")).toEqual(a);
    expect(agentFor(a, "t:x", publisher, "other")).toEqual({
      name: "Ivy's agent",
      version: null,
      masked: true,
    });
  });
});

describe("lastAgent comes from one version row", () => {
  // A read that races a publish sees the artifacts row from before it and the
  // version row from after it, or the reverse. Stale columns stand in for that.
  it("a stale private label with a newer grant row: the label never shows", async () => {
    const bob = await mk("member", "Bob Builder");
    const via = { kind: "grant" as const, id: newId() };
    const id = await pub(bob, { name: "Claude Code", via });
    await env.DB.prepare(
      "update artifacts set last_agent_name = ? where id = ?",
    )
      .bind(LABEL, id)
      .run();
    const r = await reads(id, carol.cookie);
    expect(r.artifact.lastAgent).toEqual({ name: "Claude Code", version: "1" });
  });

  it("a stale grant name with a newer private row: masked, not the column's name", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await env.DB.prepare(
      "update artifacts set last_agent_name = ? where id = ?",
    )
      .bind("Claude Code", id)
      .run();
    expect((await reads(id, carol.cookie)).artifact.lastAgent).toEqual({
      name: "Bob Builder's agent",
      version: "1",
      masked: true,
    });
    expect((await reads(id, bob.cookie)).artifact.lastAgent).toEqual({
      name: LABEL,
      version: "1",
    });
  });

  it("a version row with no agent, or no row: no lastAgent", () => {
    const caller = { kind: "anonymous" } as never;
    expect(shownLastAgent(null, caller)).toBeNull();
    const row = JSON.stringify(["t:x", "u", "e@x.com", "n", null, null, null]);
    expect(shownLastAgent(row, caller)).toBeNull();
  });
});

describe("publicName never carries an email", () => {
  const email = `${"a".repeat(90)}@x.com`;
  it.each([
    ["an email past the 80-point cut", email],
    ["the same, in another case", email.toUpperCase()],
    ["another address", "someone.else@example.org"],
    ["an address inside a name", "Priya priya@example.org"],
  ])("%s is no name", (_, name) => {
    expect(publicName({ name, email })).toBeNull();
    expect(ownersAgent({ name, email })).toBe(MEMBERS_AGENT);
  });

  it("a real name past the cut is cut, not refused", () => {
    expect(publicName({ name: "n".repeat(90), email })).toBe("n".repeat(80));
  });

  it("anonymous readers of a public link get the fallback, not the address", async () => {
    // effectiveName: a member with no real name is named by their own email.
    const long = `${"b".repeat(90)}-${tag}@x.com`;
    const bob = { ...(await login(long)), email: long };
    await env.DB.prepare("update users set name = ? where id = ?")
      .bind(long, bob.userId)
      .run();
    const id = await pub(bob, token());
    const r = await reads(id, null);
    const fallback = { name: MEMBERS_AGENT, version: "1", masked: true };
    expect(r.artifact.lastAgent).toEqual(fallback);
    expect(r.versions[0]?.agent).toEqual(fallback);
  });
});

describe("who counts as the token's owner", () => {
  it("an artifact's owner who didn't publish sees the stand-in", async () => {
    const olive = await mk("member", "Olive Owner");
    const ed = await mk("member", "Ed Editor");
    const id = await pub(olive, token(`olive ${LABEL}`));
    await makeEditor(id, olive, ed);
    await pub(ed, token(), id);
    const shown = await reads(id, olive.cookie);
    expect(shown.artifact.lastAgent).toEqual({
      name: "Ed Editor's agent",
      version: "1",
      masked: true,
    });
    expect((await reads(id, ed.cookie)).artifact.lastAgent).toEqual({
      name: LABEL,
      version: "1",
    });
  });

  it.each([
    ["an admin", () => admin],
    ["the instance owner", () => instance],
  ])("%s sees the stand-in", async (_, who) => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    const shown = await reads(id, who().cookie);
    expect(JSON.stringify(shown)).not.toContain("7k3w");
    expect(shown.artifact.lastAgent).toEqual({
      name: "Bob Builder's agent",
      version: "1",
      masked: true,
    });
  });
});

describe("shapes (the byte snapshot publishes as a grant)", () => {
  it("masked and token responses equal their schema's parse, byte for byte", async () => {
    const bob = await mk("member", "Bob Builder");
    const pat = (await createPat(env, bob.userId, LABEL)).token;
    const r = await api(app, R.artifacts, pat, {
      method: "POST",
      body: {
        title: "shape",
        format: "html",
        content: "<p>s</p>",
        visibility: "public",
      },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const get = async (path: string, auth: string) =>
      (await api(app, path, auth)).text();
    for (const [auth, masked] of [
      [carol.cookie, true],
      [bob.cookie, false],
    ] as const) {
      const versions = await get(R.versions(id), auth);
      expect(
        JSON.stringify(z.array(VersionInfoSchema).parse(JSON.parse(versions))),
      ).toBe(versions);
      expect(versions.includes('"masked":true')).toBe(masked);
    }
    const list = await get(`${R.artifacts}?limit=100`, carol.cookie);
    expect(
      JSON.stringify(PageSchema(ArtifactSummarySchema).parse(JSON.parse(list))),
    ).toBe(list);
    expect(list).toContain('"masked":true');
  });
});
