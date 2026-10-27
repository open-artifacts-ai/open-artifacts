// P3 T18: informational staleness, the 24 h browser session cap while sync
// is unhealthy, customer_mismatch failing closed for synced users, and the
// org owner's break-glass during a mismatch.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AUTH, type InstanceDirectory, R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { signContent } from "../src/content/signing.js";
import { type Health, HK, NEVER } from "../src/directory/health.js";
import { UPSERT } from "../src/directory/store.js";
import { BACKOFF_MIN_MS, SyncEngine } from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { revokeFanoutCap } from "../src/runtime/revoke.js";
import { publish } from "../src/services/artifacts.js";
import { SYNC_DO_NAME } from "../src/services/directory.js";
import { getUser } from "../src/services/users.js";
import { contentCall } from "./assets-stub.js";
import { mailer, seedUser, uniq } from "./auth-helpers.js";
import {
  connect as connectDirectory,
  directEnv,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { fakeGoogle } from "./fixtures/fake-google.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { connect as mcpConnect, oauthToken, tool } from "./mcp-helpers.js";

const app = createApp();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let mail: ReturnType<typeof mailer>;
let e: Env;

const one = <T>(q: string, ...a: unknown[]) =>
  env.DB.prepare(q)
    .bind(...a)
    .first<T>();

/** Writes DirectorySync's health rows as the engine would. */
const setHealth = (h: Partial<Health>) => {
  const v: Health = { ...NEVER, ...h };
  return env.DB.batch([
    env.DB.prepare(UPSERT).bind(HK.health, JSON.stringify(v)),
    env.DB.prepare(UPSERT).bind(HK.state, v.state),
  ]);
};
const unhealthyFor = (ms: number, state: Health["state"] = "backoff") =>
  setHealth({
    state,
    unhealthySince: Date.now() - ms,
    lastSuccessAt: Date.now() - ms,
  });
const mismatch = () =>
  setHealth({
    state: "customer_mismatch",
    unhealthySince: Date.now() - MIN,
    lastSuccessAt: Date.now() - 2 * MIN,
    customerMismatch: { expected: "C0123", actual: "C-other" },
  });

/** A user bound to the directory (identities.directory_bound = 1). */
async function synced(role: "owner" | "admin" | "member" = "member") {
  const email = uniq(`st-${role}`);
  const sub = `g-${crypto.randomUUID()}`;
  const id = await seedUser(email, role, { googleSub: sub });
  await env.DB.prepare(
    "update identities set directory_bound = 1 where provider = 'google' and subject = ?",
  )
    .bind(sub)
    .run();
  return { id, email, sub };
}

/** A session cookie for `uid`, issued `age` ms ago. */
async function cookieFor(
  uid: string,
  o: {
    age?: number;
    p?: "google" | "code" | "access";
    t?: string;
    /** Google sessions: a forced re-authentication at sign-in (default true). */
    forced?: boolean;
  } = {},
) {
  const ep =
    (
      await one<{ e: number }>(
        "select session_epoch e from users where id = ?",
        uid,
      )
    )?.e ?? 0;
  const p = o.p ?? "google";
  const iat = Date.now() - (o.age ?? 0);
  return `${sessionCookieName(env)}=${await signSession(env, uid, iat, {
    provider: p,
    epoch: ep,
    ...(p === "google" && o.forced !== false ? { authAt: iat } : {}),
    ...(p === "access" || ("t" in o && o.t === undefined)
      ? {}
      : { tenant: o.t ?? "a.com" }),
  })}`;
}

/** Calls the app on `e` as a cookie or PAT (oa_pat_...). */
function call(
  path: string,
  auth: string | null,
  init: { method?: string; env?: Env } = {},
) {
  const headers: Record<string, string> = { "x-oa-request": "1" };
  if (auth?.startsWith("oa_pat_")) headers.authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
    }),
    init.env ?? e,
  );
}

const meDirectory = async (cookie: string) =>
  (
    (await (await call(R.me, cookie)).json()) as {
      instance: { directory?: InstanceDirectory };
    }
  ).instance.directory;

