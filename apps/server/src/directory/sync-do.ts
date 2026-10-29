import { DurableObject } from "cloudflare:workers";
import type { SyncStatus } from "@oa/shared";
import { withoutCred } from "../auth/cred.js";
import type { Env } from "../env.js";
import type { AuditActor } from "../services/audit.js";
import {
  type KickReason,
  type MintFault,
  SyncEngine,
  type SyncJob,
  TokenBox,
} from "./sync.js";

export type { KickReason, SyncJob } from "./sync.js";

/**
 * One per install (idFromName(SYNC_DO_NAME)): Google polling, reconcile,
 * health and the queued access jobs (P3 T13). The engine (sync.ts) holds the
 * logic; this class is its alarm and RPC surface. The directory access token
 * lives in `box`, in memory only (sync.ts TokenBox).
 *
 * Every entry point runs withoutCred (#803): an RPC from a request never lends
 * this DO that request's credential. A row written here for a user's action
 * gets it explicitly on the actor (confirmHeld's and the snoozes' `by`, via
 * withRequestCred); alarm work records `system`.
 */
export class DirectorySync extends DurableObject<Env> {
  private engine: SyncEngine;
  private box = new TokenBox();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new SyncEngine(env, ctx.storage, ctx, this.box);
  }

  kick(reason: KickReason): Promise<SyncStatus> {
    return withoutCred(() => this.engine.kick(reason));
  }

  status(): Promise<SyncStatus> {
    return withoutCred(() => this.engine.status());
  }

  /** A run is due and no token is in hand (services/directory.ts feedSync). */
  wantsToken(): Promise<boolean> {
    return withoutCred(() => this.engine.wantsToken());
  }

  /** The caller's freshly minted token (never its capability), or why it failed. */
  handToken(
    forKey: string,
    h: { token: string } | { error: MintFault },
  ): Promise<void> {
    return withoutCred(() => this.engine.handToken(forKey, h));
  }

  /** Null: nothing confirmable (no hold, or an unreadable group). */
  confirmHeld(groupId: string, by?: AuditActor): Promise<SyncStatus | null> {
    return withoutCred(() => this.engine.confirmHeld(groupId, by));
  }

  /** Null: nothing snoozable (no sweep hold, or not yet re-read since #412). */
  snoozeHeld(
    groupId: string,
    by: AuditActor,
    reason: string | null,
  ): Promise<SyncStatus | null> {
    return withoutCred(() => this.engine.snoozeHeld(groupId, by, reason));
  }

  unsnoozeHeld(groupId: string, by: AuditActor): Promise<SyncStatus> {
    return withoutCred(() => this.engine.unsnoozeHeld(groupId, by));
  }

  reset(): Promise<void> {
    return withoutCred(() => this.engine.reset());
  }

  enqueue(job: SyncJob): Promise<void> {
    return withoutCred(() => this.engine.enqueue(job));
  }

  async alarm(): Promise<void> {
    await withoutCred(() => this.engine.alarm());
  }
}
