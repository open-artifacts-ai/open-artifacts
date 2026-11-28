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
 * #3363: fixed, closed set of short labels for daemon-set permission waits.
 * Never free text: a label outside this set is refused on the wire.
 */
export const PERMISSION_WAIT_LABELS = [
  "run a command",
  "edit a file",
  "use a tool",
  "other",
] as const;
export const PermissionWaitLabelSchema = z.enum(PERMISSION_WAIT_LABELS);
export type PermissionWaitLabel = z.infer<typeof PermissionWaitLabelSchema>;

/** Daemon-set waiting state input (e.g. `agent_waiting` frame); never agent-writable. */
export const AgentWaitingInputSchema = z.strictObject({
  kind: z.literal("permission"),
  label: PermissionWaitLabelSchema.optional(),
});
export type AgentWaitingInput = z.infer<typeof AgentWaitingInputSchema>;

/** Daemon-set waiting state on roster rows and status views (#3363). */
export const AgentWaitingSchema = z.strictObject({
  kind: z.literal("permission"),
  label: PermissionWaitLabelSchema.optional(),
  since: IsoTimeSchema,
});
export type AgentWaiting = z.infer<typeof AgentWaitingSchema>;

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
