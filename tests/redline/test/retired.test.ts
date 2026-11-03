import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/report.ts";
import { RETIRED, retiredGaps } from "../src/retired.ts";
import { readRepoFile } from "../src/surfaces.ts";

const manifest = () =>
  parseManifest(
    readFileSync(join(import.meta.dirname, "../live/manifest.json"), "utf8"),
  ).cases;

describe("retired live cases (#1235)", () => {
  it("none is in the manifest, and every replacement resolves", () => {
    expect(retiredGaps(manifest(), readRepoFile)).toEqual([]);
  });

  it("each names the failure it guarded (a failure-model id) or none", () => {
    expect(RETIRED).toHaveLength(17);
    for (const r of RETIRED) {
      expect(r.guards).toMatch(/^(none|[A-Z]+-\d+)$/);
      expect(r.coveredBy.length).toBeGreaterThan(0);
    }
  });

  it("flag a retired case put back in the manifest", () => {
    const [r] = RETIRED;
    if (!r) throw new Error("no retired case");
    expect(
      retiredGaps(
        [...manifest(), { file: r.file, name: r.name }],
        readRepoFile,
      ),
    ).toContain(`retired but still required: ${r.file} > ${r.name}`);
  });

  it("flag a replacement whose test was renamed", () => {
    const r = RETIRED.find((x) => x.name.startsWith("scheduler"));
    const c = r?.coveredBy[0];
    if (!r || !c?.test) throw new Error("no cited test");
    const test = c.test;
    const gaps = retiredGaps(manifest(), (p) =>
      p === c.file
        ? (readRepoFile(p) ?? "").replaceAll(test, "renamed")
        : readRepoFile(p),
    );
    expect(gaps).toContain(
      `${r.file} > ${r.name}: no test "${test}" in ${c.file}`,
    );
  });
});