async function artifactOf(uid: string) {
  const m = await getUser(env, uid);
  if (!m) throw new Error("no user");
  return (
    await publish(
      env,
      m,
      {
        title: "t18",
        format: "html",
        entry: "index.html",
        files: { "index.html": "<p>t18</p>" },
        visibility: "private",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
}

/** The content URL bound to `uid` for artifact `id`, served now. */
async function content(id: string, uid: string) {
  const row = await one<{ e: number }>(
    "select session_epoch e from users where id = ?",
    uid,
  );
  const { prefix } = await signContent(env, id, 1, Date.now(), 600, "frame", {
    uid,
    epoch: row?.e ?? 0,
  });
  return (await contentCall(`${prefix}__view`)).status;
}

const breakGlassAudits = async (uid: string) =>
  (
    await one<{ n: number }>(
      "select count(*) n from audit_events where action = 'directory.break_glass' and actor_id = ?",
      uid,
    )
  )?.n ?? 0;

/** When the user's UserPresence recorded a revocation (0: never). */
async function revokedAt(uid: string) {
  const ns = env.USER_PRESENCE as NonNullable<Env["USER_PRESENCE"]>;
  return runInDurableObject(ns.get(ns.idFromName(uid)), (_i, s) => {
    try {
      return Number(
        s.storage.sql
          .exec("select revoked_at from state where id = 1")
          .toArray()[0]?.revoked_at ?? 0,
      );
    } catch {
      return 0;
    }
  });
}

beforeEach(async () => {
  await resetDirectory();
  mail = mailer();
  e = directEnv(mail.env);
});
afterEach(() => vi.restoreAllMocks());

describe("staleness is informational", () => {
  it("7 days + 1 min since success: staleAt is reported but access is unchanged (no stale cutoff)", async () => {
    const u = await synced();
    const owner = await synced("owner");
    const at = Date.now() - 7 * DAY - MIN;
    await setHealth({
      state: "backoff",
      unhealthySince: at,
      lastSuccessAt: at,
    });
    expect((await call(R.me, await cookieFor(u.id))).status).toBe(200);
    const d = await meDirectory(await cookieFor(owner.id));
    expect(d?.staleAt).toBe(new Date(at + 7 * DAY).toISOString());
  });

  it("stale: open sockets stay open and /c/ still serves (access unchanged)", async () => {
    const u = await synced();
    const art = await artifactOf(u.id);
    const at = Date.now() - 8 * DAY;
    await setHealth({
      state: "auth_failed",
      unhealthySince: at,
      lastSuccessAt: at,
    });
    expect(await content(art, u.id)).toBe(200);
    expect((await call(R.artifact(art), await cookieFor(u.id))).status).toBe(
      200,
    );
    // Staleness writes no revocation: the user's presence has none.
    expect(await revokedAt(u.id)).toBe(0);
  });

  it("6 d 23 h: staleAt is null", async () => {
    const owner = await synced("owner");
    const at = Date.now() - 6 * DAY - 23 * HOUR;
    await setHealth({
      state: "backoff",
      unhealthySince: at,
      lastSuccessAt: at,
    });
    const d = await meDirectory(await cookieFor(owner.id));
    expect(d?.state).toBe("backoff");
    expect(d?.staleAt).toBeNull();
  });

  it("manual member and OTP guest unaffected", async () => {
    await unhealthyFor(30 * DAY);
    const manual = await login(uniq("manual"));
    expect((await call(R.me, manual.cookie)).status).toBe(200);
    const old = await cookieFor(manual.userId, { age: 25 * HOUR, p: "access" });
    expect((await call(R.me, old)).status).toBe(200);
    const guest = await seedUser(uniq("otp", "x.com"), "guest");
    const otp = await cookieFor(guest, {
      age: 25 * HOUR,
      p: "code",
      t: undefined,
    });
    expect((await call(R.me, otp)).status).toBe(200);
    // A customer_mismatch never touches them either.
    await mismatch();
    expect((await call(R.me, old)).status).toBe(200);
    expect((await call(R.me, otp)).status).toBe(200);
  });
});

describe("the 24 h browser session cap while unhealthy", () => {
  it("unhealthy 61 min: cookie session 25 h old → 401; 23 h old → 200", async () => {
    const u = await synced();
    await unhealthyFor(61 * MIN);
    const old = await cookieFor(u.id, { age: 25 * HOUR });
    expect((await call(R.me, old)).status).toBe(401);
    expect(
      (await call(R.me, await cookieFor(u.id, { age: 23 * HOUR }))).status,
    ).toBe(200);
    // Unhealthy under an hour: no cap yet.
    await unhealthyFor(59 * MIN);
    expect((await call(R.me, old)).status).toBe(200);
  });

  it("unhealthy: a 30-day-old PAT and MCP grant still work; me.instance.directory.health.tokensUnverified is true for owners", async () => {
    const u = await synced();
    const { id, token } = await createPat(env, u.id, "old");
    await env.DB.prepare("update tokens set created_at = ? where id = ?")
      .bind(Date.now() - 30 * DAY, id)
      .run();
    const agentEmail = uniq("agent");
    const agent = await login(agentEmail);
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(`g-${crypto.randomUUID()}`, agent.userId, Date.now())
      .run();
    const { accessToken } = await oauthToken(agentEmail, "Old Agent", agent);
    await unhealthyFor(2 * DAY);
    expect((await call(R.me, token)).status).toBe(200);
    const c = await mcpConnect(accessToken);
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);
    await c.close();
    const owner = await synced("owner");
    const d = await meDirectory(await cookieFor(owner.id));
    expect(d?.tokensUnverified).toBe(true);
    expect(d?.banner).toBe(true);
  });

  it("stale synced user's PAT and MCP OAuth grant keep access on every SURFACES entry", async () => {
    const email = uniq("stale-agent");
    const u = await login(email);
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(`g-${crypto.randomUUID()}`, u.userId, Date.now())
      .run();
    const art = await artifactOf(u.userId);
    const { token } = await createPat(env, u.userId, "stale");
    const { accessToken } = await oauthToken(email, "Stale Agent", u);
    await unhealthyFor(8 * DAY);
    for (const path of [
      R.me,
      R.artifacts,
      R.artifact(art),
      R.versions(art),
      `${R.search}?q=t18`,
    ])
      expect((await call(path, token)).status, path).toBe(200);
    expect(await content(art, u.userId)).toBe(200);
    const c = await mcpConnect(accessToken);
    for (const [name, args] of [
      ["list_artifacts", {}],
      ["get_artifact", { id: art }],
      ["search_artifacts", { q: "t18" }],
    ] as const)
      expect((await tool(c, name, args)).isError, name).toBeFalsy();
    await c.close();
  });
});

describe("customer_mismatch fails closed for synced users", () => {
  it("cookie, PAT, MCP grant and /c/ refused at once; manual users keep access; access returns with the state", async () => {
    const email = uniq("mm");
    const u = await login(email);
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(`g-${crypto.randomUUID()}`, u.userId, Date.now())
      .run();
    const art = await artifactOf(u.userId);
    const { token } = await createPat(env, u.userId, "mm");
    const { accessToken } = await oauthToken(email, "MM Agent", u);
    await mismatch();
    expect((await call(R.me, u.cookie)).status).toBe(401);
    expect((await call(R.me, token)).status).toBe(401);
    expect(await content(art, u.userId)).toBe(404);
    await expect(mcpConnect(accessToken)).rejects.toThrow();
    expect(await getUser(env, u.userId)).toBeNull();
    // The next successful sync: no manual step.
    await setHealth({ state: "ok", lastSuccessAt: Date.now() });
    expect((await call(R.me, u.cookie)).status).toBe(200);
    expect((await call(R.me, token)).status).toBe(200);
    expect(await content(art, u.userId)).toBe(200);
  });
});

describe("break-glass", () => {
  /** A Google sign-in through the app as `owner`, optionally ?reauth=1. */
  async function googleSignIn(
    owner: { id: string; email: string },
    o: { reauth: boolean; authTime?: number },
  ) {
    const google = await fakeGoogle();
    try {
      const sub = (
        await one<{ s: string }>(
          "select subject s from identities where user_id = ?",
          owner.id,
        )
      )?.s;
      const start = await call(
        `${AUTH.loginGoogle}?next=%2F${o.reauth ? "&reauth=1" : ""}`,
        null,
      );
      const u = new URL(start.headers.get("location") ?? "");
      const state =
        start.headers
          .getSetCookie()
          .find((c) => /oa_oidc_/.test(c))
          ?.split(";")[0] ?? "";
      const code = google.issueCode(
        {
          nonce: u.searchParams.get("nonce"),
          sub,
          email: owner.email,
          ...(o.authTime !== undefined
            ? { auth_time: Math.floor(o.authTime / 1000) }
            : {}),
        },
        u.searchParams.get("code_challenge") as string,
      );
      const back = await fetchAndWait(
        app,
        new Request(
          `http://app.localhost${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
          { headers: { cookie: state } },
        ),
        e,
      );
      const session = back.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${sessionCookieName(env)}=`))
        ?.split(";")[0];
      if (!session) throw new Error("no session");
      return { authorize: u, session };
    } finally {
      google.restore();
    }
  }

  it("break-glass: the reauth sign-in asks Google for max_age=0; its session opens only the break-glass routes", async () => {
    const owner = await synced("owner");
    await mismatch();
    const { authorize, session } = await googleSignIn(owner, {
      reauth: true,
      authTime: Date.now() - MIN,
    });
    expect(authorize.searchParams.get("max_age")).toBe("0");
    expect((await call(R.directory, session)).status).toBe(200);
    expect((await call(R.me, session)).status).toBe(401);
  });

  it("break-glass: a silent SSO is not enough (no reauth, or an old or missing auth_time)", async () => {
    const owner = await synced("owner");
    await mismatch();
    const plain = await googleSignIn(owner, {
      reauth: false,
      authTime: Date.now(),
    });
    expect(plain.authorize.searchParams.get("max_age")).toBeNull();
    const old = await googleSignIn(owner, {
      reauth: true,
      authTime: Date.now() - 2 * 3600_000,
    });
    const none = await googleSignIn(owner, { reauth: true });
    for (const s of [plain.session, old.session, none.session]) {
      const r = await call(R.directory, s);
      expect(r.status).toBe(401);
      expect((await errOf(r)).code).toBe("reauth_required");
    }
    // A cookie without the forced re-authentication mark: the same.
    const unforced = await call(
      R.directory,
      await cookieFor(owner.id, { age: MIN, forced: false }),
    );
    expect((await errOf(unforced)).code).toBe("reauth_required");
  });

  it("break-glass: fresh Google sign-in (9 min) reaches R.directory; 11 min → 401 reauth_required", async () => {
    const owner = await synced("owner");
    await mismatch();
    const fresh = await cookieFor(owner.id, { age: 9 * MIN });
    const r = await call(R.directory, fresh);
    expect(r.status).toBe(200);
    // No binding with sync.state customer_mismatch (as after a disconnect
    // during one): the status says why synced users are denied.
    expect(((await r.json()) as SyncStatus).state).toBe("customer_mismatch");
    const old = await call(
      R.directory,
      await cookieFor(owner.id, { age: 11 * MIN }),
    );
    expect(old.status).toBe(401);
    expect((await errOf(old)).code).toBe("reauth_required");
    // A non-owner synced user is just anonymous there.
    const m = await synced();
    const anon = await call(R.directory, await cookieFor(m.id, { age: MIN }));
    expect(anon.status).toBe(401);
    expect((await errOf(anon)).code).not.toBe("reauth_required");
  });

  it("break-glass: OTP session refused; artifact, data and member routes refused", async () => {
    const owner = await synced("owner");
    const art = await artifactOf(owner.id);
    await mismatch();
    const otp = await call(
      R.directory,
      await cookieFor(owner.id, { p: "code", t: undefined }),
    );
    expect(otp.status).toBe(401);
    expect((await errOf(otp)).code).toBe("reauth_required");
    const fresh = await cookieFor(owner.id, { age: MIN });
    expect((await call(R.artifacts, fresh)).status).toBe(401);
    expect((await call(R.members, fresh)).status).toBe(401);
    const meR = await call(R.me, fresh);
    expect(meR.status).toBe(401);
    // Me tells the owner to use break-glass (and audits that use).
    expect((await errOf(meR)).code).toBe("break_glass_required");
    expect((await call(R.artifact(art), fresh)).status).toBe(404);
    expect((await call(R.dataCollection(art, "notes"), fresh)).status).toBe(
      404,
    );
    expect(await breakGlassAudits(owner.id)).toBe(1);
  });

  it("break-glass: one audit per route a minute, the first always; one email per session, even for parallel first requests", async () => {
    const owner = await synced("owner");
    await mismatch();
    const toOwner = () => mail.sent.filter((m) => m.to === owner.email);
    const fresh = await cookieFor(owner.id, { age: MIN });
    await env.DB.prepare(
      "insert or replace into settings (key, value) values ('name', 'Acme')",
    ).run();
    const first = await Promise.all([
      call(R.directory, fresh),
      call(R.directory, fresh),
      call(R.directory, fresh),
      call(R.directory, fresh),
    ]);
    expect(first.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await breakGlassAudits(owner.id)).toBe(1);
    expect(
      (await call(R.directorySync, fresh, { method: "POST" })).status,
    ).toBe(202);
    expect(await breakGlassAudits(owner.id)).toBe(2);
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0]?.text).toContain("Google Workspace mismatch");
    expect(toOwner()[0]?.text).not.toContain("\u2014");
    // The shared sender names the install.
    expect(toOwner()[0]?.from).toEqual({
      email: "noreply@mail.example.com",
      name: "Acme via Open Artifacts",
    });
    await env.DB.prepare("delete from settings where key = 'name'").run();
    // A minute later the same route is audited again.
    await env.DB.prepare(
      "update audit_events set at = at - 61000 where action = 'directory.break_glass' and actor_id = ?",
    )
      .bind(owner.id)
      .run();
    expect((await call(R.directory, fresh)).status).toBe(200);
    expect(await breakGlassAudits(owner.id)).toBe(3);
    // A new sign-in is a new session: audited and one more email.
    const again = await cookieFor(owner.id, { age: 2 * MIN });
    expect((await call(R.directory, again)).status).toBe(200);
    expect(await breakGlassAudits(owner.id)).toBe(4);
    expect(toOwner()).toHaveLength(2);
  });

  it("break-glass: a failed email send gives the slot back; the next use retries", async () => {
    const owner = await synced("owner");
    await mismatch();
    const fresh = await cookieFor(owner.id, { age: MIN });
    const broken = mailer(true);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await call(R.directory, fresh, { env: directEnv(broken.env) })).status,
    ).toBe(200);
    expect(broken.sent).toHaveLength(0);
    expect(
      errs.mock.calls.some((c) =>
        String(c[0]).includes("break_glass_email_unsent"),
      ),
    ).toBe(true);
    expect((await call(R.directory, fresh)).status).toBe(200);
    expect(mail.sent.filter((m) => m.to === owner.email)).toHaveLength(1);
  });

  it("break-glass: confirm and cancel resolve the owner (audited)", async () => {
    const owner = await synced("owner");
    await mismatch();
    const fresh = await cookieFor(owner.id, { age: MIN });
    const confirm = await call(R.directoryConfirm, fresh, { method: "POST" });
    // Resolved: the route's own answer (nothing pending), never a 401.
    expect(confirm.status).not.toBe(401);
    expect(
      (await call(R.directoryCancel, fresh, { method: "POST" })).status,
    ).not.toBe(401);
    expect(await breakGlassAudits(owner.id)).toBe(2);
    // The same routes without break-glass (a stale sign-in): 401.
    const old = await cookieFor(owner.id, { age: 11 * MIN });
    for (const p of [R.directoryConfirm, R.directoryCancel])
      expect((await call(p, old, { method: "POST" })).status, p).toBe(401);
  });

  it("break-glass: a synced org admin stays anonymous; a Google session without hd is refused", async () => {
    const admin = await synced("admin");
    await mismatch();
    const r = await call(R.directory, await cookieFor(admin.id, { age: MIN }));
    expect(r.status).toBe(401);
    expect((await errOf(r)).code).not.toBe("reauth_required");
    expect(await breakGlassAudits(admin.id)).toBe(0);
    const owner = await synced("owner");
    const noHd = await call(
      R.directory,
      await cookieFor(owner.id, { age: MIN, t: undefined }),
    );
    expect(noHd.status).toBe(401);
    expect((await errOf(noHd)).code).toBe("reauth_required");
    expect(await breakGlassAudits(owner.id)).toBe(0);
  });
});

