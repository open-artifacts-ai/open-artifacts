// P3 T16: every caller on every artifact through every surface (REST, list
// and search, data and storage, content, sockets, all MCP tools), against
// the hand-written table in test/authz/expect.ts.
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONTENT_POLICY,
  ROUTE_POLICY,
  TOOL_POLICY,
} from "../src/auth/route-policy.js";
import {
  ARTIFACTS,
  type ArtifactName,
  CALLERS,
  type CallerName,
  expected,
  TRAITS,
  type Traits,
} from "./authz/expect.ts";
import { BASE, buildWorld, io, type World } from "./authz/fixture.ts";
import { SURFACES, type Surface, uncovered } from "./authz/surfaces.ts";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

describe("coverage", () => {
  it("SURFACES cover every artifact entry in ROUTE_POLICY and every TOOL_POLICY tool", () => {
    expect(uncovered(SURFACES, ROUTE_POLICY, TOOL_POLICY)).toEqual([]);
  });
  it("every SURFACES route is a real registry entry", () => {
    const known = new Set([
      ...Object.keys(ROUTE_POLICY),
      ...Object.keys(TOOL_POLICY).map((t) => `tool:${t}`),
      ...Object.keys(CONTENT_POLICY).map((k) => `content:${k}`),
    ]);
    expect(
      SURFACES.flatMap((s) => s.routes).filter((r) => !known.has(r)),
    ).toEqual([]);
  });
});

/**
 * Known bugs, pinned so the suite stays green and fails once they are fixed
 * (then delete the entry). Each one is reported, not fixed, by this task.
 *
 * B1: /mcp with a PAT checks orgCan(user, "mcp.connect") without the
 * caller's cap (src/index.ts:61), so a restricted member's PAT still reaches
 * the MCP tools (read-only: every tool applies the cap). The OAuth path
 * refuses capped callers (src/mcp/oauth.ts:134), as the policy says.
 */
const KNOWN: Partial<Record<CallerName, { via: string; traits: Traits }>> = {
  restrictedContractor: {
    via: "mcp",
    traits: { ...TRAITS.restrictedContractor, mcp: true },
  },
};

/** One caller's row on one surface: every artifact, probed. */
async function row(s: Surface, who: CallerName) {
  const got = {} as Record<ArtifactName, string>;
  const want = {} as Record<ArtifactName, string>;
  await Promise.all(
    ARTIFACTS.map(async (art) => {
      const id = s.mutates === "access" ? await w.clone(art) : w.ids[art];
      got[art] = await s
        .probe(BASE, w.creds[who], id, io)
        .catch((e: Error) => `error: ${e.message}`);
      const bug = KNOWN[who];
      want[art] = expected(
        who,
        art,
        s.action,
        s.via,
        bug?.via === s.via ? bug.traits : TRAITS[who],
      );
    }),
  );
  return { got, want };
}

describe.each(SURFACES.map((s) => ({ ...s })))("$name", (s) => {
  it.concurrent.each(CALLERS.map((c) => [c]))("%s", async (who) => {
    const { got, want } = await row(s, who);
    expect(got).toEqual(want);
  });
});
