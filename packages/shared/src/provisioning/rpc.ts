import { z } from "zod";
import { TOKEN_EXPIRING_DAYS } from "./constants.js";
import { ProvisioningTokenStatusSchema, type Release } from "./schemas.js";

// ProvisionerRpc (design v7 2.6): the provisioner's WorkerEntrypoint has
// exactly these three methods, and none returns a token field. The API
// caches releases() for 60 s and tokenStatus() for 5 min per isolate;
// releases({ version }) reads that one version only and is not cached.

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
export { TOKEN_EXPIRING_DAYS };
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
  /** With `version`: that release alone, or [] when unknown or below the floor. */
  releases(o?: { version?: string }): Promise<Release[]>;
  verifyTurnstile(i: VerifyTurnstileInput): Promise<{ ok: boolean }>;
  tokenStatus(): Promise<TokenStatus>;
}

// The Workflow binding types moved to workflow.ts (zod-free).
export * from "./workflow.js";
