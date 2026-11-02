import { z } from "zod";
import { API_ERROR_CODES, JOB_ERROR_CODES } from "./error-codes.js";

// The codes and their types live in error-codes.ts (zod-free).
export * from "./error-codes.js";

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** The API envelope (same shape as ApiErrorSchema in ../errors.ts). */
export const ProvisioningErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ProvisioningError = z.infer<typeof ProvisioningErrorSchema>;

export const JobErrorCodeSchema = z.enum(JOB_ERROR_CODES);
