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
  TEST_OTP_OUTCOMES,
  TEST_RUN_HEADER,
  TEST_RUN_TAG,
  TestAuditInputSchema,
  type TestAuditResult,
  TestCodeCapsResetInputSchema,
  TestDirectoryGroupsInputSchema,
  TestDirectoryHeldInputSchema,
  type TestHookRefusal,
  type TestOtpOutcome,
  TestPeoplePurgeInputSchema,
  type TestPeoplePurgeResult,
  TestSessionInputSchema,
} from "@oa/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { emailKey, ipKey } from "../auth/codes.js";
import { authConfig } from "../auth/config.js";
import { signSession } from "../auth/session.js";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin, toErrorResponse } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { type GrantProps, oauthProvider } from "../mcp/oauth.js";
import { oauthApi } from "../mcp/oauth-api.js";
import { oauthEnv } from "../mcp/oauth-store.js";
import { mcpResource } from "../mcp/server.js";
import type { AppType } from "../routes/index.js";
import { revokeUserLive } from "../runtime/revoke.js";
import { purgeNow } from "../services/artifacts.js";
import { SYNC_DO_NAME } from "../services/directory.js";
import {
  eraseMember,
  removeMember,
  SYSTEM_ACTOR,
} from "../services/members.js";
import { getUserWithEpoch, insertUser, toMember } from "../services/users.js";
import { b64urlEncode, sameKey } from "../util/crypto.js";
import { type HookEnv, testHooksOn } from "./on.js";
import { OTP_WAIT_CAP_MS } from "./otp-wait.js";

// /__test/* (P2 T14): hooks P5's cross-tenant suite uses against stg-a and
// stg-b. Release builds drop this module (`hooks` in app.ts folds to
// false). At runtime it is on only when the build allows it
// (TEST_HOOKS_ALLOWED) AND TEST_HOOKS=1 AND a 32+ char TEST_HOOK_KEY AND a
// TEST_DOMAIN. POST /__test/audit reads back test_hook.* audit rows only
// (never any other event). Order per request: the key compared, then the rate
// limit (a wrong key: RL_ANON; a right one: RL_HOOKS, else RL_ANON; RL_ANON
// unbound is a refusal), then the input. Every refusal is the standard 404, and every
// call past the rate limit writes one audit_events row. Before the key
// verifies the 404 is uniform (no reason); after it, the 404 body's
// error.details.reason says why (TEST_HOOK_REFUSALS, a fixed enum).

const OTP_TTL_S = 600;

export { testHooksOn };

// Cloudflare's always-pass Turnstile TEST secret. With it, siteverify
// answers { success: true, hostname: "example.com", metadata:
// { result_with_testing_key: true } } (no action) for the dummy token, which
// the strict check refuses. (Cloudflare's docs show hostname "localhost" and
// action "test"; the live API doesn't.) The red-line installs run it, so this
// module (dropped from release builds) accepts an answer carrying Cloudflare's
// own test-key marker only while hooks are live AND the configured secret is
// exactly this one.
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

/** True only for the test secret's answer on a live-hook install configured with exactly that secret. */
export function turnstileTestKeyPass(
  env: HookEnv,
  secret: string,
  out: { success?: unknown; metadata?: unknown },
): boolean {
  const meta = out.metadata;
  return (
    testHooksOn(env) &&
    secret === TURNSTILE_TEST_SECRET &&
    out.success === true &&
    typeof meta === "object" &&
    meta !== null &&
    (meta as { result_with_testing_key?: unknown }).result_with_testing_key ===
      true
  );
}

const domainOf = (email: string) => email.split("@")[1];

/** True only for a normalized address exactly under TEST_DOMAIN. */
const inTestDomain = (env: Env, email: string) =>
  domainOf(email) === env.TEST_DOMAIN;

