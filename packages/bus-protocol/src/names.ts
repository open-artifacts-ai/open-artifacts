import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { FALLBACK_BUS_NAME, INSTANCE_SENDER_NAME } from "./meta.ts";

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

/**
 * A harness proposal made safe (#1480): control chars and every character
 * NAME_RE refuses are dropped and the rest kept (`OA Owner (2)` becomes
 * `OA Owner 2`), spaces collapsed, edges trimmed so it starts with a letter or
 * digit and ends with a letter, digit, `_` or `-`, then capped. A name with a
 * letter or digit outside ASCII falls back whole (`caf\u00e9` must not become
 * `caf`); symbols and emoji are dropped like punctuation. The cleaned name is
 * checked as any name is, so reserved and IPv4-shaped results still fall back.
 * NAME_RE itself is the wire contract and is not widened.
 */
export function candidateName(proposed: string): string {
  // #1916: a Claude Code /fork title is "<parent> \u2442 <prompt words>". The
  // name is the parent plus " fork"; the parent part is trimmed so it fits.
  const mark = proposed.indexOf(FORK_MARK);
  if (mark >= 0) {
    const parent = cleanName(
      proposed.slice(0, mark),
      LIMITS.maxBusNameChars - FORK_SUFFIX.length,
    );
    if (parent === null) return FALLBACK_BUS_NAME;
    const out = `${parent}${FORK_SUFFIX}`;
    return BusNameSchema.safeParse(out).success ? out : FALLBACK_BUS_NAME;
  }
  return cleanName(proposed, LIMITS.maxBusNameChars) ?? FALLBACK_BUS_NAME;
}

/** U+2442 OCR fork, which Claude Code puts between a fork's parent title and prompt. */
const FORK_MARK = "\u2442";
const FORK_SUFFIX = " fork";

/** The cleaning of `candidateName`, capped at `cap`; null when nothing usable is left. */
function cleanName(proposed: string, cap: number): string | null {
  if (/[\p{L}\p{N}]/u.test(proposed.replace(/[A-Za-z0-9]/g, ""))) return null;
  const cleaned = proposed
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, cap)
    .replace(/[ .]+$/, "");
  return BusNameSchema.safeParse(cleaned).success ? cleaned : null;
}

/**
 * True when `candidateName` kept a name only by dropping characters NAME_RE
 * refuses (#1480): the old cleaning alone (control chars, spaces, trim, cap,
 * trailing space or dot) would not give the same name. Two raw names that
 * clean to one name this way are different names, so neither may take the
 * other's away reservation or queued mail. A fallback is never "dropped".
 */
export function droppedRefusedChars(proposed: string): boolean {
  // #1916: a fork is never its parent, so it may not reclaim the parent's
  // away address or mail, even when the parent part falls back.
  if (proposed.includes(FORK_MARK)) return true;
  const out = candidateName(proposed);
  if (out === FALLBACK_BUS_NAME) return false;
  const old = proposed
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, LIMITS.maxBusNameChars)
    .replace(/[ .]+$/, "");
  return old !== out;
}
