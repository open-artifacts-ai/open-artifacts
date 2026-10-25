// P3 T18 follow-up: GET R.me tells the org owner refused by a directory
// customer_mismatch to use break-glass (401 break_glass_required { fresh }),
// audited as a break-glass use; every other refusal stays a plain 401.
import { env } from "cloudflare:workers";
import { BreakGlassRequiredDetailsSchema, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { type Health, HK, NEVER } from "../src/directory/health.js";
import { UPSERT } from "../src/directory/store.js";
import type { Env } from "../src/env.js";
import { mailer, seedUser, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
import { errOf, fetchAndWait } from "./helpers.js";

const app = createApp();
const MIN = 60_000;
let mail: ReturnType<typeof mailer>;
let e: Env;

const setHealth = (h: Partial<Health>) => {
  const v: Health = { ...NEVER, ...h };
  return env.DB.batch([
    env.DB.prepare(UPSERT).bind(HK.health, JSON.stringify(v)),
    env.DB.prepare(UPSERT).bind(HK.state, v.state),
  ]);
};
const mismatch = () =>
  setHealth({
    state: "customer_mismatch",
    unhealthySince: Date.now() - MIN,
    lastSuccessAt: Date.now() - 2 * MIN,
    customerMismatch: { expected: "C0123", actual: "C-other" },
  });

async function synced(role: "owner" | "admin" | "member") {
  const email = uniq(`bgme-${role}`);
  const sub = `g-${crypto.randomUUID()}`;
  const id = await seedUser(email, role, { googleSub: sub });
  await env.DB.prepare(
    "update identities set directory_bound = 1 where provider = 'google' and subject = ?",
  )
    .bind(sub)
    .run();
  return { id, email };
}

/** A Google session for `uid`, issued `age` ms ago; `forced`: a reauth sign-in. */
async function cookieFor(
  uid: string,
  o: { age?: number; forced?: boolean; maxAgeS?: number } = {},
) {
  const ep =
    (
      await env.DB.prepare("select session_epoch e from users where id = ?")
        .bind(uid)
        .first<{ e: number }>()
    )?.e ?? 0;
  const iat = Date.now() - (o.age ?? 0);
  return `${sessionCookieName(env)}=${await signSession(env, uid, iat, {
    provider: "google",
    tenant: "a.com",
    epoch: ep,
    ...(o.forced !== false ? { authAt: iat } : {}),
    ...(o.maxAgeS !== undefined ? { maxAgeS: o.maxAgeS } : {}),
  })}`;
}

const me = (cookie: string) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.me}`, { headers: { cookie } }),
    e,
  );
const audits = async (uid: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from audit_events where action = 'directory.break_glass' and actor_id = ? and json_extract(detail, '$.route') = 'GET /api/v1/me'",
    )
      .bind(uid)
      .first<{ n: number }>()
  )?.n ?? 0;
async function refusal(r: Response) {
  expect(r.status).toBe(401);
  return errOf(r);
}

beforeEach(async () => {
  await resetDirectory();
  mail = mailer();
  e = directEnv(mail.env);
});

describe("GET R.me during customer_mismatch", () => {
  it("the owner: fresh session → fresh: true; stale or plain SSO → fresh: false", async () => {
    const owner = await synced("owner");
    await mismatch();
    for (const [o, fresh] of [
      [{ age: MIN }, true],
      [{ age: 11 * MIN }, false],
      [{ age: MIN, forced: false }, false],
    ] as const) {
      const err = await refusal(await me(await cookieFor(owner.id, o)));
      expect(err.code).toBe("break_glass_required");
      expect(BreakGlassRequiredDetailsSchema.parse(err.details)).toEqual({
        fresh,
      });
    }
    // Me is not a break-glass route: no session email.
    expect(mail.sent).toHaveLength(0);
  });

  it("a synced admin or member gets a plain 401", async () => {
    await mismatch();
    for (const role of ["admin", "member"] as const) {
      const u = await synced(role);
      const err = await refusal(await me(await cookieFor(u.id)));
      expect(err.code).toBe("unauthorized");
      expect(err.details).toBeUndefined();
      expect(await audits(u.id)).toBe(0);
    }
  });

  it("no mismatch: Me is unchanged for the owner", async () => {
    const owner = await synced("owner");
    await setHealth({ state: "ok", lastSuccessAt: Date.now() });
    expect((await me(await cookieFor(owner.id))).status).toBe(200);
    expect(await audits(owner.id)).toBe(0);
  });

  it("a forged or expired cookie gets a plain 401", async () => {
    const owner = await synced("owner");
    await mismatch();
    const good = await cookieFor(owner.id);
    const forged = `${good.slice(0, -4)}AAAA`;
    const expired = await cookieFor(owner.id, { age: 2 * MIN, maxAgeS: 60 });
    for (const c of [forged, expired]) {
      const err = await refusal(await me(c));
      expect(err.code).toBe("unauthorized");
      expect(err.details).toBeUndefined();
    }
    expect(await audits(owner.id)).toBe(0);
  });

  it("audited as a break-glass use, once a minute per session (parallel requests too)", async () => {
    const owner = await synced("owner");
    await mismatch();
    const c = await cookieFor(owner.id);
    const rs = await Promise.all([me(c), me(c), me(c), me(c)]);
    expect(rs.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(await audits(owner.id)).toBe(1);
    await env.DB.prepare(
      "update audit_events set at = at - 61000 where action = 'directory.break_glass' and actor_id = ?",
    )
      .bind(owner.id)
      .run();
    await me(c);
    expect(await audits(owner.id)).toBe(2);
    // A new session: audited at once.
    await me(await cookieFor(owner.id, { age: 2 * MIN }));
    expect(await audits(owner.id)).toBe(3);
    expect(mail.sent).toHaveLength(0);
  });
});
