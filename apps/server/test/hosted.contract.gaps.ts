// Hosted contract cases the real server fails today (review item 26). Each
// runs as an expected failure on the server driver only (never on MSW), so
// the fix that makes one pass fails CI until its entry goes. `item` is the
// final review's number ("new" when the review didn't list it); `why` is the
// first assertion that fails today (a case may have more behind it).
import type { KnownGap } from "../../../packages/shared/test/hosted-contract.js";

export const KNOWN_GAPS: Readonly<Record<string, KnownGap>> = {
  "providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal":
    {
      item: "new",
      m1: true,
      why: "GET /me has instance.tier null: Platform adds the TIER var later (new)",
    },
  "public links off keeps an existing public artifact public (no rewrite)": {
    item: "new",
    m1: true,
    why: "POST /artifacts with an existing id is 400 bad_request (use POST /versions); the contract republishes through it and expects 201 (new)",
  },
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
  "new: providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal",
  "new: public links off keeps an existing public artifact public (no rewrite)",
];
