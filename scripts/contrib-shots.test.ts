import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  "contrib-shots.sh",
);

let root = "";
beforeEach(() => {
  // A fake checkout: the script finds the repo from its own location.
  root = realpathSync(mkdtempSync(join(tmpdir(), "contrib-shots-")));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/dashboard/e2e"), { recursive: true });
  copyFileSync(source, join(root, "scripts/contrib-shots.sh"));
  writeFileSync(join(root, "apps/dashboard/e2e/pr-1660-shots.spec.ts"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[], dry = true) =>
  spawnSync("bash", [join(root, "scripts/contrib-shots.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, OA_SHOTS_DRY_RUN: dry ? "1" : "" },
  });

it("runs the named shots spec on the mock API at the fixed port", () => {
  const r = run(["pr-1660"]);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  const dash = join(root, "apps/dashboard");
  expect(r.stdout.trim()).toBe(
    `VITE_MOCK=1 OA_E2E_PORT=5299 pnpm --dir ${dash} exec playwright test e2e/pr-1660-shots.spec.ts --output ${dash}/test-results/contrib-shots/pr-1660 --reporter line`,
  );
});

it.each([
  [[]],
  [["a", "b"]],
  [["../x"]],
  [["Pr-1660"]],
  [["pr_1660"]],
  [["-x"]],
  [["x-"]],
  [["x--y"]],
  [["x;rm"]],
  [["x y"]],
  [[""]],
])("refuses %j with usage", (args) => {
  const r = run(args);
  expect(r.status).toBe(64);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/^usage: /);
});

it("refuses a name with no shots spec", () => {
  const r = run(["pr-9999"]);
  expect(r.status).toBe(66);
  expect(r.stderr).toContain("apps/dashboard/e2e/pr-9999-shots.spec.ts");
});

it("asks for an install before running", () => {
  const r = run(["pr-1660"], false);
  expect(r.status).toBe(69);
  expect(r.stderr).toContain("pnpm install --frozen-lockfile");
});
