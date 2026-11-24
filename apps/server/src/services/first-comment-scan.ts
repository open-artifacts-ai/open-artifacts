// #2953: the historical half of "first comment". Comments live in each
// page's Durable Object, so a first typed comment made before this shipped is
// found by asking the pages, a small batch per tick, never all at once.
//
// The evidence is the stored author of each comment: a person's comment typed
// in the web app carries `typed` and no agent (#1797). An older comment
// without it is NOT counted, and neither is a legacy `onboarding:commented`
// timestamp: it only proves no agent was attached. Each page answers with one
// grouped query (the DO's commentsTypedFirsts): author refs and their earliest
// typed time, never a body or a thread. Each person's earliest comment is
// upserted into their commented row with its original time (the upsert keeps
// the earliest and upgrades a legacy value, so it is safe beside live comments
// and a second scanner). Only the page id and the time are stored: never a
// title or text.
//
// Runs on the every-2-minute tick (cron.ts), so a large install finishes in
// hours, not months; once the marker is written a tick costs one read.

import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import { runtimeStub } from "../runtime/do.js";
import {
  commentedKey,
  FIRST_COMMENT_SCAN_CURSOR_KEY,
  FIRST_COMMENT_SCAN_DONE_KEY,
  FIRST_COMMENT_SCAN_STARTED_KEY,
  KEEP_EARLIEST_TYPED_COMMENT,
} from "./onboarding-firsts.js";

// Each page takes one DO read and at most one D1 write, alongside the other cron work.
export const FIRST_COMMENT_SCAN_BATCH = 8;

/** One page's earliest typed comment per person (user id to ms); throws when its store cannot be read. */
export type PageReader = (
  env: Env,
  artifactId: string,
) => Promise<Map<string, number>>;

export const readPageFirsts: PageReader = async (env, artifactId) => {
  const out = new Map<string, number>();
  for (const r of await runtimeStub(env, artifactId).commentsTypedFirsts()) {
    const at = Date.parse(r.at);
    if (Number.isFinite(at)) out.set(r.ref, at);
  }
  return out;
};

/**
 * Asks the next batch of pages (deleted ones not yet purged too: earned
 * progress stays) and records each person's earliest typed comment. The cursor
 * moves only past pages that were read and written, in order: a page whose
 * store cannot be read (or a failed D1 write) is never marked done, the cursor
 * stops before it and the next tick asks again. When no page is left the marker
 * is written and every later tick is one read. Never throws.
 */
export async function scanFirstComments(
  env: Env,
  /** Pages per tick; injectable for tests. */
  batch: number = FIRST_COMMENT_SCAN_BATCH,
  /** How a page is read; injectable for tests. */
  read: PageReader = readPageFirsts,
): Promise<void> {
  try {
    const { results: marks } = await stmt(
      env.DB,
      "select key, value from settings where key in (?1, ?2, ?3)",
    )
      .bind(
        FIRST_COMMENT_SCAN_DONE_KEY,
        FIRST_COMMENT_SCAN_CURSOR_KEY,
        FIRST_COMMENT_SCAN_STARTED_KEY,
      )
      .all<{ key: string; value: string }>();
    const mark = (k: string) => marks.find((r) => r.key === k)?.value;
    if (mark(FIRST_COMMENT_SCAN_DONE_KEY) !== undefined) return;
    // When the scan began: a person created after it has no older comment to
    // find, so their first_comment need not wait for the scan (analytics.ts).
    if (mark(FIRST_COMMENT_SCAN_STARTED_KEY) === undefined)
      await stmt(
        env.DB,
        "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
      )
        .bind(FIRST_COMMENT_SCAN_STARTED_KEY, String(Date.now()))
        .run();
    const cursor = mark(FIRST_COMMENT_SCAN_CURSOR_KEY) ?? "";
    const { results } = await stmt(
      env.DB,
      "select id from artifacts where id > ?1 order by id limit ?2",
    )
      .bind(cursor, batch)
      .all<{ id: string }>();
    let safe: string | null = null;
    for (const { id } of results) {
      try {
        const firsts = await read(env, id);
        if (firsts.size) {
          // One bound parameter for the page, capped by its 5,000-comment limit.
          await stmt(
            env.DB,
            `insert into settings (key, value)
            select ?1 || u.id, json_object('artifactId', ?2, 'at', j.value)
            from json_each(?3) j join users u on u.id = j.key
            where u.role <> 'guest' and u.status = 'active'
            ${KEEP_EARLIEST_TYPED_COMMENT}`,
          )
            .bind(
              commentedKey(""),
              id,
              JSON.stringify(Object.fromEntries(firsts)),
            )
            .run();
        }
        safe = id;
      } catch (e) {
        logWarn("first_comment_scan_page_failed", {
          code: e instanceof Error ? e.name : "error",
        });
        break;
      }
    }
    if (safe !== null)
      // Only forward: a second scanner never moves it back.
      await stmt(
        env.DB,
        `insert into settings (key, value) values (?1, ?2)
         on conflict (key) do update set value = excluded.value
         where excluded.value > settings.value`,
      )
        .bind(FIRST_COMMENT_SCAN_CURSOR_KEY, safe)
        .run();
    if (
      results.length === batch ||
      (results.length && safe !== results.at(-1)?.id)
    )
      return;
    await stmt(
      env.DB,
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
    )
      .bind(FIRST_COMMENT_SCAN_DONE_KEY, String(Date.now()))
      .run();
  } catch (e) {
    logWarn("first_comment_scan_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}
