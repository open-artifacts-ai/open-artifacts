// Comment notice emails (#1467, smallest version): a new thread tells the
// artifact's owner; a reply tells the people who wrote earlier in the thread.
// Best effort and out of band: callers run it in the background and a
// failure only logs. Mentions can target agents only, so none is emailed.

import { viewerPath } from "@oa/shared";
import { accessLevel, callerOf } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import {
  COMMENT_UNSUB_PATH,
  commentEmail,
  signUnsubToken,
} from "../email/comment-email.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { senderName } from "../email/templates.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logError } from "../log.js";
import type { StoredComment } from "../runtime/comments-store.js";
import { runtimeStub } from "../runtime/do.js";
import { getSettings } from "./members.js";
import { getUser } from "./users.js";

/** At most one comment email per (thread, person) in this window. */
export const COMMENT_EMAIL_WINDOW_MS = 15 * 60 * 1000;

type Job = {
  artifactId: string;
  threadId: string;
  /** The comment just written. */
  comment: StoredComment;
  /** A reply (tells earlier commenters) rather than a new thread (tells the owner). */
  reply: boolean;
  now?: number;
};

/** The people to consider: never the author, never the author's agent's person. */
async function candidates(env: Env, j: Job): Promise<string[]> {
  const author = j.comment.author;
  const ids = new Set<string>();
  if (!j.reply) {
    const row = await stmt(
      env.DB,
      "select owner_id as o from artifacts where id = ?",
    )
      .bind(j.artifactId)
      .first<{ o: string }>();
    if (row) ids.add(row.o);
  } else {
    const t = await runtimeStub(env, j.artifactId).commentsGet(j.threadId);
    for (const c of t.comments)
      if (c.author.kind === "user" && !c.author.agent) ids.add(c.author.ref);
  }
  // An agent's comment carries its person's id as `ref`, so this covers both.
  if (author.kind === "user") ids.delete(author.ref);
  return [...ids];
}

async function authorName(env: Env, c: StoredComment): Promise<string> {
  const a = c.author;
  if (a.kind === "guest") return a.name || "A guest";
  if (a.agent) return a.agent.name;
  const u = await getUser(env, a.ref);
  return u ? senderName(u) : "Someone";
}

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
      "select title from artifacts where id = ? and deleted_at is null",
    )
      .bind(j.artifactId)
      .first<{ title: string }>();
    if (!art) return 0;
    const eligible: { id: string; email: string }[] = [];
    for (const id of await candidates(env, j)) {
      const user = await getUser(env, id);
      if (!user) continue;
      const pref = await stmt(
        env.DB,
        "select comment_email as on_ from users where id = ?",
      )
        .bind(id)
        .first<{ on_: number }>();
      if (!pref || pref.on_ !== 1) continue;
      if (!(await accessLevel(env, callerOf(user), j.artifactId))?.artifact)
        continue;
      eligible.push({ id, email: user.email });
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
    const [who, settings] = await Promise.all([
      authorName(env, j.comment),
      getSettings(env),
    ]);
    const origin = appOrigin(env);
    let sent = 0;
    for (const e of eligible) {
      if (!won.has(e.id)) continue;
      let ok = false;
      try {
        const unsubUrl = `${origin}${COMMENT_UNSUB_PATH}?t=${encodeURIComponent(await signUnsubToken(env, e.id))}`;
        ok = await sendEmail(
          env,
          null,
          e.email,
          () =>
            commentEmail({
              who,
              title: art.title,
              reply: j.reply,
              url: `${origin}${viewerPath(j.artifactId)}`,
              unsubUrl,
            }),
          { kind: "comment", instance: settings.name, now },
        );
      } catch (err) {
        logError("comment_email_failed", err);
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
