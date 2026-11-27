import { ASK_SLOT_KEY, ASK_SLOTS_MAX } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

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

/** Public display names by user id (display_name, else name, else email local part). */
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
    const label =
      r.display_name?.trim() ||
      r.name?.trim() ||
      r.email.split("@")[0]?.trim() ||
      "";
    if (label) out.set(r.id, label);
  }
  return out;
}
