import type { PermissionRequest } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { sha256Hex } from "../util/crypto.js";
import { type AgentAttr, viaKey } from "./agent-usage.js";

// #1958: asking to run one command from the page. The pieces that are not
// storage: the request hash, the character refusal, who the agent is, the page
// nobody else can read, and the caps that span artifacts.

/** The most permission asks one agent may have pending at once. */
export const PERMISSION_PENDING_MAX = 3;
/** The most permission asks one agent may create in an hour. */
export const PERMISSION_HOURLY_MAX = 20;

/**
 * The request hash: hex sha256 of this fixed encoding of the request. The
 * only place the encoding exists. The server computes it; a client never
 * sends one.
 */
export const permissionReqHash = (r: PermissionRequest): Promise<string> =>
  sha256Hex(
    JSON.stringify([
      "oa-perm-v1",
      r.toolName,
      r.command,
      r.cwd,
      r.sessionId,
      r.machineId,
    ]),
  );

/**
 * An allowlist: a field may hold only letters, numbers, punctuation, symbols
 * and the ASCII space. That refuses every control, format, separator and
 * mark character, and every non-ASCII space. Some invisible characters are
 * letters or symbols, so those are refused by name, with everything Unicode
 * marks default-ignorable. What a card shows must be what runs ("Trojan
 * Source").
 */
const ALLOWED = /^[\p{L}\p{N}\p{P}\p{S} ]*$/u;
const INVISIBLE =
  /\u115F|\u1160|\u3164|\uFFA0|\u2800|\u034F|\u17B4|\u17B5|\p{Default_Ignorable_Code_Point}/u;

const unsafeText = (v: string): boolean =>
  !ALLOWED.test(v) || INVISIBLE.test(v);

/** 400 unsafe_characters for any field holding such a character; only `command` may hold \n and \t. */
export function refuseUnsafe(r: PermissionRequest, question?: string): void {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(r) as [string, string][]) {
    if (unsafeText(k === "command" ? v.replace(/[\n\t]/g, "") : v)) bad.push(k);
  }
  if (question !== undefined && unsafeText(question)) bad.push("question");
  if (bad.length)
    throw new ApiError(
      "unsafe_characters",
      `Only letters, numbers, punctuation, symbols and plain spaces are allowed in: ${bad.join(", ")}`,
      { fields: bad },
    );
}

/**
 * The keys that name the agent behind a request, strongest first: the bus
 * session it proved (#1822), then the grant or token. [] for a browser
 * session or a bare credential: not an agent. The hook must consume over the
 * same channel it posted on: an ask posted with a bus identity is used only by
 * that identity.
 */
export function agentKeysOf(
  userId: string,
  agent: AgentAttr | null | undefined,
): string[] {
  const keys: string[] = [];
  if (agent?.identity) keys.push(`${userId}|i:${agent.identity.identityId}`);
  if (agent?.via) keys.push(`${userId}|${viaKey(agent.via)}`);
  return keys;
}

/**
 * Whether `userId` is the only person who can read the artifact: theirs, private,
 * not deleted, no share, and in their personal space (a shared space's members
 * can read what is in it).
 */
export async function isSoleReader(
  env: Env,
  artifactId: string,
  userId: string,
): Promise<boolean> {
  const r = await stmt(
    env.DB,
    `select a.owner_id, a.visibility, a.deleted_at, a.space_id, sp.kind,
       (select count(*) from shares s where s.artifact_id = a.id) as shared
     from artifacts a left join spaces sp on sp.id = a.space_id
     where a.id = ?1`,
  )
    .bind(artifactId)
    .first<{
      owner_id: string;
      visibility: string;
      deleted_at: number | null;
      space_id: string | null;
      kind: string | null;
      shared: number;
    }>();
  return (
    !!r &&
    r.owner_id === userId &&
    r.visibility === "private" &&
    r.deleted_at === null &&
    r.shared === 0 &&
    (r.space_id === null || (r.space_id === userId && r.kind === "personal"))
  );
}

/**
 * Takes one of the agent's permission slots, atomically: 429 rate_limited
 * when it has 3 pending (unanswered or answered but not used, not expired,
 * not withdrawn) or has created 20 in the last hour.
 */
export async function reserveSlot(
  env: Env,
  id: string,
  userId: string,
  agentKey: string,
  artifactId: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  const res = await stmt(
    env.DB,
    `insert into permission_asks (id, user_id, agent_key, artifact_id, created_at, expires_at, done_at)
     select ?1, ?2, ?3, ?4, ?5, ?6, null
     where (select count(*) from permission_asks where agent_key = ?3 and done_at is null and expires_at > ?5) < ?7
       and (select count(*) from permission_asks where agent_key = ?3 and created_at > ?8) < ?9`,
  )
    .bind(
      id,
      userId,
      agentKey,
      artifactId,
      now,
      now + ttlMs,
      PERMISSION_PENDING_MAX,
      now - 3_600_000,
      PERMISSION_HOURLY_MAX,
    )
    .run();
  if (!res.meta.changes)
    throw new ApiError(
      "rate_limited",
      "Too many permission requests from this agent. Wait for an answer or for them to expire.",
      undefined,
      { "retry-after": "600" },
    );
}

/**
 * Frees the slot of an ask that was used, withdrawn or never stored, and records
 * which (the audit): `consumed`, `withdrawn` or `failed`. Never throws.
 */
export async function releaseSlot(
  env: Env,
  id: string,
  how: "consumed" | "withdrawn" | "failed",
  now = Date.now(),
): Promise<void> {
  try {
    await stmt(
      env.DB,
      `update permission_asks set done_at = coalesce(done_at, ?1),
         consumed_at = case when ?3 = 'consumed' then coalesce(consumed_at, ?1) else consumed_at end,
         withdrawn_at = case when ?3 = 'withdrawn' then coalesce(withdrawn_at, ?1) else withdrawn_at end
       where id = ?2`,
    )
      .bind(now, id, how)
      .run();
  } catch {
    // The slot frees itself when the ask expires.
  }
}
