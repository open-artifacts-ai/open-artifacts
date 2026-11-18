// #2632: one reminder email, three days after a member's first login with no
// agent connected, then silence. Daily cron. A member (admin or member, never
// the owner or a guest) gets it at most once (onboarding:reminded:<id>, the
// send time, which Settings > Members shows as "Reminded {date}"), never
// after "Don't remind me" (onboarding:no-remind:<id>), and only while their
// first sign-in is 3 to 10 days old, so people who joined before this
// shipped are never mailed out of the blue.
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import {
  REMIND_OFF_PATH,
  setupReminderEmail,
  signRemindOffToken,
} from "../email/setup-reminder.js";
import { setupLine } from "../email/templates.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logWarn } from "../log.js";
import { getSettings } from "./members.js";

export const remindedKey = (userId: string) => `onboarding:reminded:${userId}`;
export const noRemindKey = (userId: string) => `onboarding:no-remind:${userId}`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after the first sign-in the reminder goes. */
export const REMIND_AFTER_MS = 3 * DAY_MS;
/** First sign-ins older than this never get one. */
export const REMIND_UNTIL_MS = 10 * DAY_MS;
/** Most reminders one daily run sends. */
export const REMIND_MAX_PER_RUN = 50;

// "No agent connected" is the Members column's own test (memberSetups): no
// agent grant and no used, unrevoked token. ?1 latest first sign-in, ?2
// earliest, ?3 the cap.
const DUE = `select u.id as id, u.email as email
  from users u
  join (select target_id as id, min(at) as firstAt from audit_events
        where action = 'auth.signin' and target_id is not null
        group by target_id) f on f.id = u.id
  where u.status = 'active' and u.role in ('admin', 'member')
    and u.erased_at is null
    and f.firstAt <= ?1 and f.firstAt > ?2
    and not exists (select 1 from settings s where s.key = 'onboarding:reminded:' || u.id)
    and not exists (select 1 from settings s where s.key = 'onboarding:no-remind:' || u.id)
    and not exists (select 1 from settings s where s.key = 'onboarding:completed:' || u.id)
    and not exists (select 1 from agent_grants g where g.user_id = u.id)
    and not exists (select 1 from tokens t where t.user_id = u.id
                    and t.revoked_at is null and t.last_used_at is not null)
  order by f.firstAt limit ?3`;

const CLAIM = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/** Sends the day's due reminders; how many went. Never throws. */
export async function sendSetupReminders(
  env: Env,
  now: number,
): Promise<number> {
  if (!emailEnabled(env)) return 0;
  let sent = 0;
  try {
    const { results } = await stmt(env.DB, DUE)
      .bind(now - REMIND_AFTER_MS, now - REMIND_UNTIL_MS, REMIND_MAX_PER_RUN)
      .all<{ id: string; email: string }>();
    if (!results.length) return 0;
    const instance = (await getSettings(env)).name;
    const origin = appOrigin(env);
    for (const u of results) {
      // Claim first, so two runs can't both send; released if it didn't go.
      const claim = await stmt(env.DB, CLAIM)
        .bind(remindedKey(u.id), String(now))
        .run();
      if (!claim.meta.changes) continue;
      const offUrl = `${origin}${REMIND_OFF_PATH}?t=${encodeURIComponent(
        await signRemindOffToken(env, u.id),
      )}`;
      const ok = await sendEmail(
        env,
        null,
        u.email,
        () =>
          setupReminderEmail({
            instance,
            setupLine: setupLine(origin),
            offUrl,
          }),
        { kind: "setup_reminder", instance, now },
      );
      if (ok) sent++;
      else
        await stmt(env.DB, "delete from settings where key = ?1")
          .bind(remindedKey(u.id))
          .run();
    }
  } catch (e) {
    logWarn("setup_reminder_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
  return sent;
}

/** "Don't remind me": idempotent. */
export async function remindOff(env: Env, userId: string): Promise<void> {
  await stmt(env.DB, CLAIM).bind(noRemindKey(userId), String(Date.now())).run();
}
