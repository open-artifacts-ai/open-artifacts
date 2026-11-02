// A token label stays its publisher's, past the publisher's removal and past a
// read that races a publish. Removal is soft on every install: the row stays,
// created_by stays true and nothing is scrubbed. Before that (#829) a hard
// delete moved created_by to the instance owner and overwrote the label with
// the stand-in (agent_via "r:"). Those rows stay that way forever: nobody reads
// the label, nobody is credited with the version, and no filter finds it.
import { env } from "cloudflare:workers";
import {
  ArtifactSummarySchema,
  type Member,
  newId,
  PageSchema,
  R,
  TransferInputSchema,
  TrashQuerySchema,
  VersionInfoSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { callerOf, withCap } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import {
  agentFor,
  MEMBERS_AGENT,
  ownersAgent,
  publicName,
  SCRUBBED_VIA,
} from "../src/services/agent-display.js";
import {
  getSummary,
  publish,
  shownLastAgent,
  softDelete,
} from "../src/services/artifacts.js";
import { removeMember, restoreMember } from "../src/services/members.js";
import { transferPersonal } from "../src/services/spaces.js";
import { listTrash } from "../src/services/trash.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

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
  // First, so it is the owner a scrubbed row names as created_by.
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
  content = `<p>${newId()}</p>`,
): Promise<string> {
  const r = await publish(
    env,
    await member(u),
    {
      ...(id ? { id } : {}),
      title: `scrub ${tag}`,
      format: "html",
      content,
      ...(id ? {} : { visibility: "public" }),
    } as never,
    { ...agent, version: "1" },
    undefined,
    id ? "version" : "create",
  );
  return r.id;
}
async function share(id: string, by: U, to: U, role: "viewer" | "editor") {
  const r = await api(app, R.shares(id), by.cookie, {
    method: "PUT",
    body: { email: to.email, role },
  });
  expect(r.status).toBe(200);
}
async function member(u: U): Promise<Member> {
  const m = await getUser(env, u.userId);
  if (!m) throw new Error("no user");
  return m;
}
const trashed = async (id: string, u: U) =>
  (
    await listTrash(env, callerOf(await member(u)), TrashQuerySchema.parse({}))
  ).items.find((i) => i.id === id);
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

/**
 * What the hard delete (gone since #829) left behind for publisher `u`: their
 * private labels overwritten and marked "r:", then their artifacts and
 * versions reassigned to the instance owner. Nothing writes this any more, but
 * rows scrubbed before #829 stay like this forever.
 */
async function scrub(u: U) {
  const by = u.userId;
  const to = instance.userId;
  const priv = "(agent_via is null or agent_via not like 'g:%')";
  await env.DB.batch([
    env.DB.prepare(
      `update artifacts set last_agent_name = ? where exists (
         select 1 from versions where artifact_id = artifacts.id
           and version = artifacts.current_version and created_by = ?
           and agent_name is not null and ${priv})`,
    ).bind(MEMBERS_AGENT, by),
    env.DB.prepare(
      `update versions set agent_name = ?, agent_via = ?
         where created_by = ? and agent_name is not null and ${priv}`,
    ).bind(MEMBERS_AGENT, SCRUBBED_VIA, by),
    env.DB.prepare(
      `update artifacts set owner_id = ?,
         space_id = case when space_id = ? then ? else space_id end
         where owner_id = ?`,
    ).bind(to, by, to, by),
    env.DB.prepare(
      "update versions set created_by = ? where created_by = ?",
    ).bind(to, by),
  ]);
}

