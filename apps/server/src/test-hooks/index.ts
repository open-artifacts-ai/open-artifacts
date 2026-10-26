import { normalizeEmail } from "@oa/auth-core";
import {
  type Member,
  newId,
  type OAuthClientHookResult,
  OtpLatestInputSchema,
  type Role,
  type SpaceRole,
  TEST_AUDIT_LIMIT,
  TEST_HOOKS,
  TEST_HOOKS_ALLOWED,
  TestAuditInputSchema,
  type TestAuditResult,
  TestSessionInputSchema,
} from "@oa/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { emailKey } from "../auth/codes.js";
import { authConfig } from "../auth/config.js";
import { signSession } from "../auth/session.js";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin, toErrorResponse } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { type GrantProps, oauthProvider } from "../mcp/oauth.js";
import { oauthApi } from "../mcp/oauth-api.js";
import { mcpResource } from "../mcp/server.js";
import type { AppType } from "../routes/index.js";
import { revokeUserLive } from "../runtime/revoke.js";
import { getUserWithEpoch, insertUser, toMember } from "../services/users.js";
import { b64urlEncode } from "../util/crypto.js";

// /__test/* (P2 T14): hooks P5's cross-tenant suite uses against stg-a and
// stg-b. Release builds drop this module (`hooks` in app.ts folds to
// false). At runtime it is on only when the build allows it
// (TEST_HOOKS_ALLOWED) AND TEST_HOOKS=1 AND a 32+ char TEST_HOOK_KEY AND a
// TEST_DOMAIN. POST /__test/audit reads back test_hook.* audit rows only
// (never any other event). Order per request: rate limit (RL_ANON; unbound is a refusal),
// then the key, then the input. Every refusal is the standard 404, and every
// call past the rate limit writes one audit_events row.

const MIN_KEY = 32;
const OTP_TTL_S = 600;

type HookEnv = Pick<
  Env,
  "TEST_HOOKS" | "TEST_HOOK_KEY" | "TEST_DOMAIN" | "RL_ANON"
>;

export function testHooksOn(env: HookEnv): boolean {
  return (
    TEST_HOOKS_ALLOWED &&
    env.TEST_HOOKS === "1" &&
    typeof env.TEST_HOOK_KEY === "string" &&
    env.TEST_HOOK_KEY.length >= MIN_KEY &&
    typeof env.TEST_DOMAIN === "string" &&
    env.TEST_DOMAIN.length > 0
  );
}

/** KV key of the plaintext OTP copy: never the address itself. */
export const otpKvKey = (installKey: string, ek: string) =>
  `test:otp:${installKey}:${ek}`;

const domainOf = (email: string) => email.split("@")[1];

/** True only for a normalized address exactly under TEST_DOMAIN. */
const inTestDomain = (env: Env, email: string) =>
  domainOf(email) === env.TEST_DOMAIN;

/** While hooks are on only: a plaintext copy of a TEST_DOMAIN code P5 can read back. */
export async function recordTestOtp(
  env: Env,
  email: string,
  ek: string,
  code: string,
) {
  if (!testHooksOn(env) || !inTestDomain(env, email)) return;
  await env.OAUTH_KV.put(otpKvKey(authConfig(env).installKey, ek), code, {
    expirationTtl: OTP_TTL_S,
  });
}

/** Drops the plaintext copy once the code is used. */
export async function forgetTestOtp(env: Env, ek: string) {
  if (!testHooksOn(env)) return;
  await env.OAUTH_KV.delete(otpKvKey(authConfig(env).installKey, ek));
}

async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= (u[i] as number) ^ (v[i] as number);
  return d === 0;
}

const notFound = () => toErrorResponse(new ApiError("not_found", "Not found"));
const log = (evt: string) =>
  console.log(JSON.stringify({ evt: `test_hook.${evt}` }));
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

type HookName = "session" | "otp_latest" | "oauth_client" | "audit" | "unknown";
type Outcome = "ok" | "denied" | "refused" | "none" | "error";

const hookName = (path: string): HookName =>
  path === TEST_HOOKS.session
    ? "session"
    : path === TEST_HOOKS.otpLatest
      ? "otp_latest"
      : path === TEST_HOOKS.oauthClient
        ? "oauth_client"
        : path === TEST_HOOKS.audit
          ? "audit"
          : "unknown";

