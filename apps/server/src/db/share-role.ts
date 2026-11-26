import type { ShareRole } from "@oa/shared";
import { sql } from "drizzle-orm";
import { shares } from "./schema.js";

// #2590: a "commenter" share is stored as role 'viewer' with can_comment = 1,
// so the shares table, its CHECK and every older reader stay as they were.
// The API, the schemas and every response say "commenter". This is the one
// place that maps between the two.

/** The columns a share role is stored as. */
export const storedShare = (
  role: ShareRole,
): { role: "viewer" | "editor"; canComment: 0 | 1 } =>
  role === "commenter"
    ? { role: "viewer", canComment: 1 }
    : { role, canComment: 0 };

/** The API role of a stored row. */
export const apiShareRole = (role: string, canComment: number): string =>
  role === "viewer" && canComment === 1 ? "commenter" : role;

/** A preserved member Viewer grant from before explicit Viewer meant read-only. */
export const LEGACY_COMMENT = `coalesce((select lc.can_comment from legacy_viewer_comments lc
  where lc.artifact_id = shares.artifact_id and lc.email = shares.email order by lc.id desc limit 1), 0)`;

/** The API role of the `shares` row in a drizzle query (a `case`). */
export const shareRoleSql = <T extends ShareRole | null = ShareRole | null>() =>
  sql<T>`(case when ${shares.role} = 'viewer' and (${shares.canComment} = 1 or ${sql.raw(LEGACY_COMMENT)}) then 'commenter' else ${shares.role} end)`;

/** The same case for raw SQL over a table named `t` (empty: unqualified). */
export const SHARE_ROLE_CASE = `case when role = 'viewer' and can_comment = 1 then 'commenter' else role end`;