// The plaintext copy of a TEST_DOMAIN code, and the last code-send outcome
// for that address, in D1 (strongly consistent: a KV miss is cached at the
// PoP, so a poll before the send kept missing after it). One row per
// address, keyed by its HMAC (never the address). `code` is set only with
// outcome "sent", after the email went out, so a code read back proves the
// send. Created on first use like AUDIT_DDL, so no migration (and the release
// build, which drops this module, never has the table). Rows past OTP_TTL_S
// are swept on every write.
const OTP_DDL =
  "CREATE TABLE IF NOT EXISTS `test_otps` (`ek` text PRIMARY KEY NOT NULL, `code` text, `outcome` text NOT NULL, `at` integer NOT NULL) WITHOUT ROWID";
// One row per address: a second request nulls the earlier sent code (pending,
// then e.g. resend_wait), so red-line never re-requests one address within 60 s.
const OTP_UPSERT = `insert into test_otps (ek, code, outcome, at) values (?1, ?2, ?3, ?4)
  on conflict (ek) do update set code = excluded.code, outcome = excluded.outcome, at = excluded.at`;
const OTP_SWEEP = "delete from test_otps where at < ?1";
const OTP_USED =
  "update test_otps set code = null, outcome = 'used', at = ?2 where ek = ?1";
const OTP_READ = "select code, outcome, at from test_otps where ek = ?1";

/**
 * While hooks are on, for TEST_DOMAIN only: records `outcome` for the
 * address, with the plaintext code only when it is "sent". Never throws (a
 * failed write logs test_hook.otp_note_failed and leaves delivery alone).
 */
export async function noteTestOtp(
  env: Env,
  email: string,
  ek: string,
  outcome: TestOtpOutcome,
  code?: string,
): Promise<void> {
  const to = normalizeEmail(email);
  if (!testHooksOn(env) || !to || !inTestDomain(env, to)) return;
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(OTP_DDL),
      env.DB.prepare(OTP_SWEEP).bind(now - OTP_TTL_S * 1000),
      env.DB.prepare(OTP_UPSERT).bind(
        ek,
        outcome === "sent" ? (code ?? null) : null,
        outcome,
        now,
      ),
    ]);
  } catch {
    log("otp_note_failed");
    return;
  }
  await signalOtp(env, ek);
}

/**
 * Drops the plaintext copy once the code is used (the outcome becomes
 * "used"). TEST_DOMAIN only. Never throws, so a D1 failure can't fail the
 * verify that called it.
 */
export async function forgetTestOtp(env: Env, email: string, ek: string) {
  const to = normalizeEmail(email);
  if (!testHooksOn(env) || !to || !inTestDomain(env, to)) return;
  try {
    await env.DB.batch([
      env.DB.prepare(OTP_DDL),
      env.DB.prepare(OTP_USED).bind(ek, Date.now()),
    ]);
  } catch {
    log("otp_note_failed");
    return;
  }
  await signalOtp(env, ek);
}

/** The install's one DirectorySync DO: it holds the otp/latest wait signal (otp-wait.ts). */
const syncDo = (env: Env) =>
  env.DIRECTORY_SYNC?.get(env.DIRECTORY_SYNC.idFromName(SYNC_DO_NAME));

/** The row for `ek` changed: wakes the hook holding a request on it. Never throws. */
async function signalOtp(env: Env, ek: string): Promise<void> {
  try {
    await syncDo(env)?.testOtpChanged(ek);
  } catch {
    log("otp_signal_failed");
  }
}

/** The sent code for `ek`, or why there is none. */
async function readTestOtp(
  env: Env,
  ek: string,
): Promise<{ code: string } | { outcome: TestOtpOutcome }> {
  const res = await env.DB.batch([
    env.DB.prepare(OTP_DDL),
    env.DB.prepare(OTP_READ).bind(ek),
  ]);
  const row = res.at(-1)?.results[0] as
    | { code: string | null; outcome: string; at: number }
    | undefined;
  if (!row) return { outcome: "none" };
  if (row.outcome === "sent" && row.code) {
    return Date.now() - row.at < OTP_TTL_S * 1000
      ? { code: row.code }
      : { outcome: "expired" };
  }
  const known = TEST_OTP_OUTCOMES.find((o) => o === row.outcome);
  return { outcome: known && known !== "sent" ? known : "none" };
}

