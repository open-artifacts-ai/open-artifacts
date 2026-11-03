import type { HeldSweep } from "@oa/shared";
import type { Health } from "../directory/health.js";
import { type HookEnv, testHooksOn } from "./on.js";

// The directory-held hook's DO half (#1078): puts a held sweep on a suite
// group, or takes it off, in the same places real sync keeps one (the
// DirectorySync DO's held table and the D1 health row's held list), so the
// owner's snooze and cancel routes run unchanged against it. Only
// directory/sync.ts (testHold) and directory/connect.ts (testHeldShown) reach
// this, each through a build-flag gate: release builds drop it with the rest
// of test-hooks/.

/** What the hold needs from the engine (directory/sync.ts testHold). */
export interface TestHoldIo {
  sql: SqlStorage;
  transactionSync<T>(f: () => T): T;
  /** The hold's member-list hash, as a sweep would record it. */
  hash(): Promise<string>;
  /** Ends the group's snooze written at `at` (audited "released"). */
  endSnooze(groupId: string, at: number): Promise<void>;
  /**
   * An RPC's health write (compare-and-set), creating the row if absent.
   * False: every try lost a race and nothing was written.
   */
  health(f: (h: Health) => Health): Promise<boolean>;
  /** The group ids in the stored D1 held list, read fresh. */
  heldIds(): Promise<string[]>;
}

/**
 * Write-and-confirm rounds before the hook gives up. A round is lost when
 * the compare-and-set loses every try, or an alarm's blind health write
 * lands over it before the re-read; no later alarm puts a test hold back.
 */
const CONFIRM_ROUNDS = 3;

/**
 * Writes the held list with `f` until a fresh read shows `groupId` in it
 * (`want`) or not. Throws when it never does, so the hook answers an error
 * rather than a hold the owner can't see (or one left counted).
 */
async function confirmHealth(
  io: TestHoldIo,
  groupId: string,
  want: boolean,
  f: (h: Health) => Health,
): Promise<void> {
  for (let i = 0; i < CONFIRM_ROUNDS; i++) {
    if (!(await io.health(f))) continue;
    if ((await io.heldIds()).includes(groupId) === want) return;
  }
  throw new Error("held list write lost");
}

// `test-` ids only, here in SQL too (no LIKE wildcards), so a slip in the
// handler can never write, change or drop a real group's hold.
const HOLD = `insert into held (group_id, since, kind, would, hash)
  select ?1, ?2, 'sweep', 1, ?3 where substr(?1, 1, 5) = 'test-'
  on conflict (group_id) do update set kind = 'sweep', would = 1,
    hash = excluded.hash, confirmed_at = null
  where substr(held.group_id, 1, 5) = 'test-'`;
const RELEASE =
  "delete from held where group_id = ?1 and substr(group_id, 1, 5) = 'test-'";
const SNOOZE_AT =
  "select at from snoozed where group_id = ?1 and substr(group_id, 1, 5) = 'test-'";

/**
 * The held list SyncStatus shows on an install with no directory binding
 * (directory/connect.ts directoryStatus): the test hook's holds only, while
 * hooks are live. Real sync never holds a sweep without a binding, so a
 * status without one shows none; a red-line install has no binding, and its
 * snooze case must still see its `test-` hold. Anything not `test-`, or
 * hooks off: nothing, as without this.
 */
export function testHeldShown(env: HookEnv, held: HeldSweep[]): HeldSweep[] {
  if (!testHooksOn(env)) return [];
  return held.filter((x) => x.groupId.startsWith("test-"));
}

/**
 * `on`: `groupId` held (one removal waiting, two members), shown in the held
 * list as `email`. Off: the hold and any snooze of it gone. Returns whether
 * the group is held now. Throws on an unprefixed id, and when the D1 held
 * list never shows the change (confirmHealth).
 */
export async function testHold(
  io: TestHoldIo,
  groupId: string,
  email: string,
  on: boolean,
  now: number,
): Promise<boolean> {
  if (!groupId.startsWith("test-")) throw new Error("not a test group");
  if (on) {
    const hash = await io.hash();
    const prior = io.sql
      .exec("select since from held where group_id = ?", groupId)
      .toArray()[0];
    const since = prior ? Number(prior.since) : now;
    io.transactionSync(() => io.sql.exec(HOLD, groupId, since, hash));
    const entry: HeldSweep = {
      groupId,
      email,
      name: email,
      wouldRemove: 1,
      members: 2,
      since: new Date(since).toISOString(),
      snoozedUntil: null,
      snoozeReason: null,
    };
    await confirmHealth(io, groupId, true, (h) => ({
      ...h,
      held: [...h.held.filter((x) => x.groupId !== groupId), entry],
    }));
    return true;
  }
  const z = io.sql.exec(SNOOZE_AT, groupId).toArray()[0];
  if (z) await io.endSnooze(groupId, Number(z.at));
  io.transactionSync(() => io.sql.exec(RELEASE, groupId));
  await confirmHealth(io, groupId, false, (h) => ({
    ...h,
    held: h.held.filter((x) => x.groupId !== groupId),
  }));
  return false;
}
