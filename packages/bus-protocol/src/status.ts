import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { MachineLabelSchema } from "./refs.ts";

/** ISO 8601 with offset, as every wire timestamp. */
export const IsoTimeSchema = z.string().datetime({ offset: true });

export const STATUS_STATES = [
  "working",
  "idle",
  "blocked",
  "waiting_on_owner",
] as const;
export const StatusStateSchema = z.enum(STATUS_STATES);

/**
 * agy S2b: the status label the daemon sets (with state `idle`) on an agy
 * session it listed from the process table before its first message. The
 * roster has no "starting" state, so this rides on the status every reader
 * already shows; the dashboard shows it as "Starting". The joined
 * conversation takes the address over and starts with no status.
 */
export const AGY_STARTING_LABEL = "starting";
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
