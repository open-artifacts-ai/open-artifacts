// R.onboarding: the first-run checklist's install-wide state. Owner only.
import { env } from "cloudflare:workers";
import { newId, OnboardingSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { seedWelcome } from "../src/services/onboarding.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const HOSTED_ENV = { ...(env as object), HOSTED: "1" } as typeof env;
/** The checklist facts of a user with nothing done. */
const NONE = {
  welcomeId: null,
  welcomeOpened: false,
  agentConnected: false,
  firstArtifact: null,
  commented: false,
};

const app = createApp();
const tag = () => newId().slice(0, 6).toLowerCase();
const clear = () =>
  env.DB.prepare("delete from settings where key like 'onboarding:%'").run();
const get = async (cookie: string) => {
  const r = await api(app, R.onboarding, cookie);
  return {
    status: r.status,
    body: r.ok ? OnboardingSchema.parse(await r.json()) : null,
  };
};
const put = (cookie: string | null, body: unknown) =>
  api(app, R.onboarding, cookie, { method: "PUT", body });

describe("R.onboarding", () => {
  it("starts empty, and the owner's dismissal persists", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body).toEqual({
      dismissed: false,
      completed: false,
      hasArtifacts: false,
      ...NONE,
    });
    const r = await put(o.cookie, { dismissed: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      dismissed: true,
      completed: false,
      hasArtifacts: false,
      ...NONE,
    });
    // Another session of the same owner (another browser) reads it.
    const again = await login(`own2-${tag()}@example.com`, "owner");
    expect((await get(again.cookie)).body?.dismissed).toBe(true);
  });

  it("records completion once and keeps it", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect(await (await put(o.cookie, { completed: true })).json()).toEqual({
      dismissed: false,
      completed: true,
      hasArtifacts: false,
      ...NONE,
    });
    const first = await env.DB.prepare(
      "select value from settings where key = 'onboarding:completed'",
    ).first<{ value: string }>();
    await put(o.cookie, { completed: true });
    const second = await env.DB.prepare(
      "select value from settings where key = 'onboarding:completed'",
    ).first<{ value: string }>();
    expect(second?.value).toBe(first?.value);
  });

  it("refuses everyone but the owner, and writes nothing", async () => {
    await clear();
    for (const role of ["admin", "member", "guest"] as const) {
      const u = await login(`${role}-${tag()}@example.com`, role);
      expect((await put(u.cookie, { dismissed: true })).status).toBe(404);
      expect((await get(u.cookie)).status).toBe(404);
    }
    expect((await put(null, { dismissed: true })).status).toBe(401);
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body).toEqual({
      dismissed: false,
      completed: false,
      hasArtifacts: false,
      ...NONE,
    });
  });

  it("says whether the caller owns a live artifact (#1832)", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const other = await login(`own2-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(false);
    const r = await api(app, R.artifacts, o.cookie, {
      method: "POST",
      body: { title: "first", format: "html", content: "<p>hi</p>" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(true);
    expect((await get(other.cookie)).body?.hasArtifacts).toBe(false);
    expect(
      (await api(app, R.artifact(id), o.cookie, { method: "DELETE" })).status,
    ).toBeLessThan(300);
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(false);
  });

  it("rejects a flag turned off or unknown fields", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await put(o.cookie, { dismissed: false })).status).toBe(400);
    expect((await put(o.cookie, { other: 1 })).status).toBe(400);
  });

  describe("the Welcome artifact (#2287)", () => {
    const owner = async () => {
      const o = await login(`own-${tag()}@example.com`, "owner");
      const user = await getUser(env, o.userId);
      if (!user) throw new Error("no user");
      return { ...o, user };
    };
    const welcomeRows = () =>
      env.DB.prepare(
        "select id, owner_id, title, format, visibility from artifacts where title = 'Welcome'",
      ).all<{
        id: string;
        owner_id: string;
        format: string;
        visibility: string;
      }>();

    it("seeds one private html Welcome for the hosted owner, once", async () => {
      await clear();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      await seedWelcome(HOSTED_ENV, o.user);
      const rows = (await welcomeRows()).results.filter(
        (r) => r.owner_id === o.userId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ format: "html", visibility: "private" });
      const got = (await get(o.cookie)).body;
      expect(got?.welcomeId).toBe(rows[0]?.id);
      expect(got?.welcomeOpened).toBe(false);
      // Welcome is not "the first artifact" the user published.
      expect(got?.firstArtifact).toBeNull();
      expect(got?.hasArtifacts).toBe(true);
    });

    it("seeds nothing off hosted, or for a non-owner", async () => {
      await clear();
      const o = await owner();
      await seedWelcome(env, o.user);
      const m = await login(`mem-${tag()}@example.com`, "member");
      const mu = await getUser(env, m.userId);
      if (!mu) throw new Error("no user");
      await seedWelcome(HOSTED_ENV, mu);
      expect(
        (await welcomeRows()).results.filter(
          (r) => r.owner_id === o.userId || r.owner_id === m.userId,
        ),
      ).toHaveLength(0);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
    });

    it("does not reseed after the owner deletes it, and welcomeId goes null", async () => {
      await clear();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      const id = (await get(o.cookie)).body?.welcomeId as string;
      expect(
        (await api(app, R.artifact(id), o.cookie, { method: "DELETE" })).status,
      ).toBeLessThan(300);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
      await seedWelcome(HOSTED_ENV, o.user);
      expect(
        (await welcomeRows()).results.filter((r) => r.owner_id === o.userId),
      ).toHaveLength(1);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
    });

    it("a failed seed resolves, leaves nothing, and a later one can retry", async () => {
      await clear();
      const o = await owner();
      const ghost = { ...o.user, id: newId() };
      await expect(seedWelcome(HOSTED_ENV, ghost)).resolves.toBeUndefined();
      expect(
        await env.DB.prepare(
          "select 1 from settings where key = 'onboarding:welcome'",
        ).first(),
      ).toBeNull();
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await get(o.cookie)).body?.welcomeId).not.toBeNull();
    });

    it("records the first open once, for its user only", async () => {
      await clear();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      const other = await login(`own2-${tag()}@example.com`, "owner");
      const r = await put(other.cookie, { welcomeOpened: true });
      expect(r.status).toBe(200);
      expect(OnboardingSchema.parse(await r.json())).toMatchObject({
        welcomeId: null,
        welcomeOpened: false,
      });
      expect((await get(o.cookie)).body?.welcomeOpened).toBe(false);
      const mine = await put(o.cookie, { welcomeOpened: true });
      expect(OnboardingSchema.parse(await mine.json()).welcomeOpened).toBe(
        true,
      );
      expect((await get(other.cookie)).body?.welcomeOpened).toBe(false);
      expect((await put(o.cookie, { welcomeOpened: false })).status).toBe(400);
    });

    it("reports the caller's first other artifact, connected agent and comment", async () => {
      await clear();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await get(o.cookie)).body).toMatchObject({
        agentConnected: false,
        firstArtifact: null,
        commented: false,
      });
      const a = await api(app, R.artifacts, o.cookie, {
        method: "POST",
        body: { title: "mine", format: "html", content: "<p>x</p>" },
      });
      const { id } = (await a.json()) as { id: string };
      await env.DB.prepare(
        "insert into agent_grants (grant_id, user_id) values (?1, ?2)",
      )
        .bind(newId(), o.userId)
        .run();
      const c = await api(app, R.comments(id), o.cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: "hello" },
      });
      expect(c.status).toBeLessThan(300);
      expect((await get(o.cookie)).body).toMatchObject({
        agentConnected: true,
        firstArtifact: { id, title: "mine" },
        commented: true,
      });
    });
  });
});
