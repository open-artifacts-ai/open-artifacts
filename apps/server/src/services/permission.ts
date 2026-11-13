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
 * Control (Cc), format (Cf: bidi overrides, zero-width, BOM), line and
 * paragraph separators, lone surrogates and variation selectors. What a card
 * shows must be what runs ("Trojan Source").
 */
const UNSAFE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|[\uFE00-\uFE0F]|[\u180B-\u180D]|[\u{E0100}-\u{E01EF}]/u;

/** 400 unsafe_characters for any field holding such a character; only `command` may hold \n and \t. */
export function refuseUnsafe(r: PermissionRequest, question?: string): void {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(r) as [string, string][]) {
    const text = k === "command" ? v.replace(/[\n\t]/g, "") : v;
    if (UNSAFE.test(text)) bad.push(k);
  }
  if (question !== undefined && UNSAFE.test(question.replace(/[\n\t]/g, "")))
    bad.push("question");
  if (bad.length)
    throw new ApiError(
      "unsafe_characters",
      `A control, bidirectional or invisible character is not allowed in: ${bad.join(", ")}`,
      { fields: bad },
    );
}

/**
 * The keys that name the agent behind a request, strongest first: the bus
 * session it proved (#1822), then the grant or token. [] for a browser
 * session or a bare credential: not an agent.
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

/** Frees the slot of an ask that was used or withdrawn. Never throws. */
export async function releaseSlot(
  env: Env,
  id: string,
  now = Date.now(),
): Promise<void> {
  try {
    await stmt(
      env.DB,
      "update permission_asks set done_at = ?1 where id = ?2 and done_at is null",
    )
      .bind(now, id)
      .run();
  } catch {
    // The slot frees itself when the ask expires.
  }
}