// Same DDL as P3's audit_events (0009_spaces, also IF NOT EXISTS), so the
// rows land in the audit log on installs that predate that migration.
const AUDIT_DDL = [
  "CREATE TABLE IF NOT EXISTS `audit_events` (`id` text PRIMARY KEY NOT NULL, `at` integer NOT NULL, `actor_kind` text NOT NULL, `actor_id` text, `action` text NOT NULL, `target_type` text NOT NULL, `target_id` text, `space_id` text, `detail` text DEFAULT '{}' NOT NULL) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS `audit_events_at_idx` ON `audit_events` (`at`)",
];
const AUDIT_INSERT =
  "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, 'test_hook', ?, ?, 'test_hook', ?, ?)";

// The audit hook's read: test_hook rows only, enforced here in SQL (both the
// actor kind and the action prefix, no LIKE wildcards), so no other audit
// event can ever leave through it. ?1 since (ms), ?2 the cap.
const TEST_AUDIT_READ = `select action, at, actor_id as actorId, target_id as targetId, detail
  from audit_events
  where actor_kind = 'test_hook' and substr(action, 1, 10) = 'test_hook.' and at >= ?1
  order by at desc, id desc limit ?2`;

const parseDetail = (s: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** test_hook.* rows at or after `since`, newest first, at most TEST_AUDIT_LIMIT. */
async function readTestAudit(
  env: Env,
  since: number,
): Promise<TestAuditResult> {
  const res = await env.DB.batch([
    ...AUDIT_DDL.map((s) => env.DB.prepare(s)),
    env.DB.prepare(TEST_AUDIT_READ).bind(since, TEST_AUDIT_LIMIT),
  ]);
  const rows = (res.at(-1)?.results ?? []) as {
    action: string;
    at: number;
    actorId: string | null;
    targetId: string | null;
    detail: string;
  }[];
  return { events: rows.map((r) => ({ ...r, detail: parseDetail(r.detail) })) };
}

/** One audit row per hook call: hook, IP, outcome, and the email's domain (never the address). */
async function audit(
  env: Env,
  hook: HookName,
  ip: string,
  outcome: Outcome,
  o: { email?: string; userId?: string } = {},
): Promise<void> {
  const detail: Record<string, string> = { hook, ip, outcome };
  if (o.email !== undefined) detail.domain = domainOf(o.email) ?? "";
  await env.DB.batch([
    ...AUDIT_DDL.map((s) => env.DB.prepare(s)),
    env.DB.prepare(AUDIT_INSERT).bind(
      newId(),
      Date.now(),
      o.userId ?? null,
      `test_hook.${hook}`,
      hook,
      JSON.stringify(detail),
    ),
  ]);
  log(outcome === "ok" ? hook : outcome);
}

/**
 * A user the hooks may act on: TEST_DOMAIN only, never the owner (by address
 * or by role, so new users are capped at admin), and never a role change for
 * an existing user. Race-free: insert-if-absent, then judge the stored row,
 * so a concurrent writer can't slip a different role past the check. Null
 * means refuse.
 */
async function testUser(
  env: Env,
  email: string,
  role: Role,
): Promise<Member | null> {
  if (role === "owner") return null;
  if (!inTestDomain(env, email)) return null;
  if (email === normalizeEmail(env.OWNER_EMAIL ?? "")) return null;
  const now = Date.now();
  await insertUser(env, {
    email,
    name: email.split("@")[0] || email,
    role,
    createdAt: now,
    lastSeenAt: now,
  }).onConflictDoNothing();
  const row = await getDb(env)
    .select()
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (!row) return null;
  const { role: stored, status } = row;
  return stored === role && status === "active" ? toMember(row) : null;
}

type SpaceGrant = { spaceId: string; role: SpaceRole };
const MAX_SPACES = 20;
/**
 * Hook spaces only: every id the hook may create or grant on carries this
 * prefix (checked here and again in SQL). Personal space ids (newId) never do.
 */
const SPACE_ID = /^test-[A-Za-z0-9_-]{1,59}$/;

/** At most 20 grants, prefixed safe ids, each space once. */
const spacesValid = (spaces: SpaceGrant[]) =>
  spaces.length <= MAX_SPACES &&
  spaces.every((s) => SPACE_ID.test(s.spaceId)) &&
  new Set(spaces.map((s) => s.spaceId)).size === spaces.length;

// The SQL half of the rule, so a handler slip can't reach a real space:
// substr(id, 1, 5) = 'test-' (no LIKE wildcards), and no member whose email
// isn't exactly under TEST_DOMAIN. Plain literals (no calls), so the release
// build drops them with the rest of this module.
// Refused as a whole: an unprefixed id, a personal or deleted space, or a
// shared space with any member outside TEST_DOMAIN. ?1 ids (JSON), ?2 domain.
const SPACES_BLOCKED = `select 1 from json_each(?1) j
  where substr(j.value, 1, 5) <> 'test-'
    or exists (select 1 from spaces s where s.id = j.value
      and (s.kind <> 'shared' or s.deleted_at is not null
        or exists (select 1 from space_members fm join users fu on fu.id = fm.user_id
          where fm.space_id = s.id
            and substr(fu.email, length(fu.email) - length(?2)) <> '@' || ?2)))
  limit 1`;
const SPACE_CREATE = `insert into spaces (id, kind, name, all_members_role, public_links, created_at)
  select ?1, 'shared', ?2, null, 0, ?3 where substr(?1, 1, 5) = 'test-'
  on conflict (id) do nothing`;
// Conditional on a live, prefixed shared space with no member outside
// TEST_DOMAIN (?5), so a racing personal, deleted or real row is never
// joined. Always writes when the row exists, so changes = 0 means refused.
const MEMBER_UPSERT = `insert into space_members (space_id, user_id, role, source, created_at)
  select ?1, ?2, ?3, 'manual', ?4
  where substr(?1, 1, 5) = 'test-'
    and exists (select 1 from spaces where id = ?1 and kind = 'shared' and deleted_at is null)
    and not exists (select 1 from space_members fm join users fu on fu.id = fm.user_id
      where fm.space_id = ?1
        and substr(fu.email, length(fu.email) - length(?5)) <> '@' || ?5)
  on conflict (space_id, user_id, source) do update set role = excluded.role`;

const MANUAL_ROLES =
  "select space_id, role from space_members where user_id = ? and source = 'manual' and space_id in (select value from json_each(?))";
const RANK: Record<string, number> = { viewer: 1, editor: 2, manager: 3 };
const idsOf = (spaces: SpaceGrant[]) =>
  JSON.stringify(spaces.map((s) => s.spaceId));

/** True when a grant may not run (SPACES_BLOCKED). Read-only: runs before the user is created. */
async function spacesBlocked(env: Env, spaces: SpaceGrant[]): Promise<boolean> {
  if (spaces.length === 0) return false;
  const row = await env.DB.prepare(SPACES_BLOCKED)
    .bind(idsOf(spaces), env.TEST_DOMAIN ?? "")
    .first();
  return row !== null;
}

/**
 * P3 T17: creates any missing shared space and upserts the user's manual
 * space_members rows, in one batch. False (refuse) when a grant row didn't
 * write (after the check, its space was deleted, turned out personal, or
 * gained a member outside TEST_DOMAIN). A
 * lowered row closes the user's sockets.
 */
async function grantSpaces(
  env: Env,
  userId: string,
  spaces: SpaceGrant[],
): Promise<boolean> {
  if (spaces.length === 0) return true;
  const prior = await env.DB.prepare(MANUAL_ROLES)
    .bind(userId, idsOf(spaces))
    .all<{ space_id: string; role: string }>();
  const was = new Map(prior.results.map((r) => [r.space_id, r.role]));
  const lowered = spaces.some(
    (s) => (RANK[was.get(s.spaceId) ?? ""] ?? 0) > (RANK[s.role] ?? 0),
  );
  const now = Date.now();
  const res = await env.DB.batch(
    spaces.flatMap((s) => [
      env.DB.prepare(SPACE_CREATE).bind(s.spaceId, `Test ${s.spaceId}`, now),
      env.DB.prepare(MEMBER_UPSERT).bind(
        s.spaceId,
        userId,
        s.role,
        now,
        env.TEST_DOMAIN ?? "",
      ),
    ]),
  );
  // Every second result is a grant row.
  const allWritten = res.every((r, i) => i % 2 === 0 || r.meta.changes > 0);
  if (lowered) await revokeUserLive(env, userId, "space role lowered");
  return allWritten;
}

// A loopback redirect: the grant is completed server-side, nothing follows it.
const HOOK_REDIRECT = "http://127.0.0.1/p5-oauth-callback";

/** A registered client and an access token for `user`, via the real provider. */
async function oauthClientFor(
  c: Context<AppEnv>,
  user: Member,
): Promise<OAuthClientHookResult> {
  const env = c.env;
  const origin = appOrigin(env);
  const helpers = oauthApi(env);
  const client = await helpers.createClient({
    redirectUris: [HOOK_REDIRECT],
    tokenEndpointAuthMethod: "none",
    clientName: "P5 test hook",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const resource = mcpResource(env);
  const props: GrantProps = { userId: user.id, clientName: "P5 test hook" };
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri: HOOK_REDIRECT,
      scope: [],
      state: "p5",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource,
    },
    userId: user.id,
    metadata: { clientName: props.clientName },
    scope: [],
    props,
  });
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const noApp = { fetch: () => new Response(null, { status: 404 }) };
  const ctx = execCtx(c) ?? {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  };
  const res = await oauthProvider(env, noApp).fetch(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: HOOK_REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
        resource,
      }),
    }),
    env,
    ctx as ExecutionContext,
  );
  if (!res.ok) throw new ApiError("internal", "token exchange failed");
  const { access_token } = (await res.json()) as { access_token: string };
  return { clientId: client.clientId, accessToken: access_token };
}

