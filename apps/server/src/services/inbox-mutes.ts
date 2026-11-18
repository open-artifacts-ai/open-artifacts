// #2512 S4: what a member muted from browser notifications. A mute stops push
// only: a muted agent's or page's items (asks and updates) stay in the For you
// list. Only ids the caller can see are stored: a page they can read, and an
// agent that is on an item they have had. At most MUTES_MAX; a person in a
// browser only (the route).
import type { InboxMuteBody, InboxMutes, Member } from "@oa/shared";
import { and, inArray, isNull } from "drizzle-orm";
import { accessLevel, callerOf, listFilterSql } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";

export const MUTES_MAX = 200;
/** Mute changes one member may make per day. */
export const MUTE_WRITES_PER_DAY = 200;

/**
 * The member's mutes. A page's title shows only while the member can still
 * read it (and it isn't deleted); otherwise the name is empty, so a mute never
 * keeps a title they lost access to. An agent's name is the one it had on an
 * item they received.
 */
export async function listMutes(env: Env, user: Member): Promise<InboxMutes> {
  const { results } = await stmt(
    env.DB,
    `select kind, target_id, name from inbox_mutes
      where user_id = ?1 order by created_at, target_id`,
  )
    .bind(user.id)
    .all<{ kind: "agent" | "page"; target_id: string; name: string | null }>();
  const titles = new Map<string, string>();
  const pages = results
    .filter((r) => r.kind === "page")
    .map((r) => r.target_id);
  const caller = callerOf(user);
  for (let i = 0; i < pages.length; i += 90) {
    const rows = await getDb(env)
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(
        and(
          inArray(artifacts.id, pages.slice(i, i + 90)),
          isNull(artifacts.deletedAt),
          listFilterSql(caller, "all"),
        ),
      );
    for (const r of rows) titles.set(r.id, r.title);
  }
  return {
    items: results.map((r) => ({
      kind: r.kind,
      id: r.target_id,
      name:
        r.kind === "page" ? (titles.get(r.target_id) ?? "") : (r.name ?? ""),
    })),
  };
}

/** The agent's name from an item the member has had, or null when none names it. */
async function agentNameOn(
  env: Env,
  userId: string,
  identityId: string,
): Promise<string | null> {
  const path = "$.agent.identity.identityId";
  const row = await stmt(
    env.DB,
    `select name from (
       select json_extract(asker, '$.agent.name') as name from artifact_asks
        where addressee = ?1 and json_extract(asker, ?3) = ?2
       union all
       select json_extract(actor, '$.agent.name') as name from inbox_items
        where user_id = ?1 and json_extract(actor, ?3) = ?2
     ) limit 1`,
  )
    .bind(userId, identityId, path)
    .first<{ name: string | null }>();
  return row ? (row.name ?? "") : null;
}

/**
 * Mutes a page or an agent. 404 for an id the caller can't see. Muting what
 * is already muted is a no-op. 409 mutes_full past MUTES_MAX.
 */
export async function addMute(
  env: Env,
  user: Member,
  body: InboxMuteBody,
): Promise<void> {
  let name: string | null = null;
  if (body.kind === "page") {
    if (!(await accessLevel(env, callerOf(user), body.id)))
      throw new ApiError("not_found", "Not found");
  } else {
    name = await agentNameOn(env, user.id, body.id);
    if (name === null) throw new ApiError("not_found", "Not found");
  }
  const day = new Date().toISOString().slice(0, 10);
  if (
    (await takeAll(env, [[`prefs:m:${user.id}`, MUTE_WRITES_PER_DAY, day]])) !==
    -1
  )
    throw new ApiError(
      "rate_limited",
      "Too many changes today. Try again tomorrow.",
    );
  // One statement: the cap and the insert can't be split by a second request.
  const r = await stmt(
    env.DB,
    `insert into inbox_mutes (user_id, kind, target_id, name, created_at)
     select ?1, ?2, ?3, ?4, ?5
      where (select count(*) from inbox_mutes where user_id = ?1) < ?6
         or exists (select 1 from inbox_mutes where user_id = ?1 and kind = ?2 and target_id = ?3)
     on conflict (user_id, kind, target_id) do nothing`,
  )
    .bind(user.id, body.kind, body.id, name, Date.now(), MUTES_MAX)
    .run();
  if ((r.meta.changes ?? 0) === 0) {
    const had = await stmt(
      env.DB,
      "select 1 as x from inbox_mutes where user_id = ?1 and kind = ?2 and target_id = ?3",
    )
      .bind(user.id, body.kind, body.id)
      .first();
    if (!had)
      throw new ApiError("mutes_full", "Too many mutes. Unmute one first.");
  }
}

export async function removeMute(
  env: Env,
  userId: string,
  kind: string,
  id: string,
): Promise<void> {
  await stmt(
    env.DB,
    "delete from inbox_mutes where user_id = ?1 and kind = ?2 and target_id = ?3",
  )
    .bind(userId, kind, id)
    .run();
}

/** Whether the member muted this agent or this page (the push drain skips them). */
export async function mutedSet(
  env: Env,
  userId: string,
): Promise<{ agents: Set<string>; pages: Set<string> }> {
  const { results } = await stmt(
    env.DB,
    "select kind, target_id from inbox_mutes where user_id = ?1",
  )
    .bind(userId)
    .all<{ kind: string; target_id: string }>();
  const out = { agents: new Set<string>(), pages: new Set<string>() };
  for (const r of results)
    (r.kind === "agent" ? out.agents : out.pages).add(r.target_id);
  return out;
}
