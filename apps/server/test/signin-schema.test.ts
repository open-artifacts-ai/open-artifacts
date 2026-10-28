import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sweepLoginCodes } from "../src/auth/codes.js";
import { createPat } from "../src/auth/pat.js";
import { scheduled } from "../src/cron.js";
import { oauthApi } from "../src/mcp/oauth-api.js";
import { publish } from "../src/services/artifacts.js";
import {
  patchMember,
  removeMember,
  SYSTEM_ACTOR,
} from "../src/services/members.js";
import { removeGuestIfUnshared } from "../src/services/shares.js";
import { getUser, upsertOnLogin } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// P2 Task 3: migration 0008 (identities, login_codes, users.session_epoch,
// users.status) and the lifecycle hooks around them.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const cols = async (table: string) =>
  (
    await env.DB.prepare(
      `select name, pk, "notnull" as nn, dflt_value as d from pragma_table_info('${table}') order by cid`,
    ).all<{ name: string; pk: number; nn: number; d: string | null }>()
  ).results;
const one = async <T>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>()) as T;
const epochOf = async (id: string) =>
  (
    await one<{ e: number }>(
      "select session_epoch e from users where id = ?",
      id,
    )
  ).e;
const exists = async (id: string) =>
  (await one<{ n: number }>("select count(*) n from users where id = ?", id))
    .n === 1;
const linkGoogle = (userId: string, sub: string) =>
  env.DB.prepare(
    "insert into identities (provider, subject, tenant, user_id, created_at) values ('google', ?, 'a.com', ?, ?)",
  )
    .bind(sub, userId, Date.now())
    .run();
const insertCode = (requestId: string, expiresAt: number) =>
  env.DB.prepare(
    "insert into login_codes (email_key, request_id, code_hash, expires_at, created_at) values (?, ?, 'h', ?, ?)",
  )
    .bind(`ek-${tag}`, requestId, expiresAt, Date.now())
    .run();

let owner: Member;
let ownerCookie: string;

beforeAll(async () => {
  // removeMember reassigns to the instance owner; the test DB needs one.
  await login(`s3-root-${tag}@a.com`, "owner");
  const o = await login(`s3-owner-${tag}@a.com`, "member");
  ownerCookie = o.cookie;
  owner = (await getUser(env, o.userId)) as Member;
});

describe("migration 0008", () => {
  it("adds users.session_epoch (0) and users.status ('active')", async () => {
    const c = await cols("users");
    expect(c.find((x) => x.name === "session_epoch")).toMatchObject({
      nn: 1,
      d: "0",
    });
    expect(c.find((x) => x.name === "status")).toMatchObject({
      nn: 1,
      d: "'active'",
    });
    const { userId } = await login(`s3-new-${tag}@a.com`);
    expect(
      await one<{ e: number; s: string }>(
        "select session_epoch e, status s from users where id = ?",
        userId,
      ),
    ).toEqual({ e: 0, s: "active" });
  });

  it("creates identities keyed by (provider, subject), one link per user and provider", async () => {
    const c = await cols("identities");
    expect(c.filter((x) => x.pk > 0).map((x) => x.name)).toEqual([
      "provider",
      "subject",
    ]);
    const { userId } = await login(`s3-link-${tag}@a.com`);
    await linkGoogle(userId, `S1-${tag}`);
    await expect(linkGoogle(userId, `S2-${tag}`)).rejects.toThrow(/UNIQUE/);
  });

  it("creates login_codes keyed by (email_key, request_id)", async () => {
    const c = await cols("login_codes");
    expect(c.filter((x) => x.pk > 0).map((x) => x.name)).toEqual([
      "email_key",
      "request_id",
    ]);
    expect(c.find((x) => x.name === "attempts")).toMatchObject({ d: "0" });
  });
});

