import { z } from "zod";
import type { WorkflowParams } from "./ids.js";
import { ProvisioningTokenStatusSchema, type Release } from "./schemas.js";

// ProvisionerRpc (design v7 2.6): the provisioner's WorkerEntrypoint has
// exactly these three methods, and none returns a token field. The API
// caches releases() for 60 s and tokenStatus() for 5 min per isolate.

export const PROVISIONER_RPC_METHODS = [
  "releases",
  "verifyTurnstile",
  "tokenStatus",
] as const;

export type VerifyTurnstileInput = {
  token: string;
  remoteIp: string;
  action: "signup";
  hostname: string;
  /** Honoured only when OA_ENV === "staging": Turnstile's always-pass test secret. */
  testUser: boolean;
};

/** Every accepted token has an end date: daysLeft is null only when invalid; expiring is daysLeft <= 30. */
export const TOKEN_EXPIRING_DAYS = 30;
export const TokenStatusSchema = z
  .object({
    status: ProvisioningTokenStatusSchema,
    expiresAt: z.number().nullable(),
    daysLeft: z.number().nullable(),
  })
  .refine(
    (s) =>
      s.status === "invalid" ||
      (s.daysLeft !== null &&
        s.expiresAt !== null &&
        (s.status === "expiring") === s.daysLeft <= TOKEN_EXPIRING_DAYS),
    "daysLeft is null only when invalid; expiring iff daysLeft <= 30",
  );
export type TokenStatus = z.infer<typeof TokenStatusSchema>;

export interface ProvisionerRpc {
  releases(): Promise<Release[]>;
  verifyTurnstile(i: VerifyTurnstileInput): Promise<{ ok: boolean }>;
  tokenStatus(): Promise<TokenStatus>;
}

// Workflow bindings (ProvisionInstall, ManageInstall): the subset the API and
// scheduler call. Structural, so @oa/shared needs no workers-types.
export type WorkflowInstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};
export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<WorkflowInstanceStatus>;
  terminate(): Promise<void>;
}
export interface WorkflowLike<P = WorkflowParams> {
  create(o: { id: string; params: P }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}
