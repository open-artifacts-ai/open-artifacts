import type { DirectoryGroup, DirectoryGroupsQuery, Page } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logWarn } from "../log.js";
import { directoryMode } from "../services/spaces.js";
import { directoryClient } from "./client.js";
import { GoogleApiError, listGroups } from "./google.js";
import { readBinding } from "./store.js";
import { TransportError } from "./transport.js";

// GET R.directoryGroups (P3 T13): a live groups.list lookup for the mapping
// pickers, limited by RL_DIRECTORY per caller. The groups it returns are
// recorded in directory_groups (id and email, insert only), so a mapping or
// restricted-group PUT can name a group the hourly reconcile hasn't read yet.

/** Results per page (Admin SDK groups.list maxResults). */
export const GROUPS_LOOKUP_PAGE = 50;

/** Characters kept from `q`: what a group email or name prefix needs. */
const UNSAFE_Q = /[^\p{L}\p{N}@._+\- ]/gu;

const RECORD = `insert or ignore into directory_groups (group_id, email)
  select json_extract(value, '$.id'), json_extract(value, '$.email')
  from json_each(?1)`;

export async function lookupGroups(
  env: Env,
  q: DirectoryGroupsQuery,
): Promise<Page<DirectoryGroup>> {
  const client = directoryClient(env);
  if (directoryMode(env) !== "google" || !client)
    throw new ApiError("directory_sync_off", "Directory sync is off or frozen");
  const { binding, sealed } = await readBinding(env);
  if (!binding || !sealed) throw new ApiError("not_found", "Not found");
  const term = (q.q ?? "").replace(UNSAFE_Q, "").trim().slice(0, 100);
  try {
    const token = await client.accessToken(sealed);
    const page = await listGroups(token, binding.customerId, {
      query: term ? `email:${term.replace(/ /g, "")}*` : undefined,
      pageToken: q.cursor,
      maxResults: GROUPS_LOOKUP_PAGE,
    });
    if (page.groups.length)
      await stmt(env.DB, RECORD)
        .bind(
          JSON.stringify(
            page.groups.map((g) => ({ id: g.id, email: g.email })),
          ),
        )
        .run();
    return {
      items: page.groups.map((g) => ({
        groupId: g.id,
        email: g.email,
        name: g.name,
        memberCount: g.directMembersCount,
      })),
      nextCursor: page.nextPageToken,
    };
  } catch (e) {
    if (e instanceof GoogleApiError || e instanceof TransportError) {
      logWarn("directory_groups_lookup", e);
      throw new ApiError("conflict", "Google didn't answer; try again");
    }
    throw e;
  }
}
