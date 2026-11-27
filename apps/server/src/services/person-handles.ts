import { newId } from "@oa/shared";
import { accessLevels, callerOf } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { getUsers } from "./users.js";

export async function handleAvailability(
  env: Env,
  userId: string,
  handle: string,
) {
  const taken = (candidate: string) =>
    stmt(env.DB, "select 1 from users where handle = ? and id <> ?")
      .bind(candidate, userId)
      .first<number>("1");
  if (!(await taken(handle))) return { available: true, suggestion: null };
  // Try a readable suffix first, then a longer suffix on a crowded name.
  for (let n = 2; ; n++) {
    const suffix = n <= 4 ? String(n) : newId().slice(-8).toLowerCase();
    const candidate = handle.slice(0, 29 - suffix.length) + "-" + suffix;
    if (!(await taken(candidate)))
      return { available: false, suggestion: candidate };
  }
}

/** Resolve whole @tokens against current handles. Email addresses are plain text. */
export async function mentionedHandles(
  env: Env,
  body: string,
  artifactId: string,
): Promise<Record<string, string>> {
  const tokens = [
    ...new Set(
      Array.from(
        body.matchAll(/(?:^|\s)@([a-z0-9._-]+)(?=$|[\s,;:!?)\]])/gi),
        (m) => (m[1] ?? "").toLowerCase(),
      ),
    ),
  ];
  const handles = [
    ...new Set(
      tokens
        .flatMap((t) => [t, t.replace(/\.+$/, "")])
        .filter((t) => t.length >= 2 && t.length <= 30),
    ),
  ];
  if (!handles.length) return {};
  const { results } = await stmt(
    env.DB,
    "select id, handle from users where status='active' and handle in (select value from json_each(?))",
  )
    .bind(JSON.stringify(handles))
    .all<{ id: string; handle: string }>();
  const byHandle = new Map(results.map((r) => [r.handle, r.id]));
  const people = new Map<string, string>();
  for (const token of tokens) {
    const handle = byHandle.has(token) ? token : token.replace(/\.+$/, "");
    const id = byHandle.get(handle);
    if (id) people.set(id, handle);
  }
  const users = [...(await getUsers(env, [...people.keys()])).values()];
  const levels = await accessLevels(
    env,
    users.map((user) => callerOf(user)),
    artifactId,
  );
  const labels: Record<string, string> = {};
  for (const [i, user] of users.entries()) {
    const handle = people.get(user.id);
    if (handle && levels[i]?.artifact) labels[user.id] = handle;
  }
  return labels;
}
