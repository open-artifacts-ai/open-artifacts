import { z } from "zod";
import { LIMITS } from "./limits.js";
import { MachineLabelSchema } from "./refs.js";

/** ISO 8601 with offset, as every wire timestamp. */
export const IsoTimeSchema = z.string().datetime({ offset: true });

export const STATUS_STATES = [
  "working",
  "idle",
  "blocked",
  "waiting_on_owner",
] as const;
export const StatusStateSchema = z.enum(STATUS_STATES);
export type StatusState = z.infer<typeof StatusStateSchema>;

/** `MachineLabelSchema` rules, at most `LIMITS.maxLabelChars` (64) code points. */
export const StatusLabelSchema = MachineLabelSchema.refine(
  (s) => [...s].length <= LIMITS.maxLabelChars,
  "status label too long",
);
/** Self-reported by the agent (`set_status`); shown tagged "agent says". */
export const AgentStatusSchema = z.strictObject({
  state: StatusStateSchema,
  label: StatusLabelSchema.optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** The coalescing window for status updates. */
export const STATUS_WINDOW_MS = 5000;
