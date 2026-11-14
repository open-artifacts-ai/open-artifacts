import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import { admit } from "../src/services/identity.js";
import { direct, uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";
import { oauthToken } from "./mcp-helpers.js";

// #2458: tokens, agent grants, invites, settings changes and exports are
// audited in the change's own batch, with ids only: never a secret or address.

const app = createApp();

type Row = {
  action: string;
  actor_kind: string;
  actor_id: string | null;
  actor_cred_kind: string | null;
  actor_cred_id: string | null;
  target_type: string;
  target_id: string;
  detail: string;
};
const rows = async (action: string, target?: string) =>
  (
    await env.DB.prepare(
      `select * from audit_events where action = ?1 and (?2 is null or target_id = ?2) order by at, id`,
    )
      .bind(action, target ?? null)
      .all<Row>()
  ).results;
const total = async (action: string) =>
  (
    (await env.DB.prepare(
      "select count(*) n from audit_events where action = ?",
    )
      .bind(action)
      .first<{ n: number }>()) as { n: number }
  ).n;

const FAIL =
  "create trigger if not exists audit_fail before insert on audit_events begin select raise(abort, 'audit down'); end";
afterEach(async () => {
  await env.DB.prepare("drop trigger if exists audit_fail").run();
});

/** No secret, address or token may sit in a stored row. */
const clean = (r: Row | undefined, secrets: string[]) => {
  const all = JSON.stringify(r);
  for (const s of secrets) expect(all).not.toContain(s);
  expect(all).not.toMatch(/@/);
};

let owner: { cookie: string; userId: string };
let member: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(uniq("ev-owner"), "owner");
  member = await login(uniq("ev-member"));
});

