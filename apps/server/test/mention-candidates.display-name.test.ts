// #3219: a person is found by the display name every comment shows, not only by the IdP name or address.
import { env } from "cloudflare:workers";
import { type Member, type MentionCandidates, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser, upsertOnLogin } from "../src/services/users.js";
import { direct } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
// Like a real member: the address says nothing of the name people know them by.
async function mk(prefix: string, displayName: string, domain = "x.com") {
  const email = `${prefix}-${tag}@${domain}`;
  const l = await login(email, "member");
  await E.DB.prepare("update users set display_name = ? where id = ?")
    .bind(displayName, l.userId)
    .run();
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email } as U;
}
let owner: U;
let editor: U;
let target: U;
beforeAll(async () => {
  owner = await mk("dn-owner", "Olive Owner");
  editor = await mk("dn-editor", "Eddie Editor");
  target = await mk("jx7731", "Jordan Xavier");
});

async function page(share: U[], role: "viewer" | "editor" = "editor") {
  const a = await publish(
    E,
    owner.member,
    { title: "P", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of share)
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role },
    });
  return a.id;
}
const find = async (id: string, u: U, q: string) => {
  const r = await api(app, R.artifactMentionCandidates(id), u.cookie, {
    method: "POST",
    body: { q },
  });
  return r.status === 200
    ? ((await r.json()) as MentionCandidates).items.map((i) => i.id)
    : [`status ${r.status}`];
};

describe("person @mention candidates", () => {
  it("an editor finds a reader by display name, first or later word, any case", async () => {
    const id = await page([editor, target]);
    expect(await find(id, editor, "jordan")).toEqual([target.userId]);
    expect(await find(id, owner, "XAV")).toEqual([target.userId]);
    expect(await find(id, owner, "jordan x")).toEqual([target.userId]);
    expect(await find(id, owner, "ordan")).toEqual([]);
  });

  it("matches a handle prefix only for a reader", async () => {
    const who = await mk("handle-reader", "Ana Ruiz");
    await api(app, R.me, who.cookie, {
      method: "PATCH",
      body: { handle: "ana-r_21" },
    });
    expect(await find(await page([who]), owner, "ANA-R_")).toEqual([
      who.userId,
    ]);
    expect(await find(await page([]), owner, "ana-r_")).toEqual([]);
  });

  it("a reader is still found by the IdP name", async () => {
    const who = await mk("kq9912", "Kay Q");
    await E.DB.prepare("update users set name = 'Kim Quinn' where id = ?")
      .bind(who.userId)
      .run();
    const id = await page([who]);
    expect(await find(id, owner, "quinn")).toEqual([who.userId]);
  });

  it("finds real pending invites by supplied name or private local-part prefix", async () => {
    const manager = await login(`inviter-${tag}@x.com`, "admin");
    const install = direct({ AUTH_PROVIDERS: "google" });
    async function invite(local: string, name?: string) {
      const email = `${local}@x.com`;
      const res = await api(
        app,
        R.members,
        manager.cookie,
        { method: "POST", body: { email, role: "member", name } },
        install,
      );
      expect(res.status).toBe(201);
      const user = (await res.json()) as Member;
      expect(user.lastSeenAt).toBeNull();
      return user;
    }
    const named = await invite(`ab4410-${tag}`, "Alex Brooks");
    const local = `invite_${tag}+line2`;
    const unnamed = await invite(local);
    const id = await page([]);
    const search = async (q: string) => {
      const res = await api(
        app,
        R.artifactMentionCandidates(id),
        owner.cookie,
        { method: "POST", body: { q } },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as MentionCandidates).items;
    };
    expect(await search("broo")).toEqual([]);
    expect(await search(local)).toEqual([]);
    await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(await search("BROO")).toEqual([
      expect.objectContaining({ id: named.id, name: "Alex Brooks" }),
    ]);
    const faces = await search(local.slice(0, -1).toUpperCase());
    expect(faces).toEqual([
      expect.objectContaining({
        id: unnamed.id,
        name: expect.stringMatching(/^Invited member · [a-f0-9]{6}$/),
      }),
    ]);
    expect(JSON.stringify(faces)).not.toContain(local);
    expect(await search(local.replace("_", "x"))).toEqual([]);
    expect(await search(`${local}@x`)).toEqual([]);
    expect(await search("invite%")).toEqual([]);
    expect(await search(unnamed.email)).toEqual(faces);
    const signedIn = await upsertOnLogin(E, named.email, "Alex Rivera");
    expect(signedIn?.name).toBe("Alex Rivera");
    expect(await search("broo")).toEqual([]);
  });

  it("a display name does not offer someone who cannot read the page", async () => {
    const id = await page([editor]);
    expect(await find(id, owner, "jordan")).toEqual([]);
  });

  it("a team-visible page offers a member with no share", async () => {
    const id = await page([]);
    await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(await find(id, owner, "jordan")).toEqual([target.userId]);
  });

  it("empty AUTH_DOMAINS: an invited editor with any address is not silenced", async () => {
    const gm = await mk("inv-editor2", "Gale Mail", "gmail.test");
    const id = await page([gm, target]);
    expect(await find(id, gm, "jordan")).toEqual([target.userId]);
  });

  it.todo("AUTH_DOMAINS outsider editors: separate call (#2559)");
});
