import { z } from "zod";
import { newMsgId } from "./ids.ts";
import { BusNameSchema } from "./names.ts";

export const RECEIPT_STATES = [
  "pending",
  "delivered",
  "expired",
  "refused",
] as const;
export const ReceiptStateSchema = z.enum(RECEIPT_STATES);
export type ReceiptState = z.infer<typeof ReceiptStateSchema>;

export const REFUSAL_REASONS = [
  "unknown_agent",
  "closed",
  "inbox_full",
  "too_large",
  "other_namespace",
  "revoked",
  "ambiguous",
  /**
   * A role address (#1296) with no holder: vacated, or its holder closed,
   * gone or out of the role's namespace. The hub sends it only to a socket
   * whose hello listed `BUS_CAPS.roles`; any other gets `unknown_agent`.
   */
  "role_vacant",
  /** A reply's `to_id` no longer holds the name: the agent it answers is gone. */
  "agent_gone",
] as const;
export const RefusalReasonSchema = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

/** `recipient_closed` is the hub's expiry reason on reconnect; not a send refusal. */
export const ReceiptReasonSchema = z.union([
  RefusalReasonSchema,
  z.literal("recipient_closed"),
]);
export type ReceiptReason = z.infer<typeof ReceiptReasonSchema>;

export const MsgIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{16}$/);
export const newReceiptId = newMsgId;

/**
 * A reason rides on `refused` (a pinned enum) and on `expired`
 * ("recipient_closed"); `pending` and `delivered` carry none.
 */
export const receiptReasonMatchesState = (r: {
  state: ReceiptState;
  reason?: ReceiptReason | undefined;
}): boolean =>
  (r.state === "refused" &&
    r.reason !== undefined &&
    r.reason !== "recipient_closed") ||
  (r.state === "expired" &&
    (r.reason === undefined || r.reason === "recipient_closed")) ||
  ((r.state === "pending" || r.state === "delivered") &&
    r.reason === undefined);

/** Shared by `ReceiptSchema` and the `receipt` / `receipt_update` frames. */
export const receiptShape = {
  msg_id: MsgIdSchema,
  state: ReceiptStateSchema,
  reason: ReceiptReasonSchema.optional(),
  /**
   * The recipient's current bus name, only when the send resolved through a
   * former name (#393), to a socket whose hello listed `BUS_CAPS.rename`, or
   * through a role address (#1296, the role's holder), to a socket whose
   * hello listed `BUS_CAPS.roles`. An ordinary send never carries it.
   */
  to_name: BusNameSchema.optional(),
} as const;

export const ReceiptSchema = z
  .strictObject(receiptShape)
  .refine(receiptReasonMatchesState, "reason does not match state");
export type Receipt = z.infer<typeof ReceiptSchema>;

export function receiptLabel(r: Receipt): string {
  return r.reason ? `${r.state}: ${r.reason}` : r.state;
}