describe("personal access tokens", () => {
  it("create and revoke by session: ids and label, never the secret", async () => {
    const r = await api(app, R.tokens, member.cookie, {
      method: "POST",
      body: { label: "ci box" },
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as { id: string; token: string };
    const [c] = await rows("token.create", t.id);
    expect(c).toMatchObject({
      actor_kind: "user",
      actor_id: member.userId,
      actor_cred_kind: "session",
      target_type: "token",
    });
    expect(JSON.parse(c?.detail ?? "")).toEqual({ label: "ci box" });
    clean(c, [t.token, member.cookie]);

    const d = await api(app, R.token(t.id), member.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    const [v] = await rows("token.revoke", t.id);
    expect(v).toMatchObject({
      actor_id: member.userId,
      actor_cred_kind: "session",
    });
    expect(JSON.parse(v?.detail ?? "")).toEqual({ label: "ci box" });
    clean(v, [t.token]);
  });

  it("a PAT revoking a token is recorded as pat", async () => {
    const u = await login(uniq("ev-pat"));
    const a = await createPat(env, u.userId, "a");
    const b = await createPat(env, u.userId, "b");
    const d = await api(app, R.token(b.id), a.token, { method: "DELETE" });
    expect(d.status).toBe(204);
    const [v] = await rows("token.revoke", b.id);
    expect(v).toMatchObject({ actor_cred_kind: "pat", actor_cred_id: a.id });
    clean(v, [a.token, b.token]);
  });

  it("failed changes write no row", async () => {
    const before = await total("token.revoke");
    const other = await login(uniq("ev-other"));
    const p = await createPat(env, other.userId, "x");
    // Not the caller's token, then an unknown one, then already revoked.
    expect(
      (await api(app, R.token(p.id), member.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.token(newId()), member.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.token(p.id), other.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (await api(app, R.token(p.id), other.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(await total("token.revoke")).toBe(before + 1);

    // Over the cap: no token, no row.
    const full = await login(uniq("ev-full"));
    for (let i = 0; i < 50; i++) await createPat(env, full.userId, `t${i}`);
    const created = await total("token.create");
    const r = await api(app, R.tokens, full.cookie, {
      method: "POST",
      body: { label: "one too many" },
    });
    expect(r.status).toBe(400);
    expect(await total("token.create")).toBe(created);
  });

  it("a failing audit insert fails the change", async () => {
    const u = await login(uniq("ev-atomic"));
    await env.DB.prepare(FAIL).run();
    const r = await api(app, R.tokens, u.cookie, {
      method: "POST",
      body: { label: "never" },
    });
    expect(r.status).toBe(500);
    const n = await env.DB.prepare(
      "select count(*) n from tokens where user_id = ?",
    )
      .bind(u.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("agent connections", () => {
  it("grant and revoke: grant id and client name, never the tokens", async () => {
    const t = await oauthToken(uniq("ev-agent"), "Audit Agent");
    const grantId = t.accessToken.split(":")[1] ?? "";
    expect(grantId).toBeTruthy();
    const [g] = await rows("agent.grant", grantId);
    expect(g).toMatchObject({
      actor_kind: "user",
      actor_id: t.member.userId,
      actor_cred_kind: "session",
      target_type: "agent_grant",
    });
    expect(JSON.parse(g?.detail ?? "")).toMatchObject({
      clientName: "Audit Agent",
    });
    clean(g, [t.accessToken, t.refreshToken, t.member.cookie]);

    // Someone else's revoke is a 404 and writes nothing.
    const other = await login(uniq("ev-agent-other"));
    expect(
      (
        await api(app, R.oauthClient(grantId), other.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(await rows("agent.revoke", grantId)).toHaveLength(0);

    const d = await api(app, R.oauthClient(grantId), t.member.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    const [v] = await rows("agent.revoke", grantId);
    expect(v).toMatchObject({
      actor_id: t.member.userId,
      actor_cred_kind: "session",
    });
    expect(JSON.parse(v?.detail ?? "")).toEqual({ clientName: "Audit Agent" });
    clean(v, [t.accessToken, t.refreshToken, t.member.cookie]);
  });
});

describe("invites", () => {
  it("create then accept: ids and role, never the address", async () => {
    const email = uniq("ev-invitee");
    const r = await api(app, R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const [c] = await rows("invite.create", id);
    expect(c).toMatchObject({
      actor_id: owner.userId,
      actor_cred_kind: "session",
      target_type: "invite",
    });
    expect(JSON.parse(c?.detail ?? "")).toEqual({ role: "member" });
    clean(c, [email]);

    // A duplicate is a 409 and writes nothing.
    const dup = await api(app, R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(dup.status).toBe(409);
    expect(await rows("invite.create", id)).toHaveLength(1);

    expect(await rows("invite.accept", id)).toHaveLength(0);
    const sub = `sub-${crypto.randomUUID()}`;
    const signIn = () =>
      admit(env, authConfig(direct()), {
        provider: "google",
        subject: sub,
        email,
        name: "I",
        tenant: "a.com",
      });
    expect((await signIn()).ok).toBe(true);
    const [a] = await rows("invite.accept", id);
    expect(a).toMatchObject({
      actor_id: id,
      actor_cred_kind: null,
      target_type: "invite",
    });
    expect(JSON.parse(a?.detail ?? "")).toEqual({ userId: id, role: "member" });
    clean(a, [email, sub]);

    // A later sign-in accepts nothing more.
    expect((await signIn()).ok).toBe(true);
    expect(await rows("invite.accept", id)).toHaveLength(1);
  });

  it("a member who was never invited records no accept", async () => {
    const before = await total("invite.accept");
    const m = await login(uniq("ev-plain"));
    await env.DB.prepare("update users set last_seen_at = ? where id = ?")
      .bind(Date.now(), m.userId)
      .run();
    expect(await total("invite.accept")).toBe(before);
  });
});

describe("instance settings", () => {
  it("records the keys that changed with old and new values", async () => {
    const name = `Name ${crypto.randomUUID().slice(0, 8)}`;
    const before = await total("settings.change");
    const r = await api(app, R.settings, owner.cookie, {
      method: "PATCH",
      body: { name, defaultVisibility: "team" },
    });
    expect(r.status).toBe(200);
    const last = (await rows("settings.change")).at(-1);
    expect(await total("settings.change")).toBe(before + 1);
    expect(last).toMatchObject({
      actor_id: owner.userId,
      actor_cred_kind: "session",
      target_type: "settings",
    });
    const d = JSON.parse(last?.detail ?? "") as {
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(d.changes.name?.to).toBe(name);
    expect(d.changes.defaultVisibility?.to).toBe("team");
    clean(last, [owner.cookie]);

    // The same values again change nothing and record nothing.
    await api(app, R.settings, owner.cookie, {
      method: "PATCH",
      body: { name, defaultVisibility: "team" },
    });
    expect(await total("settings.change")).toBe(before + 1);
    // Only the key that moved is named.
    await api(app, R.settings, owner.cookie, {
      method: "PATCH",
      body: { name, defaultVisibility: "private" },
    });
    const next = JSON.parse(
      (await rows("settings.change")).at(-1)?.detail ?? "",
    );
    expect(Object.keys(next.changes)).toEqual(["defaultVisibility"]);
    expect(next.changes.defaultVisibility).toEqual({
      from: "team",
      to: "private",
    });
  });

  it("a refused change writes no row", async () => {
    const before = await total("settings.change");
    expect(
      (
        await api(app, R.settings, owner.cookie, {
          method: "PATCH",
          body: { name: "   " },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, R.settings, member.cookie, {
          method: "PATCH",
          body: { name: "Mine" },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await total("settings.change")).toBe(before);
  });
});

describe("audit export", () => {
  it("records who exported and how many rows; reading records nothing", async () => {
    const before = await total("audit.export");
    expect((await api(app, R.audit, owner.cookie)).status).toBe(200);
    expect(await total("audit.export")).toBe(before);

    const r = await api(app, R.auditExport, owner.cookie);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(await total("audit.export")).toBe(before + 1);
    const last = (await rows("audit.export")).at(-1);
    expect(last).toMatchObject({
      actor_id: owner.userId,
      actor_cred_kind: "session",
      target_type: "audit",
    });
    const d = JSON.parse(last?.detail ?? "") as {
      rows: number;
      filters: unknown;
      continued: boolean;
    };
    expect(d.rows).toBeGreaterThan(0);
    // The count is of the log before this record; the stream adds it.
    expect(d.rows).toBe(body.trim().split("\n").length - 1);
    expect(d.filters).toEqual([]);
    expect(d.continued).toBe(false);
    clean(last, [owner.cookie]);
  });

  it("a refused export writes no row", async () => {
    const before = await total("audit.export");
    expect((await api(app, R.auditExport, member.cookie)).status).toBe(404);
    expect(await total("audit.export")).toBe(before);
  });
});
