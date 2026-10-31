import { z } from "zod";

import { INSTALL_ID_RE, REQUEST_ID_RE, ULID_RE } from "./id-patterns.js";

export { INSTALL_ID_RE, REQUEST_ID_RE, ULID_RE };

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
