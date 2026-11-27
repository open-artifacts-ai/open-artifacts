import {
  ASK_SLOT_KEY,
  ASK_SLOTS_MAX,
  type CommentThread,
  type PlaceAskInput,
} from "@oa/shared";
import { authorize, type Caller, canCtx, capOfCaller } from "../auth/authz.js";
import { can, capsReads, isGuestRole } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { type CommentViewer, listThread } from "./comments.js";
import { personName } from "./users.js";

/**
 * #2426 B, #2536: the slots a page holds, and where each ask lives. One table
 * serves both: an ask posted with a `slot` on its own page is a placement whose
 * home is that page, and #2536's placements are the same row with another home.
 * The page's markup only ever holds the key; this table is the only place that
 * knows which ask a key means.
 */
export type StoredSlot = {
  /** The page's own name for the place. */
  key: string;
  /** The page the ask lives on: where the thread is read and the answer goes. */
  homeArtifactId: string;
  threadId: string;
  commentId: string;
  note: string | null;
  /** The person whose agent placed it, when it was placed by an agent. */
  placedBy: string | null;
  /** The agent that placed it, as it named itself. */
  placedAgent: string | null;
};

type Row = {
  slot_key: string;
  home_artifact_id: string;
  thread_id: string;
  comment_id: string;
  note: string | null;
  placed_by: string | null;
  placed_agent: string | null;
};

/** A page's slots in key order, at most ASK_SLOTS_MAX. */
export async function slotsOfPage(
  env: Env,
  artifactId: string,
): Promise<StoredSlot[]> {
  const { results } = await stmt(
    env.DB,
    `select slot_key, home_artifact_id, thread_id, comment_id, note, placed_by, placed_agent
       from artifact_ask_slots where artifact_id = ? order by slot_key limit ?`,
  )
    .bind(artifactId, ASK_SLOTS_MAX)
    .all<Row>();
  // A key is the page's own and must be one a page could write; a row holding
  // anything else was not written by this server and never reaches a viewer.
  return results
    .filter((r) => ASK_SLOT_KEY.test(r.slot_key))
    .map((r) => ({
      key: r.slot_key,
      homeArtifactId: r.home_artifact_id,
      threadId: r.thread_id,
      commentId: r.comment_id,
      note: r.note,
      placedBy: r.placed_by,
      placedAgent: r.placed_agent,
    }));
}

/** Titles by artifact id; an id with no row (deleted, gone) is absent. */
export async function pageTitles(
  env: Env,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(", ");
  const { results } = await stmt(
    env.DB,
    `select id, title from artifacts where id in (${marks})`,
  )
    .bind(...ids)
    .all<{ id: string; title: string }>();
  for (const r of results) out.set(r.id, r.title);
  return out;
}

/** Public display names by user id (via personName: display name, else IdP name, never email/local part, else "Someone"). */
export async function userDisplayNames(
  env: Env,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const marks = uniq.map(() => "?").join(", ");
  const { results } = await stmt(
    env.DB,
    `select id, display_name, name, email from users where id in (${marks})`,
  )
    .bind(...uniq)
    .all<{
      id: string;
      display_name: string | null;
      name: string | null;
      email: string;
    }>();
  for (const r of results) {
    out.set(
      r.id,
      personName({
        email: r.email,
        name: r.name,
        displayName: r.display_name,
      }),
    );
  }
  return out;
}

/**
 * #2536: places an existing ask (same page or another page the caller can read)
 * into a `[data-oa-ask="<key>"]` slot on `input.id`. Never copies the ask and
 * never widens access to the ask's home page.
 */
export async function placeAskSlot(
  env: Env,
  caller: Caller,
  input: PlaceAskInput,
  placer: { userId: string; agent?: string | null },
): Promise<{
  id: string;
  key: string;
  homeArtifactId: string;
  threadId: string;
  commentId: string;
}> {
  // Target page: editor or owner only.
  await authorize(env, caller, input.id, "publish");
  if (!ASK_SLOT_KEY.test(input.key))
    throw new ApiError("bad_request", "Slot key must match [a-z0-9-]{1,64}.");
  // Rule 5: caller may show an ask only if they can already read its home page.
  const home = await authorize(
    env,
    caller,
    input.homeArtifactId,
    "comments.read",
  );
  if (home.artifact.comments !== 1)
    throw new ApiError(
      "comments_off",
      "Comments are off for the ask's home artifact.",
    );
  const viewer: CommentViewer = {
    userId: placer.userId,
    short: null,
    guest: caller.kind === "user" && isGuestRole(caller.user.role),
    capped: capsReads(capOfCaller(caller)),
    moderator: can(
      home.level,
      "comments.moderate",
      canCtx(caller, home.artifact),
    ),
    caller,
  };
  let thread: CommentThread | undefined;
  try {
    thread = (
      await listThread(env, input.homeArtifactId, viewer, input.threadId)
    ).threads[0];
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found")
      throw new ApiError("not_found", "No such thread on the home artifact.");
    throw e;
  }
  const comment = thread?.comments.find((c) => c.id === input.commentId);
  if (!comment?.ask)
    throw new ApiError(
      "not_found",
      "No ask found at that threadId and commentId on the home artifact.",
    );
  if (comment.ask.withdrawn)
    throw new ApiError("withdrawn", "Cannot place a withdrawn ask.");
  if (comment.ask.replacedBy)
    throw new ApiError("already_replaced", "Cannot place a replaced ask.");

  const existing = await stmt(
    env.DB,
    "select slot_key from artifact_ask_slots where artifact_id = ?",
  )
    .bind(input.id)
    .all<{ slot_key: string }>();
  const keys = new Set(existing.results.map((r) => r.slot_key));
  if (!keys.has(input.key) && keys.size >= ASK_SLOTS_MAX)
    throw new ApiError(
      "conflict",
      `At most ${ASK_SLOTS_MAX} ask slots per page.`,
    );

  const note = input.note?.trim() || null;
  await stmt(
    env.DB,
    `insert into artifact_ask_slots
       (artifact_id, slot_key, home_artifact_id, thread_id, comment_id, note, placed_by, placed_agent, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(artifact_id, slot_key) do update set
       home_artifact_id = excluded.home_artifact_id,
       thread_id = excluded.thread_id,
       comment_id = excluded.comment_id,
       note = excluded.note,
       placed_by = excluded.placed_by,
       placed_agent = excluded.placed_agent,
       created_at = excluded.created_at`,
  )
    .bind(
      input.id,
      input.key,
      input.homeArtifactId,
      input.threadId,
      input.commentId,
      note,
      placer.userId,
      placer.agent ?? null,
      new Date().toISOString(),
    )
    .run();

  return {
    id: input.id,
    key: input.key,
    homeArtifactId: input.homeArtifactId,
    threadId: input.threadId,
    commentId: input.commentId,
  };
}

/** #2536: removes a placed ask slot from `artifactId` (editor or owner only). */
export async function removeAskSlot(
  env: Env,
  caller: Caller,
  artifactId: string,
  key: string,
): Promise<{ id: string; key: string; removed: boolean }> {
  await authorize(env, caller, artifactId, "publish");
  if (!ASK_SLOT_KEY.test(key))
    throw new ApiError("bad_request", "Slot key must match [a-z0-9-]{1,64}.");
  const r = await stmt(
    env.DB,
    "delete from artifact_ask_slots where artifact_id = ? and slot_key = ?",
  )
    .bind(artifactId, key)
    .run();
  return { id: artifactId, key, removed: (r.meta?.changes ?? 0) > 0 };
}
