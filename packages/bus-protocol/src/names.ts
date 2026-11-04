import { z } from "zod";
import { LIMITS } from "./limits.js";
import { FALLBACK_BUS_NAME, INSTANCE_SENDER_NAME } from "./meta.js";

/**
 * A bus name: 1..64 chars, letters/digits/space/._-, starting with a letter or
 * digit, ending in a letter, digit, `_` or `-` (never space or dot). No `@`,
 * `/`, `\`, `:` or control chars, and no IPv4-shaped names, so a name can
 * never look like an address (spec: "Address-shaped names are rejected").
 * Domain-shaped names such as `example.com` stay valid.
 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Names the instance and the local client use as the from-name of system
 * notices ("an artifact you follow changed", "your message expired"). No peer
 * may register under them or a look-alike. `openbus` stays reserved so a
 * session moved from OpenBus cannot pose as its old system sender.
 */
export const RESERVED_BUS_NAMES = [
  INSTANCE_SENDER_NAME,
  "openbus",
  "open-bus",
] as const;

/**
 * Reserved = ASCII-lowercased, trailing separator(+digits) suffixes stripped
 * repeatedly, every remaining `[ ._-]` removed, equals a reserved entry
 * (entries get the same separator removal, so both fold to `openbus`).
 * `openbus2` (digits glued on, no hyphen) is deliberately NOT reserved: it is
 * not a form the daemon ever generates, and chasing every visual look-alike
 * is open-ended; the rule stays exact and predictable.
 */
export function isReservedBusName(s: string): boolean {
  let k = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (let prev = ""; prev !== k; ) {
    prev = k;
    k = k.replace(/(?:[ ._-]+\d+|[ ._-]+)$/, "");
  }
  k = k.replace(/[ ._-]/g, "");
  return RESERVED_BUS_NAMES.some((r) => r.replace(/[ ._-]/g, "") === k);
}

export const BusNameSchema = z
  .string()
  .max(LIMITS.maxBusNameChars)
  .refine((s) => NAME_RE.test(s) && !IPV4_RE.test(s), "invalid bus name")
  .refine(
    (s) => !isReservedBusName(s),
    "bus name is reserved for system notices",
  );
export type BusName = z.infer<typeof BusNameSchema>;

/**
 * "Base-2": trims the base so the suffix fits inside maxBusNameChars. Throws
 * unless `base` is a valid bus name and `n` a safe integer >= 2, so the result
 * is always a valid bus name.
 */
export function suffixName(base: string, n: number): string {
  if (!BusNameSchema.safeParse(base).success)
    throw new Error("suffixName: base is not a valid or allowed bus name");
  if (!Number.isSafeInteger(n) || n < 2)
    throw new Error("suffixName: n must be an integer >= 2");
  const suffix = `-${n}`;
  const room = LIMITS.maxBusNameChars - suffix.length;
  const stem = base.slice(0, room).replace(/[ .]+$/, "");
  return `${stem}${suffix}`;
}

/** A harness proposal made safe: control chars stripped, trimmed, capped. */
export function candidateName(proposed: string): string {
  const cleaned = proposed
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, LIMITS.maxBusNameChars)
    .replace(/[ .]+$/, "");
  return BusNameSchema.safeParse(cleaned).success ? cleaned : FALLBACK_BUS_NAME;
}
