// Comment notice emails (#1467, Product's spec ms8jhYp1q57oEpgq v2): who is
// told of a new thread or reply, once per comment, with the most specific
// reason (ask, mention, reply, new thread). Best effort and out of band:
// callers run it in the background and a failure only logs.
import { viewerPath } from "@oa/shared";
import { accessLevel, callerOf, capOfCaller } from "../auth/authz.js";
import { capsReads, isGuestRole } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import {
  COMMENT_UNSUB_PATH,
  type CommentEmailReason,
  commentEmail,
  excerptOf,
  signUnsubToken,
} from "../email/comment-email.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { oneLine, senderName } from "../email/templates.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logError } from "../log.js";
import type { StoredComment } from "../runtime/comments-store.js";
import { runtimeStub } from "../runtime/do.js";
import { getSettings } from "./members.js";
import { getUser } from "./users.js";

/** At most one comment email per (thread, person) in this window. */
export const COMMENT_EMAIL_WINDOW_MS = 15 * 60 * 1000;

/** The counters key counting comments the daily cap left out for a person (not swept: the next email reads and clears it). */
const leftOutKey = (userId: string) => `cleft:${userId}`;

type Job = {
  artifactId: string;
  threadId: string;
  /** The comment just written. */
  comment: StoredComment;
  /** A reply (tells the thread's people) rather than a new thread (tells the owner). */
  reply: boolean;
  now?: number;
};

const ORDER: CommentEmailReason[] = ["ask", "mention", "reply", "thread"];

/**
 * Each person this comment concerns, with the most specific reason. Never the
 * author; never the author's agent's person, unless the comment @-mentions
 * them or is an ask addressed to them. Guests and agents have no address.
 */
async function recipients(
  env: Env,
  j: Job,
): Promise<Map<string, CommentEmailReason>> {
  const c = j.comment;
  const by = new Map<CommentEmailReason, Set<string>>(
    ORDER.map((r) => [r, new Set<string>()]),
  );
  for (const p of c.ask?.to ?? [])
    if (p.kind === "user") by.get("ask")?.add(p.key);
  // A mention names an agent, not a person: nobody is emailed for it (the
  // agent's person is not told). The "mention" reason stays for when a
  // mention can name a person.
  if (j.reply) {
    const t = await runtimeStub(env, j.artifactId).commentsGet(j.threadId);
    for (const x of t.comments)
      if (x.author.kind === "user" && !x.author.agent)
        by.get("reply")?.add(x.author.ref);
  } else {
    const row = await stmt(
      env.DB,
      "select owner_id as o from artifacts where id = ?",
    )
      .bind(j.artifactId)
      .first<{ o: string }>();
    if (row) by.get("thread")?.add(row.o);
  }
  const result = new Map<string, CommentEmailReason>();
  for (const r of ORDER)
    for (const id of by.get(r) ?? []) if (!result.has(id)) result.set(id, r);
  const a = c.author;
  if (a.kind === "user") {
    if (!a.agent) result.delete(a.ref);
    else {
      const r = result.get(a.ref);
      if (r !== "ask" && r !== "mention") result.delete(a.ref);
    }
  }
  return result;
}

/** A person's name, or "{agent} ({person}'s agent)". */
async function authorName(env: Env, c: StoredComment): Promise<string> {
  const a = c.author;
  if (a.kind === "guest") return `${oneLine(a.name || "A guest", 60)} (guest)`;
  const u = await getUser(env, a.ref);
  const person = u ? senderName(u) : "Someone";
  if (!a.agent) return person;
  const agent = a.agent.identity?.name || a.agent.name;
  return `${oneLine(agent, 60)} (${person}'s agent)`;
}

/** Takes the person's left-out count (and clears it) atomically; 0 when none. */
const takeLeftOut = async (env: Env, userId: string): Promise<number> =>
  (
    await stmt(env.DB, "delete from counters where key = ? returning n")
      .bind(leftOutKey(userId))
      .first<{ n: number }>()
  )?.n ?? 0;

