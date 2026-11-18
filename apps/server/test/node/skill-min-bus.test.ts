// #2624: SKILL_COMMAND_MIN_BUS must be the first release whose bus has
// `oa-bus skill`. Before that release it must be ahead of the manifest; once
// released, the CHANGELOG section for it must list #2624. A release cut
// before the PR merged fails here, so the constant moves to the next one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pinHasSkillCommand,
  SKILL_COMMAND_MIN_BUS,
} from "../../src/mcp/bus-install.ts";

const ROOT = join(__dirname, "../../../..");
const released = (
  JSON.parse(
    readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
  ) as Record<string, string>
)["."] as string;
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

/** The CHANGELOG section for `v`, or null when it isn't there. */
function section(v: string): string | null {
  const start = changelog.indexOf(`## [${v}]`);
  if (start < 0) return null;
  const end = changelog.indexOf("\n## [", start + 1);
  return changelog.slice(start, end < 0 ? undefined : end);
}

describe("SKILL_COMMAND_MIN_BUS", () => {
  it("is the first release that carries oa-bus skill", () => {
    if (!pinHasSkillCommand(released)) {
      // Not released yet: no released version may already be at or past it.
      expect(section(SKILL_COMMAND_MIN_BUS)).toBeNull();
      return;
    }
    const s = section(SKILL_COMMAND_MIN_BUS);
    expect(
      s,
      `CHANGELOG has no ${SKILL_COMMAND_MIN_BUS} section`,
    ).not.toBeNull();
    expect(
      s,
      `${SKILL_COMMAND_MIN_BUS} shipped without #2624: set SKILL_COMMAND_MIN_BUS to the next release`,
    ).toMatch(/#2624\b/);
  });
});
