// "◷ waiting" (#2512, #2761): an open ask is waiting on its person when the
// asking agent is the person's own and is blocked on the bus right now. One
// rule for the inbox, the page's ask card and the Library card.
import type { Env } from "../env.js";
import type { StoredActor } from "../runtime/comments-store.js";
import { agentsWaitingOn } from "./bus.js";

/**
 * When the wait on an ask began: the later of the agent's blocked time (the
 * hub's) and the ask's own time, since a wait on this ask cannot start before
 * it was asked. A bad `askedAt` leaves the hub's time. Undefined: not waiting
 * (also when the hub's time is not a finite number: callers print it as an
 * ISO date, which throws on NaN or Infinity).
 */
export function waitingSince(
  began: number | undefined,
  askedAt: string,
): number | undefined {
  if (began === undefined || !Number.isFinite(began)) return undefined;
  const askedMs = Date.parse(askedAt);
  const since = Number.isNaN(askedMs) ? began : Math.max(began, askedMs);
  return since;
}

/** The identity of `asker` when it is one of `userId`'s own agents, else undefined. */
export const ownAgentId = (
  asker: StoredActor,
  userId: string,
): string | undefined =>
  asker.kind === "user" && asker.ref === userId
    ? asker.agent?.identity?.identityId
    : undefined;

/**
 * Which of `userId`'s own agents that asked (identity id → blocked since, ms),
 * from their hub in one call. No call when none of the askers is theirs, a
 * miss or a failing hub gives an empty map: never throws.
 */
export async function waitingAgents(
  env: Env,
  userId: string,
  askers: StoredActor[],
): Promise<Map<string, number>> {
  const ids = new Set<string>();
  for (const a of askers) {
    const id = ownAgentId(a, userId);
    if (id) ids.add(id);
  }
  if (ids.size === 0) return new Map();
  return agentsWaitingOn(env, userId, [...ids]);
}

/**
 * The Library card's mark: per artifact, how many open asks wait on `userId`
 * and the oldest wait. One D1 read of their open asks on `artifactIds`, one hub
 * call. Fails soft: an empty map.
 */
export async function libraryWaiting(
  env: Env,
  userId: string,
  artifactIds: string[],
): Promise<Map<string, { count: number; oldestSince: number }>> {
  const out = new Map<string, { count: number; oldestSince: number }>();
  if (artifactIds.length === 0) return out;
  try {
    const { results } = await env.DB.prepare(
      `select artifact_id, asker, asked_at from artifact_asks
        where addressee = ?1 and open = 1 and question is not null and asker is not null
          and artifact_id in (select value from json_each(?2))`,
    )
      .bind(userId, JSON.stringify(artifactIds))
      .all<{ artifact_id: string; asker: string; asked_at: string | null }>();
    const rows = results
      .map((r) => ({
        artifactId: r.artifact_id,
        askedAt: r.asked_at ?? "",
        asker: JSON.parse(r.asker) as StoredActor,
      }))
      .filter((r) => ownAgentId(r.asker, userId) !== undefined);
    if (rows.length === 0) return out;
    const waiting = await waitingAgents(
      env,
      userId,
      rows.map((r) => r.asker),
    );
    for (const r of rows) {
      const since = waitingSince(
        waiting.get(ownAgentId(r.asker, userId) as string),
        r.askedAt,
      );
      if (since === undefined) continue;
      const cur = out.get(r.artifactId);
      out.set(r.artifactId, {
        count: (cur?.count ?? 0) + 1,
        oldestSince: cur ? Math.min(cur.oldestSince, since) : since,
      });
    }
  } catch {
    return new Map();
  }
  return out;
}
