// Hosted contract cases the real server fails today (review item 26). Each
// runs as an expected failure on the server driver only (never on MSW), so
// the fix that makes one pass fails CI until its entry goes. `item` is the
// final review's number ("new" when the review didn't list it); `why` is the
// first assertion that fails today (a case may have more behind it).
import type { KnownGap } from "../../../packages/shared/test/hosted-contract.js";

const ME_SPACES =
  "GET /me has no spaces (item 2), so the case can't find its space ids";
const FROZEN_GROUPS =
  "frozen sync: a manual override keeps the synced row's groups in the response (syncRole null, groups [gEng01]); the contract says groups [] (new)";

export const KNOWN_GAPS: Readonly<Record<string, KnownGap>> = {
  "providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal":
    {
      item: "new, 2",
      m1: true,
      why: "GET /me has no instance.tier (hosted billing tier, new); the case reads me.spaces after it (item 2)",
    },
  "spaces, members, mappings, directory, transfer": {
    item: "31",
    m1: false,
    why: "PUT space mapping returns name null: group names are never stored",
  },
  "transfer of a personal artifact and spaceId on publish": {
    item: "2",
    m1: true,
    why: `${ME_SPACES}: the Exec publish goes to Personal (201, not space_forbidden)`,
  },
  "a restricted-group member is capped and gets no allMembersRole": {
    item: "new, 2",
    m1: true,
    why: "code verify answers readOnly false for restricted Dan: the server sets readOnly for guests only (new); the case reads me.spaces after it (item 2)",
  },
  "manual restricted flag: cap on space members, no successor, audited": {
    item: "2, 1b",
    m1: true,
    why: `${ME_SPACES}; then DELETE /restricted returns an object, not restriction null (1b)`,
  },
  "public in a space with publicLinks off is 403 public_links_off": {
    item: "2",
    m1: true,
    why: ME_SPACES,
  },
  "public links off keeps an existing public artifact public (no rewrite)": {
    item: "2",
    m1: true,
    why: ME_SPACES,
  },
  "space members: personal space 400 space_personal; PUT needs an existing, active target":
    { item: "2", m1: true, why: ME_SPACES },
  "moving a public artifact into a space with publicLinks off makes it team": {
    item: "2",
    m1: true,
    why: ME_SPACES,
  },
  "frozen sync: raising a synced row is a manual grant (managers up to editor, admins any)":
    { item: "new", m1: true, why: FROZEN_GROUPS },
  "frozen sync: DELETE removes a synced row; PUT may lower (manual override); audited":
    { item: "new", m1: true, why: FROZEN_GROUPS },
  "scope=space lists one space; scope=spaces lists shared spaces; scope=space without spaceId is 400":
    { item: "2", m1: true, why: ME_SPACES },
};

/**
 * The M1 entries above, spelled out ("item: case", sorted). The M1 gate
 * requires this list to be empty; hosted.contract.test.ts fails when it and
 * KNOWN_GAPS disagree, so closing an M1 gap edits both.
 */
export const M1_OPEN: readonly string[] = [
  "2, 1b: manual restricted flag: cap on space members, no successor, audited",
  "2: moving a public artifact into a space with publicLinks off makes it team",
  "2: public in a space with publicLinks off is 403 public_links_off",
  "2: public links off keeps an existing public artifact public (no rewrite)",
  "2: scope=space lists one space; scope=spaces lists shared spaces; scope=space without spaceId is 400",
  "2: space members: personal space 400 space_personal; PUT needs an existing, active target",
  "2: transfer of a personal artifact and spaceId on publish",
  "new, 2: a restricted-group member is capped and gets no allMembersRole",
  "new, 2: providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal",
  "new: frozen sync: DELETE removes a synced row; PUT may lower (manual override); audited",
  "new: frozen sync: raising a synced row is a manual grant (managers up to editor, admins any)",
];
