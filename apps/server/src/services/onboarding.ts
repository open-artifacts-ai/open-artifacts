// The first-run "Get started" checklist's state, install-wide, in the
// settings table: one row per flag, written once (the first time is kept).
// The dashboard derives each step from real data (a connection, an artifact,
// an invited member); the server keeps only what data cannot say: that the
// owner hid the list, and that every step was once done (so removing a
// member later never brings it back).

import {
  type Member,
  type MemberSetup,
  type Onboarding,
  type OnboardingPatch,
  setupSteps,
} from "@oa/shared";
import { isGuestRole, isInstanceOwner } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logWarn } from "../log.js";
import { WELCOME_TITLE, welcomeHtml } from "../onboarding/welcome.js";
import { publish } from "./artifacts.js";
import { busView } from "./bus.js";
import {
  askAnsweredKey,
  MENTION_STALLED_MS,
  mentionedKey,
  mentionRepliedKey,
  namedKey,
} from "./onboarding-firsts.js";
import { idpName } from "./users.js";

// #2632: every flag is per person, `onboarding:<flag>:<userId>`. The owner's
// install-wide rows from before (the four below) still read as the owner's, so
// nothing resets for an existing owner.
export const DISMISSED_KEY = "onboarding:dismissed";
export const COMPLETED_KEY = "onboarding:completed";

/** #2287: {userId, artifactId} of the seeded Welcome; written once, kept after a delete. Now per person (welcomeKey); this one is the owner's from before. */
export const WELCOME_KEY = "onboarding:welcome";
export const WELCOME_OPENED_KEY = "onboarding:welcome-opened";
export const dismissedKey = (userId: string) =>
  `onboarding:dismissed:${userId}`;
export const completedKey = (userId: string) =>
  `onboarding:completed:${userId}`;
export const welcomeKey = (userId: string) => `onboarding:welcome:${userId}`;
export const welcomeOpenedKey = (userId: string) =>
  `onboarding:welcome-opened:${userId}`;
/** Recorded once, when the person comments on an artifact another user owns. */
export const teamStepKey = (userId: string) => `onboarding:teamstep:${userId}`;
/** The id of whoever added the person (invite); absent for seeded and pre-existing members. */
export const invitedByKey = (userId: string) =>
  `onboarding:invited-by:${userId}`;
/** The inbox line for `memberId` being set up, held by `recipientId`. */
export const setUpNoticeKey = (recipientId: string, memberId: string) =>
  `inbox:member_set_up:${recipientId}:${memberId}`;
/**
 * The provisioner's create self-test page (a private markdown artifact
 * the owner holds, #2422). It is not the user's work: it never makes an
 * instance "not fresh" and never counts as their first artifact.
 */
export const SELF_TEST = `(title = 'Welcome to Open Artifacts' and format = 'markdown')`;
/** A seeded Welcome (anyone's, the owner's legacy row included) is not the person's work either. */
const NOT_A_WELCOME = `id not in (select coalesce(json_extract(value, '$.artifactId'), '') from settings
    where key = '${WELCOME_KEY}' or key like '${WELCOME_KEY}:%')`;

/** One row per user who has posted a comment (any thread or reply). */
export const commentedKey = (userId: string) =>
  `onboarding:commented:${userId}`;

const SET = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/**
 * The flags, plus facts about `user`: owns a live artifact (#1832), and for
 * #2287 the Welcome, the first agent connection, the first other artifact and
 * the first comment. welcomeId and welcomeOpened are for the user Welcome was
 * seeded for only.
 */
