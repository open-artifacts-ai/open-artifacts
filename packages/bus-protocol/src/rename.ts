import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { BusNameSchema } from "./names.ts";
import { IsoTimeSchema } from "./status.ts";

/**
 * Renames (#393, ported from OpenBus R393a). No version gate: the hub sends
 * roster `former_names` and a former-name receipt `to_name` only to a socket
 * whose `hello` listed `BUS_CAPS.rename` (caps.ts). BusHub handles `rename`
 * since R393b.
 */

/** Pinned `error` messages for `rename` refusals. Clients may match on them. */
export const RENAME_MESSAGES = {
  /** `rate_limited`: past LIMITS.renamesPerHour name changes in a rolling hour, or LIMITS.maxFormerNames chosen former names in their grace (OpenBus #446). */
  rate: "Too many renames",
} as const;

/**
 * Whose name it is (#393 amendment 1). `default`: the harness's fallback
 * (`pi`, `codex`, `code-96`), which nobody chose; the hub mints it as
 * `<base>-<4 hex>`, never reuses it and doesn't reserve it after a rename.
 * `chosen`: anything else, reserved for the grace after a rename. Only the
 * client knows which, so it says so; absent means `chosen`, since reserving
 * a default is the safe error.
 */
export const NAME_KINDS = ["default", "chosen"] as const;
export const NameKindSchema = z.enum(NAME_KINDS);
export type NameKind = z.infer<typeof NameKindSchema>;

/** A name the agent left, which still reaches it until `expires_at`. */
export const FormerNameSchema = z.strictObject({
  name: BusNameSchema,
  expires_at: IsoTimeSchema,
});

/**
 * An agent's live former names: 1 to LIMITS.maxFormerNames; the hub omits the
 * field when there are none. It holds no more rows than it shows (OpenBus
 * #446): past the cap a default one is dropped first, and a chosen one in
 * its grace never is (the rename is refused instead).
 *
 * The hub also guarantees, and its tests pin (R393b): newest first
 * (`expires_at` non-increasing), distinct case-insensitively, and never equal
 * to the row's `bus_name` case-insensitively. The decoder does not enforce
 * these: one bad row would otherwise fail the whole roster.
 */
export const FormerNamesSchema = z
  .array(FormerNameSchema)
  .min(1)
  .max(LIMITS.maxFormerNames);

export type FormerName = z.infer<typeof FormerNameSchema>;
