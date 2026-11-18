// #2624: SKILL_COMMAND_MIN_BUS must name a bus release that has
// `oa-bus skill`. Once the manifest reaches it, the CHANGELOG must list #2624
// in a release at or below it. Before then nothing is claimed.
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

const num = (v: string) => v.split(".").map(Number);
const atMost = (a: string, b: string) => {
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++)
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number);
  return true;
};

/** Versions whose CHANGELOG section cites #2624. */
function releasesWith2624(): string[] {
  const out: string[] = [];
  for (const part of changelog.split(/\n(?=## \[)/)) {
    const v = /^## \[(\d+\.\d+\.\d+)\]/.exec(part)?.[1];
    if (v && /#2624\b/.test(part)) out.push(v);
  }
  return out;
}

describe("SKILL_COMMAND_MIN_BUS", () => {
  it("names a release that has oa-bus skill", () => {
    if (!pinHasSkillCommand(released)) return; // not reached yet
    const ok = releasesWith2624().some((v) => atMost(v, SKILL_COMMAND_MIN_BUS));
    expect(
      ok,
      `${SKILL_COMMAND_MIN_BUS} is released but #2624 shipped in no release at or below it: raise SKILL_COMMAND_MIN_BUS`,
    ).toBe(true);
  });
});
