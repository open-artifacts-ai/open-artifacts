import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "./stubs.ts";
import { type Pkg, trackedSources, workspace } from "./workspace-imports.ts";
import { drift, KNOWN, parseKnown, reads, report } from "./workspace-reads.ts";

const pkg = (dir: string, name: string, deps: string[] = []): Pkg => ({
  dir,
  name,
  deps: new Set(deps),
});
// apps/reader declares @oa/declared; nothing else.
const pkgs = [
  pkg("apps/reader", "@oa/reader", ["@oa/declared"]),
  pkg("apps/other", "@oa/other"),
  pkg("packages/declared", "@oa/declared"),
  pkg("apps/reader-extra", "@oa/reader-extra"),
];

const read = (path: string, text: string) => reads(pkgs, [{ path, text }]);

// The baseline the warn-mode step reads: it must describe the repo as it is,
// so a rename or a removed read fails here before it fails in lint.
describe("the known list matches the repo", () => {
  const known = parseKnown(readFileSync(join(root, KNOWN), "utf8"));
  // public-only (#1056) copies the repo without the paths in private-paths.txt,
  // and a good share of the baseline reads inside them: a reduced copy cannot
  // match the list, the full checkout must. That job is advisory in CI; when
  // the check goes fatal these lines go stale and this test fails with them.
  const privatePaths = readFileSync(
    join(root, "scripts/ci/private-paths.txt"),
    "utf8",
  )
    .split("\n")
    .map((l) => l.split("#")[0]?.trim() ?? "")
    .filter(Boolean);
  const full = privatePaths.every((p) => existsSync(join(root, p)));
  it("is sorted and holds a single space per line", () => {
    expect(known).toEqual([...known].sort());
    for (const l of known) expect(l.split(" ")).toHaveLength(2);
  });
  it.skipIf(!full)("has no stale entry", () => {
    const findings = reads(workspace(root), trackedSources(root));
    expect(drift(findings, known).stale).toEqual([]);
  });
});

