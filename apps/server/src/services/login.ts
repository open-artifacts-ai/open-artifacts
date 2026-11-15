// Login for invited people (#2520): the ways in for one address, and the
// login settings (domains, joining rule) with the owner's proof of a domain.
import { normalizeEmail } from "@oa/auth-core";
import type { InviteReach, LoginSettings, LoginWay, Role } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import type { EffectivePlan } from "../billing/plan.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { USER_NOTICE_PREFIX } from "./notices.js";
import { inviteReach, type Reach } from "./reach.js";

/** LoginWay order, as the schema lists them. */
const ORDER: readonly LoginWay[] = [
  "google",
  "google_workspace",
  "google_after_code",
  "email_code",
];

/**
 * The ways in from what reachOf found. "google_after_code" waits for the code
 * step (slice 2), so it is never returned yet.
 */
export function waysOf(r: Reach): LoginWay[] {
  const ways = new Set<LoginWay>();
  if (r.methods.includes("google")) ways.add("google");
  else if (r.googleUncertain) ways.add("google_workspace");
  if (r.methods.includes("email")) ways.add("email_code");
  return ORDER.filter((w) => ways.has(w));
}

const REMOVED =
  "select role, status_changed_at as at from users where email = ?1 and status = 'removed' limit 1";

/**
 * InviteReach for one address: the ways in as the row an invite would create
 * (`role`), and `removed` when the address belongs to a removed person.
 * `email` must be normalized.
 */
export async function reachFor(
  env: Env,
  email: string,
  role: Role = "member",
): Promise<{ reach: InviteReach; raw: Reach }> {
  const raw = await inviteReach(env, email, role);
  const gone = await stmt(env.DB, REMOVED)
    .bind(email)
    .first<{ role: string; at: number | null }>();
  return {
    raw,
    reach: {
      ways: waysOf(raw),
      ...(gone
        ? { removed: { at: new Date(gone.at ?? 0).toISOString() } }
        : {}),
    },
  };
}

/** GET R.memberReach: `email` is the raw query value. */
export async function reachForQuery(
  env: Env,
  raw: string,
): Promise<InviteReach> {
  const email = normalizeEmail(raw);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  return (await reachFor(env, email)).reach;
}

const SEEN = "login_first_invite";
// Under the per-user notice prefix, which the install-wide settings read skips.
const seenKey = (userId: string) => `${USER_NOTICE_PREFIX}${userId}:${SEEN}`;

export async function markFirstInviteSeen(
  env: Env,
  userId: string,
): Promise<void> {
  await stmt(
    env.DB,
    "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
  )
    .bind(seenKey(userId), String(Date.now()))
    .run();
}

/**
 * Whether the instance may apply a login-settings change itself. Self-host sets
 * them in setup, and the hosted apply path needs a platform route that doesn't
 * exist yet, so never for now.
 */
export const loginEditable = (_env: Env): boolean => false;

/** Hosted Solo (or the pre-Solo free tier): login settings never apply there. */
export const soloPlan = (plan: EffectivePlan | null | undefined): boolean =>
  plan?.tier === "solo" || plan?.tier === "free";

/** GET R.loginSettings. `userId` is the caller. */
export async function loginSettings(
  env: Env,
  userId: string,
  plan: EffectivePlan | null = null,
): Promise<LoginSettings> {
  const cfg = authConfig(env);
  // Solo: no login domains, no joining; the owner can't change that.
  const solo = soloPlan(plan);
  const domains = solo ? [] : [...cfg.domains];
  const [seen, ident, joined] = await Promise.all([
    stmt(env.DB, "select 1 as x from settings where key = ?1")
      .bind(seenKey(userId))
      .first(),
    stmt(
      env.DB,
      "select tenant from identities where user_id = ?1 and provider = 'google' limit 1",
    )
      .bind(userId)
      .first<{ tenant: string }>(),
    domains.length === 0
      ? Promise.resolve({ n: 0 })
      : stmt(
          env.DB,
          `select count(*) as n from users where status = 'active'
            and lower(substr(email, instr(email, '@') + 1)) in (select value from json_each(?1))`,
        )
          .bind(JSON.stringify(domains))
          .first<{ n: number }>(),
  ]);
  return {
    domains,
    autoJoin: !solo && cfg.domainJoin === "member",
    editable: !solo && loginEditable(env),
    provable: ident?.tenant ? ident.tenant.toLowerCase() : null,
    joined: joined?.n ?? 0,
    firstInviteSeen: seen !== null,
  };
}

/**
 * The first domain in `domains` that isn't the verified tenant (hd) of the
 * owner's fresh login, or null when every one is proven (an empty list is).
 */
export function firstUnproven(
  domains: readonly string[],
  tenant: string | null | undefined,
): string | null {
  const t = tenant?.toLowerCase();
  return domains.find((d) => !t || d.trim().toLowerCase() !== t) ?? null;
}
