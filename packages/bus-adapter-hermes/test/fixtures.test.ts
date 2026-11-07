import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterFrame, DaemonFrame } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import { buildFixtures, FIXTURES_DIR } from "../scripts/gen-fixtures.ts";

type Fixture = {
  valid: { name: string; frame: unknown }[];
  invalid: { name: string; frame: unknown }[];
};
const load = (file: string): Fixture =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));

describe("golden frames", () => {
  it("are what the generator makes now (run `pnpm fixtures` after a frame changes)", () => {
    for (const [file, text] of Object.entries(buildFixtures()))
      expect(readFileSync(join(FIXTURES_DIR, file), "utf8"), file).toBe(text);
  });

  it("parse with bus-ipc: every valid frame does, every invalid one does not", () => {
    for (const [file, schema] of [
      ["adapter-frames.json", AdapterFrame],
      ["daemon-frames.json", DaemonFrame],
    ] as const) {
      const f = load(file);
      expect(f.valid.length).toBeGreaterThan(5);
      expect(f.invalid.length).toBeGreaterThan(5);
      for (const s of f.valid)
        expect(schema.safeParse(s.frame).success, `${file}: ${s.name}`).toBe(
          true,
        );
      for (const s of f.invalid)
        expect(schema.safeParse(s.frame).success, `${file}: ${s.name}`).toBe(
          false,
        );
    }
  });
});
