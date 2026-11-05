import { isReservedSpaceName } from "@oa/shared";

/**
 * A shared space's name where it sits next to the built-in Personal: one
 * named "Personal" (made before the name was reserved, #770) reads
 * "Personal (shared)" so the two can't be confused.
 */
export const sharedSpaceName = (name: string) =>
  isReservedSpaceName(name) ? `${name.trim()} (shared)` : name;
