// #1462: a guest sees members' names, never their email addresses. Members
// keep them; anonymous readers never had them. A user always sees their own.
import { env } from "cloudflare:workers";
import {
  ArtifactSummarySchema,
  newId,
  PageSchema,
  R,
  SpaceMembersPageSchema,
  VersionInfoSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { api, fetchAndWait, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const WORD = `quokka${tag}`;
const ON = { ...(env as object), FEATURES: "spaces" } as unknown as Env;

type U = { cookie: string; userId: string; email: string };
const mk = async (
  prefix: string,
  role: "member" | "guest",
  o: { displayName?: string; idpName?: string } = {},
): Promise<U> => {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  if (o.displayName)
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(o.displayName, l.userId)
      .run();
  if (o.idpName)
    await env.DB.prepare("update users set name = ? where id = ?")
      .bind(o.idpName, l.userId)
      .run();
  return { ...l, email };
};

let nameless: U; // no display name: the email is its fallback name
let emailName: U; // users.name holds the full email (#1107's shape)
let named: U;
let member: U;
let guest: U;
let namelessArt: string;
let emailNameArt: string;
let namedArt: string;
let space: string;

const create = async (u: U, title: string, visibility: string) => {
  const r = await api(app, R.artifacts, u.cookie, {
    method: "POST",
    body: {
      title,
      format: "markdown",
      content: `# ${WORD}`,
      visibility,
    },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
};
const shareWith = async (id: string, by: U, to: U) => {
  const r = await api(app, R.shares(id), by.cookie, {
    method: "PUT",
    body: { email: to.email, role: "viewer" },
  });
  expect(r.status).toBe(200);
};
const run = (sql: string, ...b: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...b)
    .run();

beforeAll(async () => {
  nameless = await mk("gn-nameless", "member");
  emailName = await mk("gn-emailname", "member");
  await run(
    "update users set name = ? where id = ?",
    emailName.email,
    emailName.userId,
  );
  named = await mk("gn-named", "member", { displayName: "Olive Owner" });
  member = await mk("gn-member", "member");
  guest = await mk("gn-guest", "guest");

  namelessArt = await create(nameless, "by nameless", "public");
  emailNameArt = await create(emailName, "by emailname", "public");
  namedArt = await create(named, "by named", "public");
  for (const [id, by] of [
    [namelessArt, nameless],
    [emailNameArt, emailName],
    [namedArt, named],
  ] as const) {
    await shareWith(id, by, guest);
    await shareWith(id, by, member);
    await runIndex(id);
  }

  space = newId();
  await run(
    "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 1, 1)",
    space,
    `Names ${tag}`,
  );
  for (const [u, role] of [
    [nameless, "manager"],
    [named, "editor"],
    [guest, "viewer"],
    [member, "viewer"],
  ] as const)
    await run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', 1)",
      space,
      u.userId,
      role,
    );
});

const ids = () => [namelessArt, emailNameArt, namedArt];

/** Every artifact REST read that carries a person (owner, createdBy). */
async function reads(auth: string | null) {
  const out: Record<string, unknown> = {};
  for (const id of ids()) {
    const a = await api(app, R.artifact(id), auth);
    expect(a.status).toBe(200);
    out[`artifact ${id}`] = await a.json();
    const v = await api(app, R.versions(id), auth);
    expect(v.status).toBe(200);
    out[`versions ${id}`] = await v.json();
  }
  if (auth !== null) {
    const l = await api(app, `${R.artifacts}?scope=all&limit=100`, auth);
    expect(l.status).toBe(200);
    out.list = await l.json();
    const s = await api(app, `${R.search}?q=${WORD}`, auth);
    expect(s.status).toBe(200);
    out.search = await s.json();
  }
  return out;
}

const spaceMembers = async (u: U) => {
  const r = await fetchAndWait(
    app,
    new Request(`http://app.localhost${R.spaceMembers(space)}`, {
      headers: { "x-oa-request": "1", cookie: u.cookie },
    }),
    ON,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as unknown;
};

describe("artifact reads", () => {
  it("a guest's responses carry no email address anywhere, with the 'Member' fallback", async () => {
    const all = await reads(guest.cookie);
    // Meaningful only if the surfaces were exercised.
    expect(JSON.stringify(all)).toContain(namelessArt);
    expect(JSON.stringify(all)).toContain("owner");
    expect(JSON.stringify(all)).not.toContain("@");
    const a = ArtifactSummarySchema.parse(all[`artifact ${namelessArt}`]);
    expect(a.owner).toEqual({
      id: nameless.userId,
      email: null,
      name: "Member",
    });
    expect(
      ArtifactSummarySchema.parse(all[`artifact ${emailNameArt}`]).owner,
    ).toEqual({ id: emailName.userId, email: null, name: "Member" });
    expect(
      ArtifactSummarySchema.parse(all[`artifact ${namedArt}`]).owner,
    ).toEqual({ id: named.userId, email: null, name: "Olive Owner" });
    const v = VersionInfoSchema.array().parse(all[`versions ${namelessArt}`]);
    expect(v[0]?.createdBy).toEqual({
      id: nameless.userId,
      email: null,
      name: "Member",
    });
    const l = PageSchema(ArtifactSummarySchema).parse(all.list);
    expect(l.items.map((i) => i.owner.email)).toEqual(l.items.map(() => null));
    const s = PageSchema(ArtifactSummarySchema.passthrough()).parse(all.search);
    expect(s.items.length).toBe(3);
  });

  it("a member still gets owners' emails", async () => {
    const all = await reads(member.cookie);
    expect(
      ArtifactSummarySchema.parse(all[`artifact ${namelessArt}`]).owner,
    ).toEqual({
      id: nameless.userId,
      email: nameless.email,
      name: nameless.email,
    });
    expect(
      VersionInfoSchema.array().parse(all[`versions ${namedArt}`])[0]
        ?.createdBy,
    ).toMatchObject({ email: named.email, name: "Olive Owner" });
    expect(JSON.stringify(all.list)).toContain(named.email);
    expect(JSON.stringify(all.search)).toContain(named.email);
  });

  it("an anonymous reader of a public artifact gets no email", async () => {
    const all = await reads(null);
    expect(
      ArtifactSummarySchema.parse(all[`artifact ${namedArt}`]).owner.email,
    ).toBeNull();
    expect(
      ArtifactSummarySchema.parse(all[`artifact ${namelessArt}`]).owner.email,
    ).toBeNull();
    expect(JSON.stringify(all)).not.toContain(named.email);
    expect(JSON.stringify(all)).not.toContain(nameless.email);
  });
});

describe("space members", () => {
  it("a guest sees names only, except their own email", async () => {
    const page = SpaceMembersPageSchema.parse(await spaceMembers(guest));
    expect(page.items).toHaveLength(4);
    for (const m of page.items) {
      if (m.userId === guest.userId) expect(m.user.email).toBe(guest.email);
      else expect(m.user.email).toBeNull();
    }
    const byId = new Map(page.items.map((m) => [m.userId, m.user.name]));
    expect(byId.get(nameless.userId)).toBe("Member");
    expect(byId.get(named.userId)).toBe("Olive Owner");
    expect(
      JSON.stringify(await spaceMembers(guest)).replaceAll(guest.email, ""),
    ).not.toContain("@");
  });

  it("a member viewer still sees every address", async () => {
    const page = SpaceMembersPageSchema.parse(await spaceMembers(member));
    const emails = page.items.map((m) => m.user.email).sort();
    expect(emails).toEqual(
      [nameless.email, named.email, guest.email, member.email].sort(),
    );
  });
});

describe("sharing by email", () => {
  it("a guest cannot share or list shares (read-only), so no email is echoed", async () => {
    const list = await api(app, R.shares(namedArt), guest.cookie);
    expect(list.status).toBe(404);
    const put = await api(app, R.shares(namedArt), guest.cookie, {
      method: "PUT",
      body: { email: "typed@x.com", role: "viewer" },
    });
    expect(put.status).toBe(404);
  });
});
