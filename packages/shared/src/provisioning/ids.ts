import { z } from "zod";

/** "i" + 11 base32 chars (@oa/provision newInstallId). */
export const INSTALL_ID_RE = /^i[a-z0-9]{11}$/;
/** Crockford base32 ULID; the first char caps the 48-bit time. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** Client-chosen idempotency key, scoped to the principal's actorKey. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const InstallIdSchema = z.string().regex(INSTALL_ID_RE);
export type InstallId = z.infer<typeof InstallIdSchema>;
export const JobIdSchema = z.string().regex(ULID_RE);
export type JobId = z.infer<typeof JobIdSchema>;
export const TokenIdSchema = z.string().regex(ULID_RE);
export type TokenId = z.infer<typeof TokenIdSchema>;
export const RequestIdSchema = z.string().regex(REQUEST_ID_RE);

/** Workflow params (3.6): exactly the job id; everything else is read from D1. */
export const WorkflowParamsSchema = z.object({ jobId: JobIdSchema }).strict();
export type WorkflowParams = z.infer<typeof WorkflowParamsSchema>;