describe("reads", () => {
  it("a relative read of an undeclared package is a finding", () => {
    expect(
      read(
        "apps/reader/test/a.test.ts",
        'const f = readFileSync(join(here, "../../other/fixture.json"));',
      ),
    ).toEqual([
      {
        file: "apps/reader/test/a.test.ts",
        package: "@oa/other",
        literal: "../../other/fixture.json",
      },
    ]);
  });
  it("the same read of a declared package, or of its own package, is not", () => {
    expect(
      read(
        "apps/reader/test/b.test.ts",
        'readFileSync("../../declared/dist/index.js"); readFileSync("../src/x.ts");',
      ),
    ).toEqual([]);
  });
  it("a repo-root literal into another package is a finding", () => {
    expect(
      read(
        "apps/reader/test/c.test.ts",
        'readFileSync("apps/other/wrangler.jsonc")',
      ).map((r) => `${r.package} ${r.literal}`),
    ).toEqual(["@oa/other apps/other/wrangler.jsonc"]);
  });
  it("reports a (file, package) pair once", () => {
    expect(
      read(
        "apps/reader/test/d.test.ts",
        'readFileSync("apps/other/a.json"); readFileSync("apps/other/b.json");',
      ),
    ).toHaveLength(1);
  });
  it("a read outside every package is not a finding", () => {
    expect(
      read("apps/reader/test/e.test.ts", 'read("docs/self-hosting.md")'),
    ).toEqual([]);
  });
  it("ownerOf never confuses a sibling with a shared prefix", () => {
    // A sibling (reader-extra) is its own package, not the reader's.
    expect(
      read(
        "apps/reader/test/f.test.ts",
        'read("apps/reader-extra/x.ts"); read("apps/reader/src/y.ts");',
      ).map((r) => r.package),
    ).toEqual(["@oa/reader-extra"]);
  });
  it("prose, a test name or any non-path string is not a finding", () => {
    expect(
      read(
        "apps/reader/test/g.test.ts",
        [
          'it("reads the other package\\u2019s fixture from apps/other", () => {});',
          'const msg = "apps/other has no such file";',
          'const code = "apps/other/x.ts, on failure";',
          'const glob = "apps/other/**/*.json";',
          'const url = "https://example.com/apps/other";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
  it("a template literal with an interpolation is ignored", () => {
    // `$` spelled as a value, so this fixture's own source has no "$" + "{".
    const dollar = "$";
    expect(
      read(
        "apps/reader/test/h.test.ts",
        `read(\`apps/other/${dollar}{name}.json\`);`,
      ),
    ).toEqual([]);
  });
  it("a plain template literal is read", () => {
    expect(
      read("apps/reader/test/i.test.ts", "read(`apps/other/x.json`);").map(
        (r) => r.literal,
      ),
    ).toEqual(["apps/other/x.json"]);
  });
  it("a stray backtick and an interpolation do not swallow a later read", () => {
    // A stray backtick (an unterminated regex here) used to pair with the next
    // one lines later and span the rest of the file, and an interpolated
    // template's backticks did the same from there on: the read below was
    // never seen. Both literals are skipped; nothing spans a line.
    const dollar = "$";
    expect(
      read(
        "apps/reader/test/k.test.ts",
        [
          "const re = /owner_email: `apps/other/skip.json/;",
          `read(\`${dollar}{dir}/x.json\`);`,
          'read("apps/other/real.json");',
          "read(`apps/reader/own.json`);",
        ].join("\n"),
      ).map((r) => `${r.package} ${r.literal}`),
    ).toEqual(["@oa/other apps/other/real.json"]);
  });
  it("a relative literal that climbs out of the repo is skipped", () => {
    expect(
      read("apps/reader/test/j.test.ts", 'read("../../../../etc/hosts")'),
    ).toEqual([]);
  });
});

describe("drift", () => {
  const finding = {
    file: "apps/reader/test/a.ts",
    package: "@oa/other",
    literal: "x",
  };
  it("a new finding, or a stale line, fails the check and names its file", () => {
    const added = report([finding], [], false);
    expect(added.code).toBe(1);
    expect(added.lines).toHaveLength(1);
    expect(added.lines[0]).toContain("apps/reader/test/a.ts");
    expect(added.lines[0]).toContain("declare @oa/other in its package.json");

    const stale = report([], ["apps/gone/test/a.ts @oa/other"], false);
    expect(stale.code).toBe(1);
    expect(stale.lines[0]).toContain("apps/gone/test/a.ts @oa/other");
    expect(stale.lines[0]).toContain(
      "delete the line from workspace-reads-known.txt",
    );
  });
  it("an exactly matching known file passes", () => {
    const r = report([finding], ["apps/reader/test/a.ts @oa/other"], false);
    expect(r).toEqual({ lines: [], code: 0 });
  });
  it("warn mode names only what changed, never the tolerated baseline", () => {
    const r = report([finding], ["apps/gone/test/a.ts @oa/other"], true);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain("::warning file=apps/reader/test/a.ts::");
    expect(r.lines[0]).toContain("new cross-package read of @oa/other");
    expect(r.lines[1]).toContain(`::warning file=${KNOWN}::stale entry`);
    expect(r.lines[2]).toBe(
      "workspace-reads (warn only): 1 cross-package read(s); 1 new, 1 stale",
    );
  });
  it("warn mode is silent about a finding the baseline already tolerates", () => {
    const r = report([finding], ["apps/reader/test/a.ts @oa/other"], true);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      "workspace-reads (warn only): 1 cross-package read(s); 0 new, 0 stale",
    ]);
  });
  it("a trailing comment says why a line is tolerated, and is not compared", () => {
    const known = parseKnown(
      [
        "# header",
        "apps/reader/test/a.ts @oa/other # lists it, does not read it",
        "",
      ].join("\n"),
    );
    expect(known).toEqual(["apps/reader/test/a.ts @oa/other"]);
    expect(report([finding], known, false)).toEqual({ lines: [], code: 0 });
  });
});
