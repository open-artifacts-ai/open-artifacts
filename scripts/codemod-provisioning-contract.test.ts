import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "codemod-provisioning-contract.sh",
);
// Built from parts so a run of the codemod on this repo leaves this file alone.
const OLD = ["@oa/shared", "provisioning"].join("/");
const OLD_DIR = ["packages/shared/src", "provisioning"].join("/");
const OLD_MOCK = ["packages/shared/src/mocks", "provisioning.ts"].join("/");

const run = (root: string) => {
  const r = spawnSync("bash", [script, root], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout.split("\n").filter(Boolean).sort();
};

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fixture = {
  "apps/a/src/x.ts": `import { A } from "${OLD}";\nimport { m } from "${OLD}/mocks";\nimport { S } from '${OLD}/state';\n`,
  "apps/a/src/y.tsx": `const f = await import("${OLD}/fakes");\n`,
  "apps/a/tsconfig.json": `{ "paths": { "${OLD}/mocks": ["../../${OLD_MOCK}"], "${OLD}/*": ["../../${OLD_DIR}/*"] } }\n`,
  "scripts/s.mjs": `scan("${OLD_DIR}");\n`,
  "tests/t/u.ts": `import "${OLD}/workflow";\n`,
  // Not rewritten: other @oa/shared paths, other extensions, skipped dirs.
  "packages/p/src/keep.ts": `import { z } from "@oa/shared";\nimport "@oa/shared/mocks";\n`,
  "packages/p/README.md": `${OLD}\n`,
  "packages/p/node_modules/q/i.ts": `${OLD}\n`,
  "packages/p/dist/i.js.ts": `${OLD}\n`,
  "other/o.ts": `${OLD}\n`,
};
const expected: Record<string, string> = {
  "apps/a/src/x.ts": `import { A } from "@oa/provisioning-contract";\nimport { m } from "@oa/provisioning-contract/mocks";\nimport { S } from '@oa/provisioning-contract/state';\n`,
  "apps/a/src/y.tsx": `const f = await import("@oa/provisioning-contract/fakes");\n`,
  "apps/a/tsconfig.json": `{ "paths": { "@oa/provisioning-contract/mocks": ["../../packages/provisioning-contract/src/mocks.ts"], "@oa/provisioning-contract/*": ["../../packages/provisioning-contract/src/*"] } }\n`,
  "scripts/s.mjs": `scan("packages/provisioning-contract/src");\n`,
  "tests/t/u.ts": `import "@oa/provisioning-contract/workflow";\n`,
};

it("rewrites the old contract paths once, and a second run changes nothing", () => {
  root = mkdtempSync(join(tmpdir(), "codemod-pc-"));
  for (const [p, text] of Object.entries(fixture)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  expect(run(root)).toEqual(Object.keys(expected).sort());
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  for (const [p, text] of Object.entries(fixture))
    expect(read(p)).toBe(expected[p] ?? text);

  // Idempotent: nothing reported, every byte the same.
  const after = Object.keys(fixture).map(read);
  expect(run(root)).toEqual([]);
  expect(Object.keys(fixture).map(read)).toEqual(after);
});