/** The OAuth hook's member: one fixed address under TEST_DOMAIN. */
export const oauthHookEmail = (env: Pick<Env, "TEST_DOMAIN">) =>
  `p5-oauth@${env.TEST_DOMAIN}`;

/** Mounted before the session middleware; registers nothing unless the build allows hooks. */
export function mountTestHooks(app: AppType): void {
  if (!TEST_HOOKS_ALLOWED) return;
  app.all("/__test/*", async (c) => {
    const env = c.env;
    if (!testHooksOn(env)) return notFound();
    // Rate limit first, before any key work; no limiter bound means refuse.
    const rl = env.RL_ANON;
    if (!rl) return notFound();
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const limited = !(
      await rl.limit({ key: `test:${authConfig(env).installKey}:${ip}` })
    ).success;
    if (limited) {
      log("limited");
      return notFound();
    }
    const hook = hookName(c.req.path);
    const given = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!(await sameKey(given, env.TEST_HOOK_KEY as string))) {
      await audit(env, hook, ip, "denied");
      return notFound();
    }
    if (c.req.method !== "POST" || hook === "unknown") {
      await audit(env, hook, ip, "refused");
      return notFound();
    }
    const body = await c.req.json().catch(() => ({}));

    if (hook === "session") {
      const input = TestSessionInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return notFound();
      }
      const { email: raw, role, spaces = [] } = input.data;
      const email = normalizeEmail(raw);
      // Every input check, the spaces' kinds included, runs before
      // testUser, so a refusal writes nothing.
      const ok =
        !!email && spacesValid(spaces) && !(await spacesBlocked(env, spaces));
      const user = ok && email ? await testUser(env, email, role) : null;
      if (!user || !(await grantSpaces(env, user.id, spaces))) {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return notFound();
      }
      const row = await getUserWithEpoch(env, user.id);
      const cookie = await signSession(env, user.id, Date.now(), {
        provider: "test",
        epoch: row?.sessionEpoch ?? 0,
      });
      await audit(env, hook, ip, "ok", { email: user.email, userId: user.id });
      return c.json({ cookie });
    }

    if (hook === "otp_latest") {
      const input = OtpLatestInputSchema.safeParse(body);
      const email = input.success ? normalizeEmail(input.data.email) : null;
      if (!email || !inTestDomain(env, email)) {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return notFound();
      }
      const ek = await emailKey(env, email);
      const code = await env.OAUTH_KV.get(
        otpKvKey(authConfig(env).installKey, ek),
      );
      await audit(env, hook, ip, code ? "ok" : "none", { email });
      return code ? c.json({ code }) : notFound();
    }

    if (hook === "audit") {
      const input = TestAuditInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return notFound();
      }
      // Read first, then audit this call like any other hook: the response
      // is the log as it stood, and this call's own row shows up next time.
      const out = await readTestAudit(env, input.data.since);
      await audit(env, hook, ip, "ok");
      return c.json(out);
    }

    const email = oauthHookEmail(env);
    const user = normalizeEmail(email)
      ? await testUser(env, email, "member")
      : null;
    if (!user) {
      await audit(env, hook, ip, "refused", { email });
      return notFound();
    }
    const out = await oauthClientFor(c, user);
    await audit(env, hook, ip, "ok", { email, userId: user.id });
    return c.json(out);
  });
}
