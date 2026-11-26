// #3043 slice 2: guard against reintroducing habit file writes or prompts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

const walkTs = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

const FORBIDDEN = [
  "habitsBlock(",
  "writeHabits",
  "writeProjectHabits",
  'readLine("Update them',
  "Update them?",
  "Add them?",
  "QUESTION FOR YOUR USER",
  "withHabits(",
  "habitsAfterInstall",
  "setPluginHabits",
  "HABITS_MARKER_TEXT",
];

describe("no habit file writes or prompts in bus-cli/src (#3043)", () => {
  const files = walkTs(SRC_DIR);

  it("scans bus-cli/src TypeScript files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const needle of FORBIDDEN) {
    it(`never contains ${JSON.stringify(needle)}`, () => {
      const hits = files.filter((f) =>
        readFileSync(f, "utf8").includes(needle),
      );
      expect(hits).toEqual([]);
    });
  }

  it("keeps HABITS_BEGIN only in src/steps/habits.ts and never writes a block there", () => {
    const habitsPath = join(SRC_DIR, "steps", "habits.ts");
    const outside = files.filter(
      (f) =>
        f !== habitsPath && readFileSync(f, "utf8").includes("HABITS_BEGIN"),
    );
    expect(outside).toEqual([]);
    const habitsSrc = readFileSync(habitsPath, "utf8");
    for (const needle of [
      "HABITS_LINES.join",
      "[HABITS_BEGIN",
      "HABITS_BEGIN,",
    ]) {
      expect(habitsSrc).not.toContain(needle);
    }
    expect(habitsSrc).not.toMatch(
      /writeAtomic\([^)]*(?:HABITS_BEGIN|HABITS_LINES)/,
    );
  });
});
