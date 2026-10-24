import { DurableObject } from "cloudflare:workers";
import type { SyncStatus } from "@oa/shared";
import type { Env } from "../env.js";
import type { AuditActor } from "../services/audit.js";
import { type KickReason, SyncEngine, type SyncJob } from "./sync.js";

export type { KickReason, SyncJob } from "./sync.js";

/**
 * One per install (idFromName(SYNC_DO_NAME)): Google polling, reconcile,
 * health and the queued access jobs (P3 T13). The engine (sync.ts) holds the
 * logic; this class is its alarm and RPC surface.
 */
export class DirectorySync extends DurableObject<Env> {
  private engine: SyncEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new SyncEngine(env, ctx.storage, ctx);
  }

  kick(reason: KickReason): Promise<SyncStatus> {
    return this.engine.kick(reason);
  }

  status(): Promise<SyncStatus> {
    return this.engine.status();
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