const notFound = () => toErrorResponse(new ApiError("not_found", "Not found"));
/** A refusal after the key verified: the same 404, plus a fixed-enum reason. */
const refused = (
  reason: TestHookRefusal,
  extra: { outcome?: TestOtpOutcome } = {},
) =>
  toErrorResponse(new ApiError("not_found", "Not found", { reason, ...extra }));
const log = (evt: string) =>
  console.log(JSON.stringify({ evt: `test_hook.${evt}` }));
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

type HookName =
  | "session"
  | "otp_latest"
  | "oauth_client"
  | "audit"
  | "code_caps_reset"
  | "directory_groups"
  | "directory_held"
  | "people_purge"
  | "unknown";
type Outcome = "ok" | "denied" | "refused" | "none" | "error";

// A function, never a top-level table: only called from mountTestHooks, so
// release builds (TEST_HOOKS_ALLOWED false) drop it and every /__test/* path.
const hookName = (path: string): HookName =>
  path === TEST_HOOKS.session
    ? "session"
    : path === TEST_HOOKS.otpLatest
      ? "otp_latest"
      : path === TEST_HOOKS.oauthClient
        ? "oauth_client"
        : path === TEST_HOOKS.audit
          ? "audit"
          : path === TEST_HOOKS.codeCapsReset
            ? "code_caps_reset"
            : path === TEST_HOOKS.directoryGroups
              ? "directory_groups"
              : path === TEST_HOOKS.directoryHeld
                ? "directory_held"
                : path === TEST_HOOKS.peoplePurge
                  ? "people_purge"
                  : "unknown";

// directory_groups seed: `test-` ids with an email exactly under TEST_DOMAIN
// only, enforced here in SQL too (no LIKE wildcards), so a handler slip can't
// write or rewrite a real group. An existing row is updated only when its id
// is itself prefixed. ?1 id, ?2 email, ?3 domain.
const GROUP_UPSERT = `insert into directory_groups (group_id, email)
  select ?1, ?2
  where substr(?1, 1, 5) = 'test-'
    and substr(?2, length(?2) - length(?3)) = '@' || ?3
  on conflict (group_id) do update set email = excluded.email
    where substr(directory_groups.group_id, 1, 5) = 'test-'`;

