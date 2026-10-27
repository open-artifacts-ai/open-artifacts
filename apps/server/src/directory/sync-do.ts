import { DurableObject } from "cloudflare:workers";
import type { SyncStatus } from "@oa/shared";
import type { Env } from "../env.js";
import type { AuditActor } from "../services/audit.js";
import {
  type KickReason,
  SyncEngine,
  type SyncJob,
  TokenBox,
} from "./sync.js";
import type { TransportError } from "./transport.js";

export type { KickReason, SyncJob } from "./sync.js";

/**
 * One per install (idFromName(SYNC_DO_NAME)): Google polling, reconcile,
 * health and the queued access jobs (P3 T13). The engine (sync.ts) holds the
 * logic; this class is its alarm and RPC surface. The directory access token
 * lives in `box`, in memory only (sync.ts TokenBox).
 */
export class DirectorySync extends DurableObject<Env> {
  private engine: SyncEngine;
  private box = new TokenBox();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new SyncEngine(env, ctx.storage, ctx, this.box);
  }

  kick(reason: KickReason): Promise<SyncStatus> {
    return this.engine.kick(reason);
  }

  status(): Promise<SyncStatus> {
    return this.engine.status();
  }

  /** A run is due and no token is in hand (services/directory.ts feedSync). */
  wantsToken(): Promise<boolean> {
    return this.engine.wantsToken();
  }

  /** The caller's freshly minted token (never its capability), or why it failed. */
  handToken(
    forKey: string,
    h: { token: string } | { error: TransportError["stage"] },
  ): Promise<void> {
    return this.engine.handToken(forKey, h);
  }

  /** Null: nothing confirmable (no hold, or an unreadable group). */
  confirmHeld(groupId: string, by?: AuditActor): Promise<SyncStatus | null> {
    return this.engine.confirmHeld(groupId, by);
  }

  reset(): Promise<void> {
    return this.engine.reset();
  }

  enqueue(job: SyncJob): Promise<void> {
    return this.engine.enqueue(job);
  }

  async alarm(): Promise<void> {
    await this.engine.alarm();
  }
}
