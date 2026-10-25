import { DurableObject } from "cloudflare:workers";
import type { SyncStatus } from "@oa/shared";
import type { Env } from "../env.js";

/** Why a run was asked for (P3 T13). */
export type KickReason = "cron" | "mapping" | "manual" | "signin";

/** A queued access job (P3 T9: space-wide socket closes, revocation retries). */
export type SyncJob = { kind: string; [k: string]: unknown };

/** SyncStatus before any successful run: nothing bound, nothing synced. */
export function neverStatus(): SyncStatus {
  return {
    mode: "off",
    binding: null,
    healthy: null,
    state: "never",
    unhealthySince: null,
    lastSuccessAt: null,
    lastError: null,
    nextRunAt: null,
    staleAt: null,
    alertedAt: null,
    customerMismatch: null,
    held: [],
    pendingCount: null,
    pendingCountCapped: false,
    pendingExpiresAt: null,
  };
}

/**
 * One per install (idFromName("install")): Google polling, reconcile and the
 * queued access jobs (P3 T13). This release ships the class inert, one
 * release before anything calls it (the P1 rule): no storage, no alarm, and
 * every RPC answers the "never" status.
 */
export class DirectorySync extends DurableObject<Env> {
  async kick(_reason: KickReason): Promise<SyncStatus> {
    return neverStatus();
  }

  async status(): Promise<SyncStatus> {
    return neverStatus();
  }

  async confirmHeld(_groupId: string): Promise<SyncStatus> {
    return neverStatus();
  }

  async enqueue(_job: SyncJob): Promise<void> {}
}
