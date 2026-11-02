import { env } from "cloudflare:workers";
import { MeSchema, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { senderName } from "../src/email/templates.js";
import { getSummary, publish } from "../src/services/artifacts.js";
import {
  effectiveName,
  getUser,
  idpName,
  upsertOnLogin,
} from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const me = async (auth: string) => {
  const r = await api(app, R.me, auth);
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};
const patchMe = (auth: string | null, body: unknown, headers = {}) =>
  api(app, R.me, auth, { method: "PATCH", body, headers });
const setIdpName = (id: string, name: string) =>
  env.DB.prepare("update users set name = ? where id = ?").bind(name, id).run();

describe("effective name", () => {
  const u = (displayName: string | null, name: string) => ({
    displayName,
    name,
    email: "me@test.invalid",
  });
  it("display name, else a real IdP name, else the full email; never the local part", () => {
    expect(effectiveName(u("Leo", "me"))).toBe("Leo");
    expect(effectiveName(u(null, "Leo Urbina"))).toBe("Leo Urbina");
    expect(effectiveName(u(null, "me"))).toBe("me@test.invalid");
    expect(effectiveName(u(null, "ME"))).toBe("me@test.invalid");
    expect(effectiveName(u(null, "  "))).toBe("me@test.invalid");
    expect(idpName("me", "me@test.invalid")).toBeNull();
    expect(idpName("Leo", "me@test.invalid")).toBe("Leo");
  });

  it("emails' senderName never uses the bare local part", () => {
    expect(senderName({ name: "me", email: "me@test.invalid" })).toBe(
      "me@test.invalid",
    );
    expect(senderName({ name: "Me", email: "me@test.invalid" })).toBe(
      "me@test.invalid",
    );
    expect(senderName({ name: "Leo", email: "me@test.invalid" })).toBe("Leo");
  });
});

describe("GET/PATCH /api/v1/me", () => {
  let u: { cookie: string; userId: string };
  beforeAll(async () => {
    u = await login(`dn-${tag}@x.com`);
  });

  it("no IdP name: needsDisplayName, and user.name is the full email", async () => {
    const m = await me(u.cookie);
    expect(m).toMatchObject({
      displayName: null,
      suggestedName: null,
      needsDisplayName: true,
    });
    expect(m.user.name).toBe(`dn-${tag}@x.com`);
  });

  it("an IdP name is suggested and used; no prompt", async () => {
    const v = await login(`dn-idp-${tag}@x.com`);
    await setIdpName(v.userId, "Ada Lovelace");
    const m = await me(v.cookie);
    expect(m).toMatchObject({
      displayName: null,
      suggestedName: "Ada Lovelace",
      needsDisplayName: false,
    });
    expect(m.user.name).toBe("Ada Lovelace");
  });

  it("PATCH sets a trimmed display name and returns Me", async () => {
    const r = await patchMe(u.cookie, { displayName: "  Leo U.  " });
    expect(r.status).toBe(200);
    const m = MeSchema.parse(await r.json());
    expect(m).toMatchObject({ displayName: "Leo U.", needsDisplayName: false });
    expect(m.user.name).toBe("Leo U.");
    expect((await me(u.cookie)).displayName).toBe("Leo U.");
    expect((await getUser(env, u.userId))?.name).toBe("Leo U.");
  });

  it("PATCH validation: 400 for blank, > 80, controls, CR/LF, bidi, zero-width, extra keys", async () => {
    expect(
      (await patchMe(u.cookie, { displayName: "x".repeat(80) })).status,
    ).toBe(200);
    for (const body of [
      { displayName: "" },
      { displayName: "   " },
      { displayName: "x".repeat(81) },
      { displayName: "a\nb" },
      { displayName: "a\r\nb" },
      { displayName: "a\u0000b" },
      { displayName: "a‮b" },
      { displayName: "a​b" },
      { displayName: "a﻿b" },
      { displayName: 7 },
      { displayName: "ok", extra: 1 },
      {},
    ]) {
      const r = await patchMe(u.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await errOf(r)).code).toBe("bad_request");
    }
  });

  it("auth: anonymous 401, cookie without the CSRF header 403, PAT ok, guest ok", async () => {
    expect((await patchMe(null, { displayName: "X" })).status).toBe(401);
    const noCsrf = await api(app, R.me, u.cookie, {
      method: "PATCH",
      body: { displayName: "X" },
      headers: { "x-oa-request": "" },
    });
    expect(noCsrf.status).toBe(403);
    const pat = (await createPat(env, u.userId, "dn")).token;
    expect((await patchMe(pat, { displayName: "Via PAT" })).status).toBe(200);
    const g = await login(`dn-g-${tag}@x.com`, "guest");
    expect((await patchMe(g.cookie, { displayName: "Guest G" })).status).toBe(
      200,
    );
  });
});

describe("sign-in", () => {
  it("refreshes the IdP name but never overwrites a chosen display name", async () => {
    const email = `dn-login-${tag}@x.com`;
    const owner = await login(email);
    await patchMe(owner.cookie, { displayName: "Chosen" });
    const m = await upsertOnLogin(env, email, "IdP Name");
    expect(m?.name).toBe("Chosen");
    const row = await env.DB.prepare(
      "select name, display_name as d from users where id = ?",
    )
      .bind(owner.userId)
      .first<{ name: string; d: string }>();
    expect(row).toEqual({ name: "IdP Name", d: "Chosen" });
    const after = await me(owner.cookie);
    expect(after).toMatchObject({
      displayName: "Chosen",
      suggestedName: "IdP Name",
      needsDisplayName: false,
    });
  });
});

describe("UserRef names", () => {
  it("owner name is effective for members; anonymous never gets the email as a name", async () => {
    const l = await login(`dn-own-${tag}@x.com`);
    const user = await getUser(env, l.userId);
    if (!user) throw new Error("no user");
    const { id } = await publish(
      env,
      user,
      { title: "t", format: "markdown", content: "x", visibility: "public" },
      null,
    );
    const asUser = await getSummary(env, { kind: "user", user }, id);
    expect(asUser.owner.name).toBe(`dn-own-${tag}@x.com`);
    const anon = await getSummary(env, { kind: "anonymous" }, id);
    expect(anon.owner).toMatchObject({ email: null, name: null });
    await patchMe(l.cookie, { displayName: "Owner O" });
    expect((await getSummary(env, { kind: "anonymous" }, id)).owner.name).toBe(
      "Owner O",
    );
    expect((await getSummary(env, { kind: "user", user }, id)).owner.name).toBe(
      "Owner O",
    );
  });
});