describe("lifecycle", () => {
  it("removeMember keeps the member's identities (soft removal, parity 1: a restore or relink reuses them)", async () => {
    const { userId } = await login(`s3-rm-${tag}@a.com`);
    await linkGoogle(userId, `RM-${tag}`);
    await removeMember(env, userId, SYSTEM_ACTOR);
    expect(
      await one<{ n: number }>(
        "select count(*) n from identities where user_id = ?",
        userId,
      ),
    ).toEqual({ n: 1 });
  });

  it("a role change bumps session_epoch", async () => {
    const { userId } = await login(`s3-role-${tag}@a.com`);
    await patchMember(env, userId, { role: "admin" }, SYSTEM_ACTOR);
    expect(await epochOf(userId)).toBe(1);
    await patchMember(env, userId, { role: "member" }, SYSTEM_ACTOR);
    expect(await epochOf(userId)).toBe(2);
  });

  describe("guest cleanup", () => {
    const mk = async () =>
      (
        await publish(
          env,
          owner,
          { title: "t", format: "markdown", content: "x" } as never,
          null,
          undefined,
          "create",
        )
      ).id;
    const share = async (id: string, email: string) =>
      expect(
        (
          await api(app, R.shares(id), ownerCookie, {
            method: "PUT",
            body: { email, role: "viewer" },
          })
        ).status,
      ).toBe(200);
    const del = async (id: string, email: string) =>
      expect(
        (await api(app, R.share(id, email), ownerCookie, { method: "DELETE" }))
          .status,
      ).toBe(204);
    const statusOf = async (id: string) =>
      (await one<{ s: string }>("select status s from users where id = ?", id))
        .s;
    const tokenCount = async (id: string) =>
      (
        await one<{ n: number }>(
          "select count(*) n from tokens where user_id = ?",
          id,
        )
      ).n;
    const grantsOf = async (userId: string) =>
      (await oauthApi(env).listUserGrants(userId)).items;
    const grant = async (userId: string) => {
      const o = oauthApi(env);
      const c = await o.createClient({
        redirectUris: ["https://agent.example/cb"],
        tokenEndpointAuthMethod: "none",
      });
      await o.completeAuthorization({
        request: {
          responseType: "code",
          clientId: c.clientId,
          redirectUri: "https://agent.example/cb",
          scope: [],
          state: "s",
          codeChallenge: "c".repeat(43),
          codeChallengeMethod: "S256",
        },
        userId,
        metadata: {},
        scope: [],
        props: { userId },
      });
    };
    const guest = async (name: string) => {
      const email = `s3-g${name}-${tag}@x.com`;
      return { email, ...(await login(email, "guest")) };
    };
    const log = { artifactId: "a", actorId: "b" };

    it("the last share's deletion deactivates the guest: epoch bumped, tokens and grants revoked, history kept", async () => {
      const g = await guest("last");
      const [a1, a2] = [await mk(), await mk()];
      await share(a1, g.email);
      await share(a2, g.email);
      await env.DB.prepare(
        "update versions set created_by = ? where artifact_id = ?",
      )
        .bind(g.userId, a1)
        .run();
      await createPat(env, g.userId, "p");
      await grant(g.userId);
      expect(await grantsOf(g.userId)).toHaveLength(1);
      await del(a1, g.email);
      expect(await statusOf(g.userId)).toBe("active");
      await del(a2, g.email);
      expect(await exists(g.userId)).toBe(true);
      expect(await statusOf(g.userId)).toBe("removed");
      expect(await epochOf(g.userId)).toBe(1);
      expect(await tokenCount(g.userId)).toBe(0);
      expect(await grantsOf(g.userId)).toEqual([]);
      expect(
        await one<{ n: number }>(
          "select count(*) n from versions where artifact_id = ? and created_by = ?",
          a1,
          g.userId,
        ),
      ).toEqual({ n: 1 });
    });

    it("a remaining share keeps the guest active", async () => {
      const g = await guest("keep");
      const [a1, a2] = [await mk(), await mk()];
      await share(a1, g.email);
      await share(a2, g.email);
      await del(a1, g.email);
      expect(await statusOf(g.userId)).toBe("active");
      expect(await epochOf(g.userId)).toBe(0);
    });

    it("a removed guest's session is refused", async () => {
      const g = await guest("sess");
      const a = await mk();
      await share(a, g.email);
      expect((await api(app, R.me, g.cookie)).status).toBe(200);
      await del(a, g.email);
      expect((await api(app, R.me, g.cookie)).status).toBe(401);
      expect(await getUser(env, g.userId)).toBeNull();
      expect(await upsertOnLogin(env, g.email, null)).toBeNull();
    });

    it("a new share reactivates the removed guest (same row, name kept)", async () => {
      const g = await guest("back");
      await env.DB.prepare("update users set display_name = 'Gee' where id = ?")
        .bind(g.userId)
        .run();
      const [a1, a2] = [await mk(), await mk()];
      await share(a1, g.email);
      await del(a1, g.email);
      expect(await statusOf(g.userId)).toBe("removed");
      await share(a2, g.email);
      expect(await statusOf(g.userId)).toBe("active");
      const u = await upsertOnLogin(env, g.email, null);
      expect(u?.id).toBe(g.userId);
      expect(u?.name).toBe("Gee");
    });

    it("a guest promoted to member before the cleanup batch runs is untouched", async () => {
      const g = await guest("promo");
      await createPat(env, g.userId, "p");
      await env.DB.prepare("update users set role = 'member' where id = ?")
        .bind(g.userId)
        .run();
      await removeGuestIfUnshared(env, g.email, log);
      expect(await statusOf(g.userId)).toBe("active");
      expect(await epochOf(g.userId)).toBe(0);
      expect(await tokenCount(g.userId)).toBe(1);
    });

    it("a share created concurrently with the cleanup keeps the guest active", async () => {
      const g = await guest("race");
      const a = await mk();
      await createPat(env, g.userId, "p");
      // putShare's insert lands before the cleanup batch runs.
      await env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
      )
        .bind(a, g.email, owner.id, Date.now())
        .run();
      await removeGuestIfUnshared(env, g.email, log);
      expect(await statusOf(g.userId)).toBe("active");
      expect(await tokenCount(g.userId)).toBe(1);
    });
  });

  it("deleting a member's share never deletes the member", async () => {
    const email = `s3-keep-${tag}@x.com`;
    const m = await login(email, "member");
    const id = (
      await publish(
        env,
        owner,
        { title: "t", format: "markdown", content: "x" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    await api(app, R.shares(id), ownerCookie, {
      method: "PUT",
      body: { email, role: "viewer" },
    });
    await api(app, R.share(id, email), ownerCookie, { method: "DELETE" });
    expect(await exists(m.userId)).toBe(true);
  });
});

describe("login code sweep", () => {
  it("deletes expired codes only", async () => {
    const now = Date.now();
    await insertCode(`old-${tag}`, now - 1);
    await insertCode(`live-${tag}`, now + 60_000);
    await sweepLoginCodes(env, now);
    const left = await env.DB.prepare(
      "select request_id r from login_codes where email_key = ? order by r",
    )
      .bind(`ek-${tag}`)
      .all<{ r: string }>();
    expect(left.results.map((x) => x.r)).toEqual([`live-${tag}`]);
  });

  it("runs in the daily cron", async () => {
    await insertCode(`cron-${tag}`, Date.now() - 1);
    const waits: Promise<unknown>[] = [];
    await scheduled({} as ScheduledController, env, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never);
    await Promise.all(waits);
    expect(
      await one<{ n: number }>(
        "select count(*) n from login_codes where request_id = ?",
        `cron-${tag}`,
      ),
    ).toEqual({ n: 0 });
  });
});
