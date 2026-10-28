// #475: anything done TO an org owner or admin (role change, removal,
// suspension) is owner-only; admins keep managing members and guests. The
// rule is enforced in the write SQL too, so a target promoted between the
// precheck and the batch is refused with nothing written or audited.
import { env } from "cloudflare:workers";
import { type CapReason, type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withCap } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { oauthApi } from "../src/mcp/oauth-api.js";
import {
  patchMember,
  removeMember,
  setUserStatus,
} from "../src/services/members.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const tag = newId().slice(0, 6).toLowerCase();
const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;

type Row = { role: string; status: string; e: number } | null;
const rowOf = (id: string) =>
  env.DB.prepare("select role, status, session_epoch e from users where id = ?")
    .bind(id)
    .first<Row>();
const audits = async (id: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from audit_events where target_id = ?",
    )
      .bind(id)
      .first<{ n: number }>()
  )?.n;
const livePats = async (id: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from tokens where user_id = ? and revoked_at is null",
    )
      .bind(id)
      .first<{ n: number }>()
  )?.n;

let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };

/** Actors as getUser loads them: with their cap (null = uncapped). */
const as = (
  who: { userId: string },
  role: Member["role"],
  cap: CapReason | null = null,
) => withCap({ id: who.userId, role } as Member, cap);
let ownerA: Member;
let adminA: Member;
let cappedOwner: Member;

beforeAll(async () => {
  owner = await login(`oo-owner-${tag}@x.com`, "owner");
  admin = await login(`oo-admin-${tag}@x.com`, "admin");
  ownerA = as(owner, "owner");
  adminA = as(admin, "admin");
  cappedOwner = as(owner, "owner", "restricted");
});

const mk = (p: string, role: "member" | "admin" | "guest" | "owner") =>
  login(`${p}-${newId().slice(0, 4).toLowerCase()}-${tag}@x.com`, role);

/**
 * `env` whose next D1 batch first promotes `id` to admin: the race between
 * the precheck (the target was a member) and the guarded write.
 */
function promotingBefore(base: Env, id: string): Env {
  let raced = false;
  const db = new Proxy(base.DB, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      if (k !== "batch") return v.bind(t);
      return async (s: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await t
            .prepare("update users set role = 'admin' where id = ?")
            .bind(id)
            .run();
        }
        return t.batch(s);
      };
    },
  });
  return { ...base, DB: db } as Env;
}

/** Gives `userId` one OAuth grant (KV), as an agent connection would. */
async function grant(userId: string): Promise<void> {
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
}

/** The target's row, PATs, audit trail and OAuth grants, before and after. */
const snapshot = async (id: string) => ({
  row: await rowOf(id),
  pats: await livePats(id),
  audits: await audits(id),
  grants: (await oauthApi(env).listUserGrants(id)).items.length,
});

type Path = {
  name: string;
  run: (e: Env, id: string, actor: Member) => Promise<unknown>;
  /** The base env (spaces on or off). */
  env: Env;
  /** What a successful call leaves. */
  done: (id: string) => Promise<void>;
};

const PATHS: Path[] = [
  {
    name: "patchMember (role change)",
    env,
    run: (e, id, a) => patchMember(e, id, { role: "member" }, a, ctx),
    done: async (id) => expect((await rowOf(id))?.role).toBe("member"),
  },
  {
    name: "removeMember, spaces off (status removed, parity 1)",
    env,
    run: (e, id, a) => removeMember(e, id, a, ctx),
    done: async (id) => expect((await rowOf(id))?.status).toBe("removed"),
  },
  {
    name: "removeMember, spaces on (status removed)",
    env: SPACES,
    run: (e, id, a) => removeMember(e, id, a, ctx),
    done: async (id) => expect((await rowOf(id))?.status).toBe("removed"),
  },
  {
    name: "setUserStatus (suspension)",
    env: SPACES,
    run: (e, id, a) =>
      setUserStatus(e, id, "suspended", "admin_suspend", a, ctx),
    done: async (id) => expect((await rowOf(id))?.status).toBe("suspended"),
  },
];

