// R.onboarding: the first-run checklist's install-wide state. Owner only.
import { env } from "cloudflare:workers";
import { newId, OnboardingSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
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
  agentNamed: false,
  agentName: null,
  mentionReplied: false,
  mentionStalled: false,
  askAnswered: false,
  teamStep: false,
  invitedBy: null,
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
    // An established person (earlier sign-ins): a read seeds no Welcome (#2632).
    for (let i = 0; i < 2; i++)
      await env.DB.prepare(
        "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id) values (?1, ?2, 'user', ?3, 'auth.signin', 'user', ?3)",
      )
        .bind(newId(), Date.now(), o.userId)
        .run();
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
    // Per person (#2632): another person's flags are their own.
    const again = await login(`own2-${tag()}@example.com`, "owner");
    expect((await get(again.cookie)).body?.dismissed).toBe(false);
    expect((await get(o.cookie)).body?.dismissed).toBe(true);
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

  it("is per person: a member's flags never touch the owner's or another member's (#2632)", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    const a = await login(`mem-${tag()}@example.com`, "member");
    const b = await login(`adm-${tag()}@example.com`, "admin");
    expect((await put(a.cookie, { dismissed: true })).status).toBe(200);
    expect((await get(a.cookie)).body?.dismissed).toBe(true);
    expect((await get(b.cookie)).body?.dismissed).toBe(false);
    expect((await get(o.cookie)).body?.dismissed).toBe(false);
    expect((await put(b.cookie, { completed: true })).status).toBe(200);
    expect((await get(b.cookie)).body?.completed).toBe(true);
    expect((await get(a.cookie)).body?.completed).toBe(false);
    expect(
      await env.DB.prepare(
        "select 1 from settings where key in ('onboarding:dismissed', 'onboarding:completed')",
      ).first(),
    ).toBeNull();
  });

  it("refuses a guest with 403 and writes nothing; anonymous is 401", async () => {
    await clear();
    const g = await login(`guest-${tag()}@example.com`, "guest");
    const r = await put(g.cookie, { dismissed: true });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "members_only",
    );
    expect((await get(g.cookie)).status).toBe(403);
    expect((await put(null, { dismissed: true })).status).toBe(401);
    expect(
      await env.DB.prepare(
        "select 1 from settings where key like 'onboarding:%'",
      ).first(),
    ).toBeNull();
  });

  it("reads the owner's install-wide rows from before as the owner's (nothing resets)", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    const m = await login(`mem-${tag()}@example.com`, "member");
    for (const k of ["dismissed", "completed", "welcome-opened"])
      await env.DB.prepare("insert into settings (key, value) values (?1, '1')")
        .bind(`onboarding:${k}`)
        .run();
    const got = (await get(o.cookie)).body;
    expect(got).toMatchObject({ dismissed: true, completed: true });
    expect((await get(m.cookie)).body).toMatchObject({
      dismissed: false,
      completed: false,
    });
  });

  it("records teamStep once, when the caller comments on another user's artifact", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    const m = await login(`mem-${tag()}@example.com`, "member");
    const mk = async (cookie: string) =>
      (
        (await (
          await api(app, R.artifacts, cookie, {
            method: "POST",
            body: {
              title: "p",
              format: "html",
              content: "<p>x</p>",
              visibility: "team",
            },
          })
        ).json()) as { id: string }
      ).id;
    const mine = await mk(m.cookie);
    const theirs = await mk(o.cookie);
    const say = (id: string, cookie: string) =>
      api(app, R.comments(id), cookie, {
        method: "POST",
        body: { anchor: { kind: "note" }, body: "hi" },
      });
    expect((await say(mine, m.cookie)).status).toBeLessThan(300);
    expect((await get(m.cookie)).body?.teamStep).toBe(false);
    expect((await say(theirs, m.cookie)).status).toBeLessThan(300);
    expect((await get(m.cookie)).body?.teamStep).toBe(true);
    expect((await get(o.cookie)).body?.teamStep).toBe(false);
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

    it("seeds nothing on an instance that already has artifacts, now or later", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      const a = await api(app, R.artifacts, o.cookie, {
        method: "POST",
        body: { title: "old", format: "html", content: "<p>x</p>" },
      });
      const { id } = (await a.json()) as { id: string };
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await welcomeRows()).results).toHaveLength(0);
      await api(app, R.artifact(id), o.cookie, { method: "DELETE" });
      await env.DB.prepare("delete from artifacts").run();
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await welcomeRows()).results).toHaveLength(0);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
    });

    it("ignores the provisioner's self-test page: fresh still seeds, and it is not the user's work", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      const selfTest = async () => {
        const r = await api(app, R.artifacts, o.cookie, {
          method: "POST",
          body: {
            title: "Welcome to Open Artifacts",
            format: "markdown",
            content: "# hi",
          },
        });
        return ((await r.json()) as { id: string }).id;
      };
      const st = await selfTest();
      let got = (await get(o.cookie)).body;
      expect(got?.hasArtifacts).toBe(false);
      expect(got?.firstArtifact).toBeNull();
      await seedWelcome(HOSTED_ENV, o.user);
      got = (await get(o.cookie)).body;
      expect(got?.welcomeId).not.toBeNull();
      expect(got?.firstArtifact).toBeNull();
      // Deleted self-test page: still fresh.
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const st2 = await selfTest();
      await api(app, R.artifact(st2), o.cookie, { method: "DELETE" });
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await get(o.cookie)).body?.welcomeId).not.toBeNull();
      expect(st).not.toBe(st2);
    });

    it("the seeded Welcome does not make hasArtifacts true; the user's own artifact does", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      const got = (await get(o.cookie)).body;
      expect(got?.welcomeId).not.toBeNull();
      expect(got?.hasArtifacts).toBe(false);
      await api(app, R.artifacts, o.cookie, {
        method: "POST",
        body: { title: "mine", format: "html", content: "<p>x</p>" },
      });
      expect((await get(o.cookie)).body?.hasArtifacts).toBe(true);
    });

    it("any other artifact next to the self-test page keeps the instance not fresh", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      for (const [title, format] of [
        ["Welcome to Open Artifacts", "markdown"],
        ["Welcome to Open Artifacts", "html"],
      ] as const) {
        await clear();
        await env.DB.prepare("delete from artifacts").run();
        await api(app, R.artifacts, o.cookie, {
          method: "POST",
          body: { title, format, content: "<p>x</p>" },
        });
        if (format === "markdown")
          await api(app, R.artifacts, o.cookie, {
            method: "POST",
            body: { title: "mine", format: "html", content: "<p>x</p>" },
          });
        await seedWelcome(HOSTED_ENV, o.user);
        expect((await get(o.cookie)).body?.welcomeId).toBeNull();
      }
    });

    it("keeps the claim when publish succeeded but the record update fails", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      const db = new Proxy(env.DB, {
        get: (t, k) =>
          k === "prepare"
            ? (q: string) => {
                if (q.startsWith("update settings set value"))
                  throw new Error("boom");
                return t.prepare(q);
              }
            : (Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)),
      });
      await seedWelcome({ ...HOSTED_ENV, DB: db } as typeof env, o.user);
      expect((await welcomeRows()).results).toHaveLength(1);
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await welcomeRows()).results).toHaveLength(1);
    });

    it("seeds one private html Welcome for the hosted owner, once", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
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
      expect(got?.hasArtifacts).toBe(false);
    });

    it("seeds each member their own private Welcome, once, on any install and any role but guest (#2632)", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      await seedWelcome(env, o.user);
      const m = await login(`mem-${tag()}@example.com`, "member");
      const mu = await getUser(env, m.userId);
      if (!mu) throw new Error("no user");
      const g = await login(`guest-${tag()}@example.com`, "guest");
      const gu = await getUser(env, g.userId);
      if (!gu) throw new Error("no user");
      await seedWelcome(env, mu);
      await seedWelcome(env, mu);
      await seedWelcome(env, gu);
      const mine = (id: string) =>
        welcomeRows().then((r) => r.results.filter((x) => x.owner_id === id));
      expect(await mine(o.userId)).toHaveLength(1);
      expect(await mine(m.userId)).toHaveLength(1);
      expect(await mine(g.userId)).toHaveLength(0);
      expect((await mine(m.userId))[0]).toMatchObject({
        format: "html",
        visibility: "private",
      });
      const got = (await get(m.cookie)).body;
      expect(got?.welcomeId).toBe((await mine(m.userId))[0]?.id);
      expect(got?.hasArtifacts).toBe(false);
      expect(got?.firstArtifact).toBeNull();
      // Each Welcome is its person's own.
      expect((await get(o.cookie)).body?.welcomeId).toBe(
        (await mine(o.userId))[0]?.id,
      );
    });

    it("the fresh-instance check is for the first person only: a member always gets theirs", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      await api(app, R.artifacts, o.cookie, {
        method: "POST",
        body: { title: "old", format: "html", content: "<p>x</p>" },
      });
      await seedWelcome(env, o.user);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
      const m = await login(`mem-${tag()}@example.com`, "member");
      const mu = await getUser(env, m.userId);
      if (!mu) throw new Error("no user");
      await seedWelcome(env, mu);
      expect((await get(m.cookie)).body?.welcomeId).not.toBeNull();
      // The owner is not seeded later either.
      await seedWelcome(env, o.user);
      expect((await get(o.cookie)).body?.welcomeId).toBeNull();
    });

    it("an owner whose Welcome is the legacy install-wide row is not seeded again", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      await seedWelcome(HOSTED_ENV, o.user);
      const id = (await get(o.cookie)).body?.welcomeId as string;
      await env.DB.prepare(
        "delete from settings where key like 'onboarding:welcome:%'",
      ).run();
      await env.DB.prepare(
        "insert into settings (key, value) values ('onboarding:welcome', ?1)",
      )
        .bind(JSON.stringify({ userId: o.userId, artifactId: id }))
        .run();
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await get(o.cookie)).body?.welcomeId).toBe(id);
      expect(
        (await welcomeRows()).results.filter((r) => r.owner_id === o.userId),
      ).toHaveLength(1);
    });

    it("does not reseed after the owner deletes it, and welcomeId goes null", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
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
      await env.DB.prepare("delete from artifacts").run();
      const o = await owner();
      const ghost = { ...o.user, id: newId() };
      await expect(seedWelcome(HOSTED_ENV, ghost)).resolves.toBeUndefined();
      expect(
        await env.DB.prepare(
          "select 1 from settings where key like 'onboarding:welcome%'",
        ).first(),
      ).toBeNull();
      await seedWelcome(HOSTED_ENV, o.user);
      expect((await get(o.cookie)).body?.welcomeId).not.toBeNull();
    });

    it("records the first open once, for its user only", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
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

    it("a comment posted by an agent (a token) does not tick commented", async () => {
      await clear();
      const o = await owner();
      const a = await api(app, R.artifacts, o.cookie, {
        method: "POST",
        body: { title: "mine", format: "html", content: "<p>x</p>" },
      });
      const { id } = (await a.json()) as { id: string };
      const pat = (await createPat(env, o.userId, "Claude Code")).token;
      const post = (auth: string) =>
        api(app, R.comments(id), auth, {
          method: "POST",
          body: { anchor: { kind: "note" }, body: "hi" },
        });
      expect((await post(pat)).status).toBeLessThan(300);
      expect((await get(o.cookie)).body?.commented).toBe(false);
      expect((await post(o.cookie)).status).toBeLessThan(300);
      expect((await get(o.cookie)).body?.commented).toBe(true);
    });

    it("reports the caller's first other artifact, connected agent and comment", async () => {
      await clear();
      await env.DB.prepare("delete from artifacts").run();
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