describe("a scrubbed row (agent_via r:) reads as the stand-in forever", () => {
  it("nobody reads it, and the instance owner isn't named as the agent's owner", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await scrub(bob);
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
    expect(await lastAgentCol(id)).toBe(MEMBERS_AGENT);
  });

  it("no filter finds it, the instance owner included", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await share(id, bob, carol, "viewer");
    await share(id, bob, admin, "viewer");
    expect(await listed(agentQuery(LABEL), bob.cookie)).toContain(id);
    await scrub(bob);
    for (const auth of [instance.cookie, admin.cookie, carol.cookie]) {
      expect(await listed("", auth)).toContain(id);
      expect(await listed(agentQuery(MEMBERS_AGENT), auth)).not.toContain(id);
      expect(await listed(agentQuery(LABEL), auth)).not.toContain(id);
    }
  });

  it("beside a later publisher's label, each version reads as its own", async () => {
    const bob = await mk("member", "Bob Builder");
    const dana = await mk("member", "Dana Doer");
    const id = await pub(bob, token());
    await share(id, bob, dana, "editor");
    const danas = `dana ${LABEL}`;
    await pub(dana, token(danas), id);
    await scrub(bob);
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

  it("on another owner's artifact: lastAgent is the stand-in, the owner's own version isn't", async () => {
    const olive = await mk("member", "Olive Owner");
    const bob = await mk("member", "Bob Builder");
    const olives = `olive ${LABEL}`;
    const id = await pub(olive, token(olives));
    await share(id, olive, bob, "editor");
    await pub(bob, token(), id);
    await scrub(bob);
    expect(await lastAgentCol(id)).toBe(MEMBERS_AGENT);
    expect(await row(id, 1)).toMatchObject({
      agent_name: olives,
      created_by: olive.userId,
    });
    expect((await row(id, 2))?.agent_via).toBe(SCRUBBED_VIA);
    const shown = await reads(id, olive.cookie);
    expect(shown.artifact.lastAgent).toEqual(SCRUBBED);
    expect(shown.versions.map((v) => v.agent)).toEqual([
      SCRUBBED,
      { name: olives, version: "1" },
    ]);
  });

  it("in the trash: it reads as the stand-in there", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await softDelete(env, await member(bob), id);
    await scrub(bob);
    expect(await lastAgentCol(id)).toBe(MEMBERS_AGENT);
    expect((await trashed(id, instance))?.lastAgent).toEqual(SCRUBBED);
  });

  it("reads the same through list, search and trash", async () => {
    const bob = await mk("member", "Bob Builder");
    const word = `scrubword${tag}`;
    const id = await pub(bob, token(), undefined, `<p>${word}</p>`);
    await runIndex(id);
    await share(id, bob, carol, "viewer");
    await scrub(bob);

    const list = (await (
      await api(app, `${R.artifacts}?limit=100`, carol.cookie)
    ).json()) as { items: { id: string; lastAgent: unknown }[] };
    expect(list.items.find((x) => x.id === id)?.lastAgent).toEqual(SCRUBBED);

    const found = (await (
      await api(app, `${R.search}?q=${word}`, carol.cookie)
    ).json()) as { items: { id: string; lastAgent: unknown }[] };
    expect(found.items.find((x) => x.id === id)?.lastAgent).toEqual(SCRUBBED);

    await softDelete(env, await member(instance), id);
    expect((await trashed(id, instance))?.lastAgent).toEqual(SCRUBBED);
  });
});

describe.each([
  ["spaces off", env as Env],
  ["spaces on", SPACES],
])("removal, %s: nothing is scrubbed", (_, e) => {
  /** Every column of the version row: none of them may move. */
  const whole = (id: string) =>
    env.DB.prepare("select * from versions where artifact_id = ?")
      .bind(id)
      .all()
      .then((r) => r.results);

  it("created_by stays true and the stand-in names the publisher", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await removeMember(e, bob.userId, adminActor, ctx);
    expect(await row(id, 1)).toMatchObject({
      agent_name: LABEL,
      created_by: bob.userId,
    });
    expect((await row(id, 1))?.agent_via).toMatch(/^t:/);
    const shown = await reads(id, instance.cookie);
    expect(JSON.stringify(shown)).not.toContain("7k3w");
    expect(shown.artifact.lastAgent).toEqual({
      name: "Bob Builder's agent",
      version: "1",
      masked: true,
    });
  });

  it("removal, transfer and restore never write a version row", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    const before = await whole(id);
    expect(before).toHaveLength(1);

    await removeMember(e, bob.userId, adminActor, ctx);
    expect(await whole(id)).toEqual(before);

    const moved = await transferPersonal(
      e,
      adminActor,
      bob.userId,
      TransferInputSchema.parse({
        to: { kind: "user", userId: admin.userId },
      }),
      ctx,
    );
    expect(moved.moved).toBe(1);
    expect(await whole(id)).toEqual(before);
    // The new owner never reads the label as theirs: the publisher is still
    // the one who published.
    const shown = await reads(id, admin.cookie);
    expect(JSON.stringify(shown)).not.toContain("7k3w");
    expect(shown.artifact.lastAgent).toEqual({
      name: "Bob Builder's agent",
      version: "1",
      masked: true,
    });

    await restoreMember(e, bob.userId, adminActor, ctx);
    expect(await whole(id)).toEqual(before);
    // The token is theirs again, so the label is too.
    const mine = await getSummary(e, callerOf(await member(bob)), id);
    expect(mine.lastAgent).toEqual({ name: LABEL, version: "1" });
  });

  it("a row with no via (before 0012) stays private and stays as it was", async () => {
    const bob = await mk("member", "Bob Builder");
    const id = await pub(bob, token());
    await env.DB.prepare(
      "update versions set agent_via = null where artifact_id = ?",
    )
      .bind(id)
      .run();
    await removeMember(e, bob.userId, adminActor, ctx);
    expect(JSON.stringify(await reads(id, instance.cookie))).not.toContain(
      "7k3w",
    );
    expect((await row(id, 1))?.agent_via).toBeNull();
  });

  it("a grant's client name is a product and stays", async () => {
    const bob = await mk("member", "Bob Builder");
    const via = { kind: "grant" as const, id: newId() };
    const id = await pub(bob, { name: "Claude Code", via });
    await removeMember(e, bob.userId, adminActor, ctx);
    const r = await reads(id, carol.cookie);
    expect(r.artifact.lastAgent).toEqual({ name: "Claude Code", version: "1" });
    expect((await row(id, 1))?.agent_via).toBe(`g:${via.id}`);
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
    expect(publicName({ name })).toBeNull();
    expect(ownersAgent({ name, email })).toBe(MEMBERS_AGENT);
  });

  it("a real name past the cut is cut, not refused", () => {
    expect(publicName({ name: "n".repeat(90) })).toBe("n".repeat(80));
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
    await share(id, olive, ed, "editor");
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
