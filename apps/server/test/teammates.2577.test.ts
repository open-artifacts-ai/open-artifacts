// #2577: GET R.meTeammates, Share.memberId, POST R.meOnboardingListensAsked.
import { env } from "cloudflare:workers";
import {
  type Member,
  newId,
  OnboardingSchema,
  R,
  ShareSchema,
  TeammatesSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
// Login domains: x.com is the team; anything else is an outsider.
const E = { ...(env as object), AUTH_DOMAINS: "x.com" } as typeof env;
type U = { cookie: string; userId: string; member: Member; email: string };

async function mk(
  prefix: string,
  role: Member["role"],
  domain = "x.com",
  name?: string,
): Promise<U> {
  const email = `${prefix}-${tag}@${domain}`;
  const l = await login(email, role);
  if (name)
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(name, l.userId)
      .run();
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

let caller: U;
let ada: U;
let grace: U;
let admin: U;
let guest: U;
let outsider: U;
let gone: U;

beforeAll(async () => {
  caller = await mk("tm-caller", "member", "x.com", "Cal Ler");
  ada = await mk("tm-ada", "member", "x.com", "Ada Lovelace");
  grace = await mk("tm-grace", "member", "x.com", "Grace");
  admin = await mk("tm-admin", "admin", "x.com", "Adm In");
  guest = await mk("tm-guest", "guest", "x.com", "Gus Guest");
  outsider = await mk("tm-out", "member", "out.org", "Olly Outside");
  gone = await mk("tm-gone", "member", "x.com", "Gone Person");
  await env.DB.prepare("update users set status = 'removed' where id = ?")
    .bind(gone.userId)
    .run();
});

const teammates = (auth: string | null) => api(app, R.meTeammates, auth, {}, E);

describe("GET R.meTeammates", () => {
  it("lists team members by name with initials: not the caller, guests, outsiders or removed people", async () => {
    const r = await teammates(caller.cookie);
    expect(r.status).toBe(200);
    const t = TeammatesSchema.parse(await r.json());
    const byId = new Map(t.members.map((m) => [m.id, m]));
    expect(byId.get(ada.userId)).toEqual({
      id: ada.userId,
      name: "Ada Lovelace",
      initials: "AL",
    });
    expect(byId.get(grace.userId)).toEqual({
      id: grace.userId,
      name: "Grace",
      initials: "G",
    });
    expect(byId.has(admin.userId)).toBe(true);
    for (const u of [caller, guest, outsider, gone])
      expect(byId.has(u.userId)).toBe(false);
  });

  it("never carries an email", async () => {
    const text = await (await teammates(caller.cookie)).text();
    expect(text).not.toContain("@");
    expect(text).not.toContain(tag);
  });

  it("a person with no real name shows 'Someone', never the address", async () => {
    const nameless = await mk("tm-none", "member", "x.com");
    await env.DB.prepare(
      "update users set name = '', display_name = null where id = ?",
    )
      .bind(nameless.userId)
      .run();
    const t = TeammatesSchema.parse(
      await (await teammates(caller.cookie)).json(),
    );
    const m = t.members.find((x) => x.id === nameless.userId);
    expect(m?.name).toBe("Someone");
    expect(m?.initials).toBe("S");
  });

  it("refuses a guest (403) and anonymous (401)", async () => {
    expect((await teammates(guest.cookie)).status).toBe(403);
    expect((await teammates(null)).status).toBe(401);
  });
});

describe("Share.memberId", () => {
  const pub = async () =>
    (
      await publish(
        env,
        caller.member,
        { title: "t", format: "markdown", content: "hello" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  const put = (id: string, email: string) =>
    api(
      app,
      R.shares(id),
      caller.cookie,
      { method: "PUT", body: { email, role: "viewer" } },
      E,
    );

  it("is the user id for a team member, in the PUT response and in the list", async () => {
    const id = await pub();
    const r = await put(id, ada.email);
    expect(r.status).toBe(200);
    expect(ShareSchema.parse(await r.json()).memberId).toBe(ada.userId);
    const list = (await (
      await api(app, R.shares(id), caller.cookie, {}, E)
    ).json()) as { email: string; memberId: string | null }[];
    expect(list.find((s) => s.email === ada.email)?.memberId).toBe(ada.userId);
  });

  it("is null for an unknown address, an outsider and a guest", async () => {
    const id = await pub();
    const unknown = `nobody-${tag}@x.com`;
    for (const email of [unknown, outsider.email, guest.email]) {
      const r = await put(id, email);
      expect(r.status).toBe(200);
      expect(ShareSchema.parse(await r.json()).memberId).toBeNull();
    }
    const list = (await (
      await api(app, R.shares(id), caller.cookie, {}, E)
    ).json()) as { email: string; memberId: string | null }[];
    for (const email of [unknown, outsider.email, guest.email])
      expect(list.find((s) => s.email === email)?.memberId).toBeNull();
    expect(JSON.stringify(list)).not.toContain(outsider.userId);
    expect(JSON.stringify(list)).not.toContain(guest.userId);
  });
});

describe("POST R.meOnboardingListensAsked", () => {
  const post = (auth: string | null) =>
    api(app, R.meOnboardingListensAsked, auth, { method: "POST" });
  const read = async (auth: string) =>
    OnboardingSchema.parse(await (await api(app, R.onboarding, auth)).json());

  it("flips listensAsked once and is idempotent", async () => {
    const u = await mk("tm-la", "member");
    expect((await read(u.cookie)).listensAsked).toBe(false);
    const r = await post(u.cookie);
    expect(r.status).toBe(200);
    expect(OnboardingSchema.parse(await r.json()).listensAsked).toBe(true);
    const row = () =>
      env.DB.prepare("select value from settings where key = ?")
        .bind(`onboarding:listens-asked:${u.userId}`)
        .first<{ value: string }>();
    const first = await row();
    expect((await post(u.cookie)).status).toBe(200);
    expect(await row()).toEqual(first);
    expect((await read(u.cookie)).listensAsked).toBe(true);
    // Per person: another member is unaffected.
    expect((await read(ada.cookie)).listensAsked).toBe(false);
  });

  it("refuses a token (404), a guest (403) and anonymous (401)", async () => {
    const u = await mk("tm-la2", "member");
    const pat = (await createPat(env, u.userId, "agent")).token;
    expect((await post(pat)).status).toBe(404);
    expect((await read(u.cookie)).listensAsked).toBe(false);
    expect((await post(guest.cookie)).status).toBe(403);
    expect((await post(null)).status).toBe(401);
  });
});