describe.each(PATHS)("$name", (p) => {
  it("admin → admin: 403 owner_only, nothing written or audited", async () => {
    const t = await mk("oo-aa", "admin");
    await createPat(env, t.userId, "t");
    const before = await snapshot(t.userId);
    await expect(p.run(p.env, t.userId, adminA)).rejects.toMatchObject({
      code: "owner_only",
    });
    expect(await snapshot(t.userId)).toEqual(before);
  });

  it("admin → owner: 403 owner_only", async () => {
    const t = await mk("oo-ao", "owner");
    const before = await snapshot(t.userId);
    await expect(p.run(p.env, t.userId, adminA)).rejects.toMatchObject({
      code: "owner_only",
    });
    expect(await snapshot(t.userId)).toEqual(before);
  });

  it("owner → admin: allowed", async () => {
    const t = await mk("oo-oa", "admin");
    await p.run(p.env, t.userId, ownerA);
    await p.done(t.userId);
  });

  it("admin → member: allowed", async () => {
    // A guest for the role change, so the patch to member changes the row.
    const t = await mk("oo-am", p.run === PATHS[0]?.run ? "guest" : "member");
    await p.run(p.env, t.userId, adminA);
    await p.done(t.userId);
  });

  it("a capped owner → admin: 403 owner_only (manageAdmins needs uncapped)", async () => {
    const t = await mk("oo-ca", "admin");
    const before = await snapshot(t.userId);
    await expect(p.run(p.env, t.userId, cappedOwner)).rejects.toMatchObject({
      code: "owner_only",
    });
    expect(await snapshot(t.userId)).toEqual(before);
  });

  it("target promoted to admin between the precheck and the batch: 403 owner_only, nothing written or audited", async () => {
    const t = await mk("oo-race", "member");
    await createPat(env, t.userId, "t");
    // OAuth grants are revoked only after the gated batch (#553): untouched.
    await grant(t.userId);
    const before = await snapshot(t.userId);
    expect(before.grants).toBe(1);
    await expect(
      p.run(promotingBefore(p.env, t.userId), t.userId, adminA),
    ).rejects.toMatchObject({ code: "owner_only" });
    expect(await snapshot(t.userId)).toEqual({
      ...before,
      row: { ...before.row, role: "admin" },
    });
  });
});

describe("OAuth grants after the gated batch (#553)", () => {
  it.each([
    ["spaces off", env],
    ["spaces on", SPACES],
  ] as const)(
    "a removal that goes through still revokes them (%s)",
    async (_, e) => {
      const t = await mk("oo-grant", "member");
      await grant(t.userId);
      await removeMember(e, t.userId, adminA, ctx);
      expect((await oauthApi(env).listUserGrants(t.userId)).items).toEqual([]);
    },
  );
});

describe("routes (#475)", () => {
  const call = (path: string, cookie: string, method: string, body?: unknown) =>
    app.fetch(
      new Request(`http://app.localhost${path}`, {
        method,
        headers: {
          "x-oa-request": "1",
          cookie,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      ctx,
    );
  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it("PATCH and DELETE R.member on an admin: 403 owner_only for an admin, allowed for the owner", async () => {
    const t = await mk("oo-route", "admin");
    const patch = await call(R.member(t.userId), admin.cookie, "PATCH", {
      role: "member",
    });
    expect(patch.status).toBe(403);
    expect(await code(patch)).toBe("owner_only");
    const del = await call(R.member(t.userId), admin.cookie, "DELETE");
    expect(del.status).toBe(403);
    expect(await code(del)).toBe("owner_only");
    expect((await rowOf(t.userId))?.role).toBe("admin");
    const ok = await call(R.member(t.userId), owner.cookie, "PATCH", {
      role: "member",
    });
    expect(ok.status).toBe(200);
    expect(
      (await call(R.member(t.userId), admin.cookie, "DELETE")).status,
    ).toBe(204);
  });

  it("a capped admin (a code session outside the verified domains) gets 404 on the members routes", async () => {
    const t = await mk("oo-capped", "member");
    const cookie = `${sessionCookieName(env)}=${await signSession(
      env,
      admin.userId,
      Date.now(),
      { provider: "code", epoch: 0 },
    )}`;
    expect((await call(R.members, cookie, "GET")).status).toBe(404);
    expect(
      (await call(R.member(t.userId), cookie, "PATCH", { role: "admin" }))
        .status,
    ).toBe(404);
    expect((await call(R.member(t.userId), cookie, "DELETE")).status).toBe(404);
    expect(
      (await call(R.memberIdentity(t.userId, "google"), cookie, "DELETE"))
        .status,
    ).toBe(404);
    expect((await rowOf(t.userId))?.role).toBe("member");
    // The same admin, uncapped, still lists members.
    expect((await call(R.members, admin.cookie, "GET")).status).toBe(200);
  });
});