export async function getOnboarding(
  env: Env,
  user: Pick<Member, "id" | "role">,
): Promise<Onboarding> {
  const userId = user.id;
  // The owner's rows from before #2632 are install-wide: read as theirs.
  const legacy = isInstanceOwner(user);
  const [flags, own, agent, first, commented, firsts] = await env.DB.batch([
    stmt(
      env.DB,
      `select key, value from settings where key in (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      dismissedKey(userId),
      completedKey(userId),
      welcomeKey(userId),
      welcomeOpenedKey(userId),
      teamStepKey(userId),
      invitedByKey(userId),
      legacy ? DISMISSED_KEY : "",
      legacy ? COMPLETED_KEY : "",
      WELCOME_KEY,
      legacy ? WELCOME_OPENED_KEY : "",
    ),
    stmt(
      env.DB,
      `select 1 as x from artifacts where owner_id = ?1 and deleted_at is null and not ${SELF_TEST}
       and ${NOT_A_WELCOME}
       limit 1`,
    ).bind(userId),
    // An agent is connected: an OAuth grant it used, or a token that was used.
    stmt(
      env.DB,
      `select 1 as x from agent_grants where user_id = ?1
       union all select 1 from tokens where user_id = ?1 and revoked_at is null and last_used_at is not null
       limit 1`,
    ).bind(userId),
    stmt(
      env.DB,
      `select id, title from artifacts where owner_id = ?1 and deleted_at is null
       and not ${SELF_TEST}
       and ${NOT_A_WELCOME}
       order by created_at, id limit 1`,
    ).bind(userId),
    stmt(env.DB, "select 1 as x from settings where key = ?1").bind(
      commentedKey(userId),
    ),
    // #2478: the first times of the three new steps, and of the first mention.
    stmt(
      env.DB,
      "select key, value from settings where key in (?1, ?2, ?3, ?4)",
    ).bind(
      namedKey(userId),
      mentionedKey(userId),
      mentionRepliedKey(userId),
      askAnsweredKey(userId),
    ),
  ]);
  const rows = flags.results as { key: string; value: string }[];
  const keys = new Set(rows.map((r) => r.key));
  const val = (k: string) => rows.find((r) => r.key === k)?.value;
  const mineOf = (v: string | undefined) => {
    const w = parseWelcome(v);
    return w !== null && w.userId === userId ? w : null;
  };
  // Per person first; the owner's row from before when it names this person.
  const w = mineOf(val(welcomeKey(userId))) ?? mineOf(val(WELCOME_KEY));
  const mine = w !== null;
  const completed = keys.has(completedKey(userId)) || keys.has(COMPLETED_KEY);
  let welcomeId: string | null = null;
  if (w) {
    const live = await stmt(
      env.DB,
      "select 1 as x from artifacts where id = ?1 and deleted_at is null",
    )
      .bind(w.artifactId)
      .first();
    welcomeId = live ? w.artifactId : null;
  }
  const f = first.results[0] as { id: string; title: string } | undefined;
  const at = new Map(
    (firsts.results as { key: string; value: string }[]).map((r) => [
      r.key,
      Number(r.value),
    ]),
  );
  const agentNamed = at.has(namedKey(userId));
  const mentionReplied = at.has(mentionRepliedKey(userId));
  const mentionedAt = at.get(mentionedKey(userId));
  const inviter = val(invitedByKey(userId));
  return {
    dismissed: keys.has(dismissedKey(userId)) || keys.has(DISMISSED_KEY),
    completed,
    hasArtifacts: own.results.length > 0,
    welcomeId,
    welcomeOpened:
      mine &&
      (keys.has(welcomeOpenedKey(userId)) || keys.has(WELCOME_OPENED_KEY)),
    agentConnected: agent.results.length > 0,
    firstArtifact: f ? { id: f.id, title: f.title } : null,
    commented: commented.results.length > 0,
    agentNamed,
    agentName: agentNamed && !completed ? await agentName(env, userId) : null,
    mentionReplied,
    mentionStalled:
      !mentionReplied &&
      mentionedAt !== undefined &&
      Date.now() - mentionedAt >= MENTION_STALLED_MS,
    askAnswered: at.has(askAnsweredKey(userId)),
    teamStep: keys.has(teamStepKey(userId)),
    invitedBy: inviter ? { name: await realName(env, inviter) } : null,
  };
}

/** #2632: the instance owner's real name for a guest's "ask {owner}"; null when there is none or it can't be read. */
export async function instanceOwnerName(
  env: Env,
): Promise<{ name: string } | null> {
  try {
    const r = await stmt(
      env.DB,
      `select display_name as d, name as n, email as e from users
       where role = 'owner' and status = 'active' order by created_at, id limit 1`,
    ).first<{ d: string | null; n: string | null; e: string }>();
    const name = r ? r.d?.trim() || idpName(r.n, r.e) : null;
    return name ? { name } : null;
  } catch {
    return null;
  }
}

/** A person's real name (display name or a real IdP name), never their email: null when they have none. */
export async function realName(
  env: Env,
  userId: string,
): Promise<string | null> {
  try {
    const r = await stmt(
      env.DB,
      "select display_name as d, name as n, email as e from users where id = ?1",
    )
      .bind(userId)
      .first<{ d: string | null; n: string | null; e: string }>();
    return r ? r.d?.trim() || idpName(r.n, r.e) : null;
  } catch {
    return null;
  }
}

/**
 * The name the checklist calls the owner's agent: the most recently active
 * agent that is not on a harness default name. Read live, never stored; null
 * when none or the hub can't be read (the page then says "your agent").
 */
async function agentName(env: Env, userId: string): Promise<string | null> {
  try {
    const { agents } = await busView(env, userId);
    const named = agents
      .filter((a) => a.unnamed !== true)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return named?.name ?? null;
  } catch {
    return null;
  }
}

function parseWelcome(
  v: string | undefined,
): { userId: string; artifactId: string } | null {
  if (!v) return null;
  try {
    const j = JSON.parse(v) as { userId?: unknown; artifactId?: unknown };
    return typeof j.userId === "string" && typeof j.artifactId === "string"
      ? { userId: j.userId, artifactId: j.artifactId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Records that `userId` commented (any thread or reply), and, once, that they
 * commented on an artifact another user owns (the optional team step); never
 * throws (a comment must not fail on it).
 */
export async function noteCommented(
  env: Env,
  userId: string,
  artifactId?: string,
): Promise<void> {
  try {
    const now = String(Date.now());
    await env.DB.batch([
      stmt(env.DB, SET).bind(commentedKey(userId), now),
      stmt(
        env.DB,
        `insert into settings (key, value)
         select ?1, ?2 where exists (select 1 from artifacts where id = ?3 and owner_id <> ?4)
         on conflict (key) do nothing`,
      ).bind(teamStepKey(userId), now, artifactId ?? "", userId),
    ]);
  } catch (e) {
    logWarn("onboarding_commented_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/**
 * #2287, #2632: seeds each non-guest member's own private Welcome, once per
 * person, on every sign-in path, hosted or not. The per-person settings row
 * is claimed first (insert-or-nothing), so a second sign-in, a race, or a
 * delete of Welcome never seeds again. A failed publish releases the claim so
 * the next sign-in retries. The "fresh instance" check applies to the first
 * person only: an instance that already has any artifact row (deleted ones
 * too) before anyone was seeded is not fresh, and that person's claim is kept
 * as "skipped" (no user, no artifact) so Welcome never appears later; every
 * later member gets theirs. Never throws: sign-in must not block.
 */
export async function seedWelcome(env: Env, user: Member): Promise<void> {
  if (isGuestRole(user.role)) return;
  try {
    const key = welcomeKey(user.id);
    const seeded = JSON.stringify({ userId: user.id, artifactId: "" });
    const skipped = JSON.stringify({ userId: "", artifactId: "" });
    const claim = await stmt(
      env.DB,
      `insert into settings (key, value)
       select ?1, case
         when exists (select 1 from settings where key = ?4 or key like ?5) then ?3
         when exists (select 1 from artifacts where not ${SELF_TEST}) then ?2
         else ?3 end
       where not exists (select 1 from settings where key = ?4 and json_extract(value, '$.userId') = ?6)
       on conflict (key) do nothing`,
    )
      .bind(key, skipped, seeded, WELCOME_KEY, `${WELCOME_KEY}:%`, user.id)
      .run();
    if (!claim.meta.changes) return;
    const held = await stmt(env.DB, "select value from settings where key = ?1")
      .bind(key)
      .first<{ value: string }>();
    if (parseWelcome(held?.value)?.userId !== user.id) return;
    let id: string;
    // Publishing a Welcome is not the person's own work: it never makes them a billed creator.
    const t0 = Date.now();
    try {
      id = (
        await publish(
          env,
          user,
          {
            title: WELCOME_TITLE,
            format: "html",
            content: welcomeHtml(appOrigin(env)),
            visibility: "private",
          },
          null,
          undefined,
          "create",
        )
      ).id;
    } catch (e) {
      // Nothing was published: release the claim so the next sign-in retries.
      await stmt(env.DB, "delete from settings where key = ?1").bind(key).run();
      throw e;
    }
    if (!isInstanceOwner(user))
      await stmt(
        env.DB,
        "delete from creator_months where user_id = ?1 and first_at >= ?2",
      )
        .bind(user.id, t0)
        .run()
        .catch(() => undefined);
    // Published: keep the claim whatever happens (a retry would seed twice).
    await stmt(env.DB, "update settings set value = ?2 where key = ?1")
      .bind(key, JSON.stringify({ userId: user.id, artifactId: id }))
      .run();
  } catch (e) {
    logWarn("welcome_seed_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/**
 * Turns on the flags in `patch`, for `user` only. When their `completed` is
 * written for the first time, whoever added them (else the owner) gets one
 * inbox line, "{name} is set up".
 */
export async function setOnboarding(
  env: Env,
  user: Pick<Member, "id" | "role">,
  patch: OnboardingPatch,
): Promise<Onboarding> {
  const userId = user.id;
  const now = String(Date.now());
  const writes = [
    patch.dismissed ? stmt(env.DB, SET).bind(dismissedKey(userId), now) : null,
    // Only for the user Welcome was seeded for; anyone else's is a no-op.
    patch.welcomeOpened
      ? stmt(
          env.DB,
          `insert into settings (key, value) select ?1, ?2
           where ?4 in (coalesce(json_extract((select value from settings where key = ?3), '$.userId'), ''),
                        coalesce(json_extract((select value from settings where key = ?5), '$.userId'), ''))
           on conflict (key) do nothing`,
        ).bind(
          welcomeOpenedKey(userId),
          now,
          welcomeKey(userId),
          userId,
          WELCOME_KEY,
        )
      : null,
  ].filter((s) => s !== null);
  if (writes.length) await env.DB.batch(writes);
  if (patch.completed) await markCompleted(env, user, now);
  return getOnboarding(env, user);
}

/** Writes the person's `completed` once; the call that wrote it tells their inviter (or the owner). */
async function markCompleted(
  env: Env,
  user: Pick<Member, "id" | "role">,
  now: string,
): Promise<void> {
  // The owner's install-wide row from before already said it: not a first time.
  if (isInstanceOwner(user)) {
    const old = await stmt(env.DB, "select 1 as x from settings where key = ?1")
      .bind(COMPLETED_KEY)
      .first();
    if (old) {
      await stmt(env.DB, SET).bind(completedKey(user.id), now).run();
      return;
    }
  }
  const r = await stmt(env.DB, SET).bind(completedKey(user.id), now).run();
  if (!r.meta.changes) return;
  try {
    // To whoever added them while they are still an active member, else the owner.
    await stmt(
      env.DB,
      `insert into settings (key, value)
       select 'inbox:member_set_up:' || r.id || ':' || ?1, ?2
       from (select coalesce(
               (select u.id from settings s join users u on u.id = s.value
                  where s.key = ?3 and u.status = 'active' and u.role <> 'guest'),
               (select id from users where role = 'owner' and status = 'active'
                  order by created_at, id limit 1)) as id) r
       where r.id is not null and r.id <> ?1
       on conflict (key) do nothing`,
    )
      .bind(user.id, now, invitedByKey(user.id))
      .run();
  } catch (e) {
    logWarn("member_set_up_notice_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

type SetupRow = Pick<Member, "id" | "role" | "lastSeenAt">;

/**
 * #2632: the Members column. Each person's setup from three reads for the
 * whole list (their settings rows, who has a used agent, who owns a page that
 * is not a Welcome), never one per row. A guest has none.
 */
export async function memberSetups(
  env: Env,
  members: SetupRow[],
): Promise<Map<string, MemberSetup>> {
  const out = new Map<string, MemberSetup>();
  const people = members.filter((m) => !isGuestRole(m.role));
  if (!people.length) return out;
  const [settings, agents, owners] = await env.DB.batch([
    stmt(
      env.DB,
      `select key, value from settings where key like 'onboarding:%'`,
    ),
    stmt(
      env.DB,
      `select user_id as id from agent_grants
       union select user_id from tokens where revoked_at is null and last_used_at is not null`,
    ),
    stmt(
      env.DB,
      `select distinct owner_id as id from artifacts where deleted_at is null and not ${SELF_TEST}
       and ${NOT_A_WELCOME}`,
    ),
  ]);
  const keys = new Set(
    (settings.results as { key: string }[]).map((r) => r.key),
  );
  const connected = new Set(
    (agents.results as { id: string }[]).map((r) => r.id),
  );
  const published = new Set(
    (owners.results as { id: string }[]).map((r) => r.id),
  );
  for (const m of people) {
    const p = setupSteps({
      agentConnected: connected.has(m.id),
      agentNamed: keys.has(namedKey(m.id)),
      firstArtifact: published.has(m.id) ? true : null,
      mentionReplied: keys.has(mentionRepliedKey(m.id)),
      askAnswered: keys.has(askAnsweredKey(m.id)),
    });
    const set =
      keys.has(completedKey(m.id)) ||
      (isInstanceOwner(m) && keys.has(COMPLETED_KEY)) ||
      p.done === 5;
    out.set(m.id, {
      state: set ? "set" : m.lastSeenAt === null ? "invited" : "partial",
      done: p.done,
      ...(!set && p.stalled ? { stalled: p.stalled } : {}),
    });
  }
  return out;
}