describe("DirectorySync marks staleness (P3 T18)", () => {
  let g: FakeDirectory;
  const stub = () => {
    const ns = env.DIRECTORY_SYNC as NonNullable<Env["DIRECTORY_SYNC"]>;
    return ns.get(
      ns.idFromName(SYNC_DO_NAME),
    ) as unknown as DurableObjectStub<DirectorySync>;
  };
  const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
    runInDurableObject(stub(), (_i, s) => f(s));
  const alarm = (now: number) =>
    inDo((s) => new SyncEngine(e, s.storage).alarm(now));
  async function drain(now: number) {
    for (let i = 0; i < 80; i++) {
      await alarm(now);
      if (!(await inDo((s) => new SyncEngine(e, s.storage).due(now)))) return;
    }
    throw new Error("run never finished");
  }
  const staleAudits = async () =>
    (
      await one<{ n: number }>(
        "select count(*) n from audit_events where action = 'directory.stale'",
      )
    )?.n ?? 0;
  const status = async (cookie: string) =>
    (await (await call(R.directory, cookie)).json()) as SyncStatus;

  beforeEach(async () => {
    await inDo(async (s) => {
      for (const t of ["kv", "seen", "dirty", "held"])
        s.storage.sql.exec(`delete from ${t}`);
      await s.storage.deleteAlarm();
    });
    await registerInstall();
    g = fakeDirectory();
  });

  /** A connected directory with one synced member; the first run done at t0. */
  async function connectedWithMember() {
    const ownerEmail = uniq("st-own");
    const owner = { ...(await login(ownerEmail, "owner")), email: ownerEmail };
    const adminSub = `g-admin-${crypto.randomUUID()}`;
    g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
    const sub = `g-m-${crypto.randomUUID()}`;
    const email = uniq("st-m");
    g.addUser({ id: sub, primaryEmail: email });
    const t0 = Date.now();
    expect(
      (await connectDirectory(e, owner.cookie, g, { sub: adminSub })).ok,
    ).toBe(true);
    await drain(t0);
    const bound = await one<{ id: string }>(
      "select user_id id from identities where provider = 'google' and subject = ? and directory_bound = 1",
      sub,
    );
    if (!bound) throw new Error("not bound");
    return { owner, adminSub, bound, t0 };
  }

  it("success after stale clears staleAt; access never changed", async () => {
    const { owner, bound, t0 } = await connectedWithMember();
    const before = await staleAudits();
    // Google down from now on; the first failing alarm past 7 days marks it.
    g.fail(/./, 503, { times: 1000 });
    await alarm(t0 + 7 * DAY - MIN);
    expect((await status(owner.cookie)).staleAt).toBeNull();
    expect(await staleAudits()).toBe(before);
    await alarm(t0 + 7 * DAY + 31 * MIN);
    expect((await status(owner.cookie)).staleAt).toBe(
      new Date(t0 + 7 * DAY).toISOString(),
    );
    expect(await staleAudits()).toBe(before + 1);
    await alarm(t0 + 7 * DAY + 62 * MIN);
    expect(await staleAudits()).toBe(before + 1);
    // Access unchanged while stale: no status change, no revocation.
    expect(await getUser(env, bound.id)).not.toBeNull();
    expect(
      (await call(R.me, await cookieFor(bound.id, { age: MIN }))).status,
    ).toBe(200);
    // Google back: success clears staleAt.
    g.clearFailures();
    await drain(t0 + 8 * DAY);
    expect((await status(owner.cookie)).staleAt).toBeNull();
    expect(await getUser(env, bound.id)).not.toBeNull();
  });

  it("entering customer_mismatch closes synced users' sockets; the next success restores access with no manual step", async () => {
    const { adminSub, bound, t0 } = await connectedWithMember();
    expect(await revokedAt(bound.id)).toBe(0);
    const admin = g.users.get(adminSub) as { customerId?: string };
    admin.customerId = "C-OTHER";
    await drain(t0 + 2 * MIN);
    expect(await getUser(env, bound.id)).toBeNull();
    await vi.waitFor(async () =>
      expect(await revokedAt(bound.id)).toBeGreaterThan(0),
    );
    admin.customerId = g.customerId;
    await drain(t0 + 63 * MIN);
    expect(await getUser(env, bound.id)).not.toBeNull();
  });

  it("the customer_mismatch close pages past revokeFanoutCap: every synced user is signalled", async () => {
    const { adminSub, bound, t0 } = await connectedWithMember();
    const cap = revokeFanoutCap(e);
    const extra: string[] = [];
    for (let i = 0; i < cap + 5; i++) extra.push((await synced()).id);
    const admin = g.users.get(adminSub) as { customerId?: string };
    admin.customerId = "C-OTHER";
    // One page per alarm: the first in the mismatch run, the rest after.
    await alarm(t0 + 2 * MIN);
    expect(
      await inDo((s) => new SyncEngine(e, s.storage).due(t0 + 2 * MIN)),
    ).toBe(true);
    await drain(t0 + 2 * MIN);
    for (const id of [bound.id, ...extra])
      expect(await revokedAt(id), id).toBeGreaterThan(0);
  });

  /** Mismatch entered with cap + 5 extra synced users: the first page is done. */
  async function mismatchPaging() {
    const { adminSub, bound, t0 } = await connectedWithMember();
    const all = [bound.id];
    for (let i = 0; i < revokeFanoutCap(e) + 5; i++)
      all.push((await synced()).id);
    (g.users.get(adminSub) as { customerId?: string }).customerId = "C-OTHER";
    const at = t0 + 2 * MIN;
    await alarm(at);
    expect(await inDo((s) => new SyncEngine(e, s.storage).due(at))).toBe(true);
    return { all, at };
  }
  const signalled = async (ids: string[]) =>
    (await Promise.all(ids.map(revokedAt))).filter((n) => n > 0).length;

  it("a D1 error while paging the close backs off instead of re-arming at once", async () => {
    const { at } = await mismatchPaging();
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare")
          return (q: string) => {
            if (/u\.id > \?1/.test(q)) throw new Error("D1 down");
            return t.prepare(q);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const broken = { ...e, DB } as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const next = await inDo(async (s) => {
      await new SyncEngine(broken, s.storage).alarm(at + 1000);
      return s.storage.getAlarm();
    });
    expect(next).toBe(at + 1000 + BACKOFF_MIN_MS);
  });

  it("the close stops paging once the state leaves customer_mismatch", async () => {
    const { all, at } = await mismatchPaging();
    const cap = revokeFanoutCap(e);
    expect(await signalled(all)).toBeLessThanOrEqual(cap);
    // A reconnect, reset or success moved the state on.
    await env.DB.prepare(
      "insert or replace into directory_state (key, value) values ('sync.state', 'ok')",
    ).run();
    await alarm(at + 1000);
    const after = await signalled(all);
    await alarm(at + 2000);
    expect(await signalled(all)).toBe(after);
    expect(after).toBeLessThan(all.length);
  });
});