/** Upserts the prefixed groups in one batch; how many rows wrote. */
async function seedDirectoryGroups(
  env: Env,
  groups: { groupId: string; email: string }[],
): Promise<number> {
  const res = await env.DB.batch(
    groups.map((g) =>
      env.DB.prepare(GROUP_UPSERT).bind(
        g.groupId,
        g.email,
        env.TEST_DOMAIN ?? "",
      ),
    ),
  );
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// directory_held: only a suite group, i.e. a `test-` id whose
// directory_groups row carries exactly this TEST_DOMAIN email (the
// directory-groups hook seeds it). Enforced here in SQL too (no LIKE
// wildcards). ?1 id, ?2 email, ?3 domain.
const SUITE_GROUP = `select 1 from directory_groups
  where group_id = ?1 and email = ?2
    and substr(?1, 1, 5) = 'test-'
    and substr(?2, length(?2) - length(?3)) = '@' || ?3`;

const suiteGroup = async (env: Env, groupId: string, email: string) =>
  (await env.DB.prepare(SUITE_GROUP)
    .bind(groupId, email, env.TEST_DOMAIN ?? "")
    .first()) !== null;

// The caller's own per-IP code buckets (auth/codes.ts takeRequestSlot and
// verify), by its ipKey: exactly these two keys, never a prefix match, so no
// other IP's buckets, no per-address bucket and no pool counter is touched.
// D1 (strongly consistent): the next code request sees the reset.
const CODE_CAPS_DELETE = "delete from counters where key in (?1, ?2)";

/** Deletes the caller's code:ip and code:fail buckets; how many rows went. */
async function resetCodeCaps(env: Env, ip: string): Promise<number> {
  const ik = await ipKey(env, ip);
  const r = await env.DB.prepare(CODE_CAPS_DELETE)
    .bind(`code:ip:${ik}`, `code:fail:${ik}`)
    .run();
  return r.meta.changes ?? 0;
}

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
// event can ever leave through it. ?1 since (ms), ?2 the cap, ?3 the run tag
// (null: the rows no suite tagged; a tag: that suite's own rows).
const TEST_AUDIT_READ = `select action, at, actor_id as actorId, target_id as targetId, detail
  from audit_events
  where actor_kind = 'test_hook' and substr(action, 1, 10) = 'test_hook.' and at >= ?1
    and json_extract(detail, '$.run') is ?3
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

/** test_hook.* rows at or after `since` (of `run`'s suite, or of none), newest first, at most TEST_AUDIT_LIMIT. */
async function readTestAudit(
  env: Env,
  since: number,
  run: string | null,
): Promise<TestAuditResult> {
  const res = await env.DB.batch([
    ...AUDIT_DDL.map((s) => env.DB.prepare(s)),
    env.DB.prepare(TEST_AUDIT_READ).bind(since, TEST_AUDIT_LIMIT, run),
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
async function auditRow(
  env: Env,
  hook: HookName,
  ip: string,
  outcome: Outcome,
  o: { email?: string; userId?: string; run?: string } = {},
): Promise<void> {
  const detail: Record<string, string> = { hook, ip, outcome };
  if (o.email !== undefined) detail.domain = domainOf(o.email) ?? "";
  if (o.run !== undefined) detail.run = o.run;
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

// people_purge (#2680): T19's people only. The prefix (?1, `t19-`, checked by
// the schema) and TEST_DOMAIN (?2) are both enforced here in SQL with substr
// (no LIKE wildcards), never the owner by role or by address (?3), never an
// erased row. ?4 created before (ms), ?5 the cap.
const PURGE_MATCH = `from users
  where substr(email, 1, length(?1)) = ?1
    and substr(email, 1, 4) = 't19-'
    and substr(email, length(email) - length(?2)) = '@' || ?2
    and role <> 'owner' and email <> ?3
    and erased_at is null and created_at < ?4`;
const PURGE_PICK = `select id, status ${PURGE_MATCH} order by created_at limit ?5`;
const PURGE_LEFT = `select count(*) as n ${PURGE_MATCH}`;
const PERSONAL_ARTIFACTS = "select id from artifacts where space_id = ?";

/**
 * Erases up to `limit` matching people, oldest first: purges every artifact
 * in their personal space (trashed ones too: erase refuses while any is
 * left), removes them, then erases them, all as SYSTEM_ACTOR. A person that
 * fails is counted and skipped.
 */
async function purgePeople(
  env: Env,
  input: { prefix: string; before: number; limit: number },
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
): Promise<TestPeoplePurgeResult> {
  const args = [
    input.prefix,
    env.TEST_DOMAIN ?? "",
    normalizeEmail(env.OWNER_EMAIL ?? "") ?? "",
    input.before,
  ] as const;
  const { results: people } = await env.DB.prepare(PURGE_PICK)
    .bind(...args, input.limit)
    .all<{ id: string; status: string }>();
  let erased = 0;
  let failed = 0;
  for (const p of people) {
    try {
      const { results: arts } = await env.DB.prepare(PERSONAL_ARTIFACTS)
        .bind(p.id)
        .all<{ id: string }>();
      for (const a of arts) await purgeNow(env, a.id);
      if (p.status !== "removed")
        await removeMember(env, p.id, SYSTEM_ACTOR, ctx);
      await eraseMember(env, p.id, SYSTEM_ACTOR, ctx);
      erased++;
    } catch (e) {
      failed++;
      console.log(
        JSON.stringify({
          evt: "test_hook.people_purge_failed",
          id: p.id,
          e: String(e),
        }),
      );
    }
  }
  const left = await env.DB.prepare(PURGE_LEFT)
    .bind(...args)
    .first<{ n: number }>();
  return { erased, failed, left: left?.n ?? 0 };
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
  // This install's OAuth store (OAUTH_STORE), shared by both calls below.
  const env = oauthEnv(c.env);
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
    // No limiter bound means refuse: a wrong or absent key is charged to
    // RL_ANON below, so without it nothing is safe to compare.
    const anon = env.RL_ANON;
    if (!anon) return notFound();
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const hook = hookName(c.req.path);
    const given = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const keyed = await sameKey(given, env.TEST_HOOK_KEY as string);
    // A suite's own tag, taken only from a call whose key verified (a wrong key
    // cannot hide its rows from the unfiltered read).
    const tag = c.req.header(TEST_RUN_HEADER) ?? "";
    const run = keyed && TEST_RUN_TAG.test(tag) ? tag : undefined;
    const audit = (
      e: Env,
      h: HookName,
      from: string,
      outcome: Outcome,
      o: { email?: string; userId?: string } = {},
    ) => auditRow(e, h, from, outcome, run ? { ...o, run } : o);
    // A wrong or absent key spends RL_ANON (30 a minute) as it always did, so
    // guessing stays capped. A right key spends RL_HOOKS (the suites' own,
    // much larger budget); without that binding it spends RL_ANON as before.
    const key = `test:${authConfig(env).installKey}:${ip}`;
    const limiter = keyed ? (env.RL_HOOKS ?? anon) : anon;
    if (!(await limiter.limit({ key })).success) {
      log("limited");
      return notFound();
    }
    if (!keyed) {
      await audit(env, hook, ip, "denied");
      return notFound();
    }
    if (c.req.method !== "POST" || hook === "unknown") {
      await audit(env, hook, ip, "refused");
      return refused("bad_route");
    }
    const body = await c.req.json().catch(() => ({}));

    if (hook === "session") {
      const input = TestSessionInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return refused("bad_input");
      }
      const { email: raw, role, spaces = [] } = input.data;
      const email = normalizeEmail(raw);
      const no = async (reason: TestHookRefusal) => {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return refused(reason);
      };
      // Every input check, the spaces' kinds included, runs before
      // testUser, so a refusal writes nothing.
      if (!email || !spacesValid(spaces)) return no("bad_input");
      if (await spacesBlocked(env, spaces)) return no("spaces_blocked");
      const user = await testUser(env, email, role);
      if (!user) return no("user_refused");
      if (!(await grantSpaces(env, user.id, spaces)))
        return no("grant_refused");
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
        return refused("bad_input");
      }
      const ek = await emailKey(env, email);
      // `wait`: while the send is "pending", hold the request until its row
      // changes (the DO's signal) or the bound: never a repeated read on a
      // timer. A read that is already final never calls the DO.
      const waitMs = Math.min(
        input.success ? (input.data.wait ?? 0) : 0,
        OTP_WAIT_CAP_MS,
      );
      const deadline = Date.now() + waitMs;
      let got = await readTestOtp(env, ek);
      const holding =
        waitMs > 0 && !("code" in got) && got.outcome === "pending";
      const sync = holding ? syncDo(env) : undefined;
      while (
        sync &&
        !("code" in got) &&
        got.outcome === "pending" &&
        deadline > Date.now()
      ) {
        // The change number is taken before the read that decides to wait, so
        // a change between them wakes the wait at once.
        const since = await sync.testOtpVersion(ek).then(
          (v) => v,
          () => undefined,
        );
        if (since === undefined) break;
        got = await readTestOtp(env, ek);
        if ("code" in got || got.outcome !== "pending") break;
        const woke = await sync
          .testOtpWait(ek, since, deadline - Date.now())
          .then(
            () => true,
            () => false,
          );
        if (!woke) break;
        got = await readTestOtp(env, ek);
      }
      await audit(env, hook, ip, "code" in got ? "ok" : "none", { email });
      return "code" in got
        ? c.json({ code: got.code })
        : refused("no_code", { outcome: got.outcome });
    }

    if (hook === "code_caps_reset") {
      // Strictly `{}`: a body naming an IP or a key is refused.
      if (!TestCodeCapsResetInputSchema.safeParse(body).success || !ip) {
        await audit(env, hook, ip, "refused");
        return refused("bad_input");
      }
      const reset = await resetCodeCaps(env, ip);
      await audit(env, hook, ip, "ok");
      return c.json({ reset });
    }

    if (hook === "directory_groups") {
      const input = TestDirectoryGroupsInputSchema.safeParse(body);
      const groups = input.success
        ? input.data.groups.map((g) => ({
            groupId: g.groupId,
            email: normalizeEmail(g.email),
          }))
        : [];
      if (
        !input.success ||
        new Set(groups.map((g) => g.groupId)).size !== groups.length ||
        groups.some((g) => !g.email || !inTestDomain(env, g.email))
      ) {
        await audit(env, hook, ip, "refused");
        return refused("bad_input");
      }
      const seeded = await seedDirectoryGroups(
        env,
        groups as { groupId: string; email: string }[],
      );
      await audit(env, hook, ip, "ok");
      return c.json({ seeded });
    }

    if (hook === "directory_held") {
      const input = TestDirectoryHeldInputSchema.safeParse(body);
      const email = input.success ? normalizeEmail(input.data.email) : null;
      const ns = env.DIRECTORY_SYNC;
      if (
        !input.success ||
        !email ||
        !inTestDomain(env, email) ||
        !ns ||
        !(await suiteGroup(env, input.data.groupId, email))
      ) {
        await audit(env, hook, ip, "refused", email ? { email } : {});
        return refused("bad_input");
      }
      // A throw is a write the D1 held list never showed (testHold's
      // confirm): an error, never a held/released answer.
      const held = await ns
        .get(ns.idFromName(SYNC_DO_NAME))
        .testHold(input.data.groupId, email, input.data.held)
        .catch(() => null);
      if (held === null) {
        await audit(env, hook, ip, "error", { email });
        throw new ApiError("internal", "directory-held unavailable");
      }
      await audit(env, hook, ip, "ok", { email });
      return c.json({ held });
    }

    if (hook === "people_purge") {
      const input = TestPeoplePurgeInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return refused("bad_input");
      }
      const out = await purgePeople(env, input.data, execCtx(c));
      await audit(env, hook, ip, "ok");
      return c.json(out);
    }

    if (hook === "audit") {
      const input = TestAuditInputSchema.safeParse(body);
      if (!input.success) {
        await audit(env, hook, ip, "refused");
        return refused("bad_input");
      }
      // Read first, then audit this call like any other hook: the response
      // is the log as it stood, and this call's own row shows up next time.
      const out = await readTestAudit(
        env,
        input.data.since,
        input.data.run ?? null,
      );
      await audit(env, hook, ip, "ok");
      return c.json(out);
    }

    const email = oauthHookEmail(env);
    const user = normalizeEmail(email)
      ? await testUser(env, email, "member")
      : null;
    if (!user) {
      await audit(env, hook, ip, "refused", { email });
      return refused("user_refused");
    }
    const out = await oauthClientFor(c, user);
    await audit(env, hook, ip, "ok", { email, userId: user.id });
    return c.json(out);
  });
}
