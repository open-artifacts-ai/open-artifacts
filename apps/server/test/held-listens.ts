// #2577: a person's agent takes a request from someone only when that person
// has them on their "listens to" list. Tests about what an agent does with a
// request (not about holding it) list the people in them on each other's.
import { newId } from "@oa/shared";
import type { Env } from "../src/env.js";

export async function listenEachOther(
  env: Env,
  userIds: string[],
): Promise<void> {
  const until = Date.now() + 300 * 86_400_000;
  for (const owner of userIds)
    for (const member of userIds) {
      if (owner === member) continue;
      await env.DB.prepare(
        `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, until, created_via, created_at)
         values (?1, ?2, ?3, 'all', null, ?4, 'settings', ?5)`,
      )
        .bind(newId(), owner, member, until, Date.now())
        .run();
    }
}
