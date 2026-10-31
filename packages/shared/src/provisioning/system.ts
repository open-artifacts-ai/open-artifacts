// Jobs the scheduler inserts itself (design v7 3.1, 4.1, 5.8): purge after
// grace and the sweep's cleanup. No zod: `@oa/shared/provisioning/system`.
import { PURGE_STUCK_FAILURES } from "./alerts.js";
import { bodyHash, type SystemRouteKey } from "./bodyhash.js";
import type { JobKind } from "./enum-values.js";

/** The scheduler's principal on its jobs (4.1: `system:<name>`, 5.8). */
export const SYSTEM_ACTOR = Object.freeze({
  kind: "system",
  key: "system:scheduler",
  label: "scheduler",
} as const);

/** The job kinds the scheduler inserts. */
export const SYSTEM_JOB_KINDS = [
  "purge",
  "cleanup",
] as const satisfies readonly JobKind[];
export type SystemJobKind = (typeof SYSTEM_JOB_KINDS)[number];

/**
 * `jobs.args` of a scheduler purge: the grace end it is for and the try
 * number in its request id. Proposed (C5); the design fixes only `{version,
 * from, to, reason}` as the keys routes use.
 */
export interface PurgeJobArgs {
  purgeAt: number;
  n: number;
}
/** `jobs.args` of a sweep cleanup (also in `jobs.parent_job_id`). Proposed (C5). */
export interface CleanupJobArgs {
  parentJobId: string;
}
export type SystemJobArgs = {
  purge: PurgeJobArgs;
  cleanup: CleanupJobArgs;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const INSTALL_ID = /^i[a-z0-9]{11}$/;

/**
 * A job id (3.1 `ULID_RE`): 48-bit ms time `now`, then 80 random bits. Ids
 * minted in the same ms are unordered among themselves.
 */
export function newJobId(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48)
    throw new Error("newJobId: ULID time must be an integer in [0, 2^48)");
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD[t % 32] + time;
  // 16 bytes, 5 bits each: 80 bits, no modulo bias.
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let rest = "";
  for (const b of rnd) rest += CROCKFORD[b & 31];
  return time + rest;
}

/** Failed purges before `purge_stuck` opens and the scheduler stops (5.8 "cap 3"). */
export const PURGE_MAX_TRIES = PURGE_STUCK_FAILURES;

/**
 * The request id of a scheduler purge (5.8): `purge-<id>-<purge_at>-<n>`,
 * `n` the failed purge jobs so far, so 0, 1 or 2.
 */
export function purgeRequestId(
  installId: string,
  purgeAt: number,
  n: number,
): string {
  if (typeof installId !== "string" || !INSTALL_ID.test(installId))
    throw new Error("purgeRequestId needs an install id");
  if (!Number.isInteger(purgeAt) || purgeAt < 0)
    throw new Error("purgeRequestId: purge_at must be epoch ms");
  if (!Number.isInteger(n) || n < 0 || n >= PURGE_MAX_TRIES)
    throw new Error(
      `purgeRequestId: try ${n} is outside 0..${PURGE_MAX_TRIES - 1}`,
    );
  return `purge-${installId}-${purgeAt}-${n}`;
}

/**
 * The request id of the sweep's cleanup for a dead run: `cleanup-<jobId>`
 * (one per parent; W7's format, the design names none).
 */
export function cleanupRequestId(parentJobId: string): string {
  if (typeof parentJobId !== "string" || !ULID.test(parentJobId))
    throw new Error("cleanupRequestId needs a job id (ULID)");
  return `cleanup-${parentJobId}`;
}

/** The body_hash route of a system job: `system:<kind>`, never an API RouteId. */
export function systemRouteKey(kind: SystemJobKind): SystemRouteKey {
  if (!(SYSTEM_JOB_KINDS as readonly string[]).includes(kind))
    throw new Error(`not a system job kind: ${String(kind)}`);
  return `system:${kind}`;
}

/** `jobs.body_hash` of a system job (3.1): bodyHash of `{ route: system:<kind>, installId, body: args }`. */
export async function systemJobBodyHash<K extends SystemJobKind>(
  kind: K,
  installId: string,
  args: SystemJobArgs[K],
): Promise<string> {
  return bodyHash(systemRouteKey(kind), installId, args);
}
