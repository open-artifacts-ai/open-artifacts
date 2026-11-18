// #2770: the people an owner or editor may @mention on an artifact: members who
// can read it, as faces (name and the roster's disambiguation, never an email).
// A search by the start of a name or an email, 8 at most, rate limited.
import {
  type CommentAuthor,
  MENTION_CANDIDATES_MAX,
  MENTION_CANDIDATES_Q_MAX,
  type Member,
  type MentionCandidates,
} from "@oa/shared";
import { accessLevels, callerOf } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import { takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { askerFaces, type CommentViewer } from "./comments.js";
import { getUsers } from "./users.js";

/** Searches one member may make per minute. */
export const MENTION_SEARCHES_PER_MIN = 60;
/** Rows read before the access check: the check, not the search, is what limits the answer. */
const SCAN = 40;

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

export async function mentionCandidates(
  env: Env,
  artifactId: string,
  me: Member,
  viewer: CommentViewer,
  rawQ: string,
  now = Date.now(),
): Promise<MentionCandidates> {
  const q = rawQ.trim().toLowerCase();
  if (q.length < 1 || q.length > MENTION_CANDIDATES_Q_MAX)
    throw new ApiError("bad_request", "Invalid search");
  const minute = new Date(now).toISOString().slice(0, 16);
  if (
    (await takeAll(env, [
      [`prefs:mc:${me.id}`, MENTION_SEARCHES_PER_MIN, minute],
    ])) !== -1
  )
    throw new ApiError("rate_limited", "Too many searches. Try again shortly.");
  const p = `${likeEscape(q)}%`;
  const { results } = await stmt(
    env.DB,
    `select id from users
      where status = 'active' and id <> ?1
        and (lower(name) like ?2 escape '\\' or lower(name) like '% ' || ?2 escape '\\'
             or lower(email) like ?2 escape '\\')
      order by name, id limit ?3`,
  )
    .bind(me.id, p, SCAN)
    .all<{ id: string }>();
  if (results.length === 0) return { items: [] };
  const users = await getUsers(
    env,
    results.map((r) => r.id),
  );
  const people = results
    .map((r) => users.get(r.id))
    .filter((u): u is Member => !!u);
  const levels = await accessLevels(
    env,
    people.map((u) => callerOf(u)),
    artifactId,
  );
  const readable = people.filter((_, i) => levels[i]?.artifact);
  const top = readable.slice(0, MENTION_CANDIDATES_MAX);
  const faces: CommentAuthor[] = await askerFaces(
    env,
    viewer,
    top.map((u) => ({ kind: "user", ref: u.id })),
  );
  return { items: faces };
}