const addLeftOut = (env: Env, userId: string, now: number, n = 1) =>
  stmt(
    env.DB,
    `insert into counters (key, n, day) values (?1, ?3, ?2)
     on conflict (key) do update set n = n + excluded.n, day = excluded.day`,
  )
    .bind(leftOutKey(userId), new Date(now).toISOString().slice(0, 10), n)
    .run();

/** Returns how many emails went out. Never throws. */
export async function emailCommentRecipients(
  env: Env,
  j: Job,
): Promise<number> {
  try {
    if (!emailEnabled(env)) return 0;
    const now = j.now ?? Date.now();
    const art = await stmt(
      env.DB,
      "select title, comments from artifacts where id = ? and deleted_at is null",
    )
      .bind(j.artifactId)
      .first<{ title: string; comments: number }>();
    // Comments turned off on the page: nothing is sent.
    if (!art || art.comments === 0) return 0;
    const eligible: {
      id: string;
      email: string;
      reason: CommentEmailReason;
    }[] = [];
    for (const [id, reason] of await recipients(env, j)) {
      const user = await getUser(env, id);
      // Members only: a guest-role account gets none, nor a member whose
      // reads are capped (restricted), even where a share still lets them read.
      if (
        !user ||
        isGuestRole(user.role) ||
        capsReads(capOfCaller(callerOf(user)))
      )
        continue;
      const pref = await stmt(
        env.DB,
        "select comment_email as v from users where id = ?",
      )
        .bind(id)
        .first<{ v: number }>();
      if (!pref || pref.v !== 1) continue;
      // Access now, not when the comment was posted.
      if (!(await accessLevel(env, callerOf(user), j.artifactId))?.artifact)
        continue;
      eligible.push({ id, email: user.email, reason });
    }
    if (eligible.length === 0) return 0;
    const at = new Date(now).toISOString();
    const stub = runtimeStub(env, j.artifactId);
    const won = new Set(
      await stub.commentsEmailClaim({
        threadId: j.threadId,
        userIds: eligible.map((e) => e.id),
        sinceIso: new Date(now - COMMENT_EMAIL_WINDOW_MS).toISOString(),
        at,
      }),
    );
    const [author, settings] = await Promise.all([
      authorName(env, j.comment),
      getSettings(env),
    ]);
    const origin = appOrigin(env);
    const url = `${origin}${viewerPath(j.artifactId)}?thread=${encodeURIComponent(j.threadId)}`;
    const settingsUrl = `${origin}/settings/profile`;
    const excerpt = excerptOf(j.comment.body);
    let sent = 0;
    for (const e of eligible) {
      if (!won.has(e.id)) continue;
      let ok = false;
      let leftOut = 0;
      const outcome: { limited?: boolean } = {};
      try {
        // Taken just before sending, put back if the send fails.
        leftOut = await takeLeftOut(env, e.id);
        const unsubUrl = `${origin}${COMMENT_UNSUB_PATH}?t=${encodeURIComponent(await signUnsubToken(env, e.id))}`;
        ok = await sendEmail(
          env,
          null,
          e.email,
          () =>
            commentEmail({
              author,
              title: art.title,
              reason: e.reason,
              excerpt,
              url,
              unsubUrl,
              settingsUrl,
              leftOut,
            }),
          { kind: "comment", instance: settings.name, now, outcome },
        );
      } catch (err) {
        logError("comment_email_failed", err);
      }
      if (!ok) {
        // Put the taken count back; a cap refusal also counts this comment.
        const back = leftOut + (outcome.limited ? 1 : 0);
        if (back > 0)
          await addLeftOut(env, e.id, now, back).catch(() => undefined);
      }
      // The slot is spent only by a send that went out.
      if (ok) sent++;
      else
        await stub
          .commentsEmailRefund({ threadId: j.threadId, userId: e.id, at })
          .catch(() => undefined);
    }
    return sent;
  } catch (err) {
    logError("comment_email_failed", err);
    return 0;
  }
}
