// Hosted contract cases the real server fails today (review item 26). Each
// runs as an expected failure on the server driver only (never on MSW), so
// the fix that makes one pass fails CI until its entry goes. `item` is the
// final review's number ("new" when the review didn't list it); `why` is the
// first assertion that fails today (a case may have more behind it).
import type { KnownGap } from "../../../packages/shared/test/hosted-contract.js";

export const KNOWN_GAPS: Readonly<Record<string, KnownGap>> = {
  "spaces, members, mappings, directory, transfer": {
    item: "31",
    m1: false,
    why: "PUT space mapping returns name null: group names are never stored",
  },
};

/**
 * The M1 entries above, spelled out ("item: case", sorted). The M1 gate
 * requires this list to be empty; hosted.contract.test.ts fails when it and
 * KNOWN_GAPS disagree, so closing an M1 gap edits both.
 */
export const M1_OPEN: readonly string[] = [
];
