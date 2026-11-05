// #1056 untangle D: public-only.sh copies the repo, removes the private paths
// and runs install, build, typecheck and tests. pnpm is a stub here; the real
// run is the `public-only` CI job.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox, script, write } from "./stubs.ts";

const STEPS = [
  "pnpm install --no-frozen-lockfile",
  "pnpm -r --no-bail --if-present build",
  "pnpm run typecheck",
  "pnpm run --if-present test:prep",
  "pnpm exec vitest run",
  "pnpm -r --no-bail --workspace-concurrency=2 --if-present test",
];

// The stub logs its argv, notes any private path still present in the copy,
// fails when its argv equals $PNPM_FAIL, and prints $PNPM_SAY.
const pnpm = `
for p in apps/admin packages/provision scripts/ops/hosted.sh; do
  [ -e "$p" ] && echo "LEAK $p" >> "$STUB_LOG"
done
[ -n "\${PNPM_SAY:-}" ] && echo "$PNPM_SAY"
[ "$*" = "\${PNPM_FAIL:-}" ] && exit 3
exit 0`;

const LIST = `# test list
apps/admin
packages/provision/   # trailing slash and comment
scripts/ops/hosted.sh

`;

/** A tiny git repo with private and public paths. */
function fakeRepo(list = LIST) {
  const dir = mkdtempSync(join(tmpdir(), "public-only-src-"));
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
    "package.json": "{}\n",
    ".gitignore": "node_modules/\n",
    "scripts/ci/private-paths.txt": list,
    "apps/admin/package.json": "{}\n",
    "apps/server/package.json": "{}\n",
    "packages/provision/src/index.ts": "export {};\n",
    "packages/bundle/src/index.ts": "export {};\n",
    "scripts/ops/hosted.sh": "true\n",
    "scripts/ops/check-prod-token.sh": "true\n",
  };
  for (const [p, body] of Object.entries(files)) write(join(dir, p), body);
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  write(join(dir, "apps/server/untracked.ts"), "export {};\n");
  write(join(dir, "node_modules/junk/index.js"), "x\n");
  return dir;
}

function run(env: Record<string, string> = {}, src = fakeRepo()) {
  const sb = sandbox({ pnpm });
  const work = join(sb.dir, "work");
  const r = sb.run(["bash", script("public-only.sh")], {
    env: {
      PUBLIC_ONLY_SRC: src,
      PUBLIC_ONLY_DIR: work,
      PUBLIC_ONLY_KEEP: "1",
      PNPM_FAIL: "",
      PNPM_SAY: "",
      ...env,
    },
  });
  return { ...r, sb, tree: join(work, "repo"), src };
}

describe("public-only.sh", () => {
  it("removes every listed path from the copy, keeps the rest, runs every step", () => {
    const r = run();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.sb.log()).toEqual(STEPS);
    expect(existsSync(join(r.tree, "apps/admin"))).toBe(false);
    expect(existsSync(join(r.tree, "packages/provision"))).toBe(false);
    expect(existsSync(join(r.tree, "scripts/ops/hosted.sh"))).toBe(false);
    for (const p of [
      "apps/server/package.json",
      "apps/server/untracked.ts",
      "packages/bundle/src/index.ts",
      "scripts/ops/check-prod-token.sh",
    ])
      expect(existsSync(join(r.tree, p)), p).toBe(true);
    expect(existsSync(join(r.tree, "node_modules"))).toBe(false);
    // The copy is its own repo; the source is untouched.
    expect(existsSync(join(r.tree, ".git"))).toBe(true);
    expect(existsSync(join(r.src, "apps/admin/package.json"))).toBe(true);
    expect(r.out).toContain("removed 3 of 3 private paths");
    expect(r.out).toContain("public-only: exit=0");
  });

  // Mutation check: one failing step must fail the run, and later steps still
  // run so one run lists every break.
  it.each([
    ["build", 1],
    ["typecheck", 2],
    ["test-prep", 3],
    ["test-root", 4],
    ["test-pkgs", 5],
  ] as const)("exits non-zero when %s fails, and runs the rest", (name, i) => {
    const r = run({ PNPM_FAIL: STEPS[i].replace(/^pnpm /, "") });
    expect(r.code).toBe(1);
    expect(r.sb.log()).toEqual(STEPS);
    expect(r.out).toContain(`${name}=3`);
    expect(r.out).toContain(`[${name}] FAILED exit=3`);
    expect(r.out).toContain("public-only: exit=1");
  });

  it("stops after a failed install", () => {
    const r = run({ PNPM_FAIL: "install --no-frozen-lockfile" });
    expect(r.code).toBe(1);
    expect(r.sb.log()).toEqual([STEPS[0]]);
    expect(r.out).toContain("install=3");
  });

  it("fails a step whose log says failed even when it exits 0 (#1225)", () => {
    const r = run({
      PUBLIC_ONLY_STEPS: "test-root",
      PNPM_SAY: "      Tests  2 failed | 10 passed (12)",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("test-root=90");
  });

  it("removes the work dir unless asked to keep it", () => {
    const r = run({ PUBLIC_ONLY_KEEP: "", PUBLIC_ONLY_STEPS: "build" });
    expect(r.code).toBe(0);
    expect(existsSync(join(r.sb.dir, "work"))).toBe(false);
  });

  it.each([
    "/etc",
    "../outside",
    "apps/../..",
    "apps/./admin",
    "apps/*",
    "-rf",
  ])("refuses the unsafe list entry %s and runs nothing", (bad) => {
    const r = run({}, fakeRepo(`apps/admin\n${bad}\n`));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unsafe path");
    expect(r.sb.log()).toEqual([]);
  });

  it("refuses an unknown step and an existing work dir", () => {
    expect(run({ PUBLIC_ONLY_STEPS: "deploy" }).code).toBe(2);
    const src = fakeRepo();
    expect(run({ PUBLIC_ONLY_DIR: src }, src).code).toBe(2);
  });
});

describe("private-paths.txt", () => {
  const entries = readFileSync(
    join(root, "scripts/ci/private-paths.txt"),
    "utf8",
  )
    .split("\n")
    .map((l) => (l.split("#")[0] ?? "").trim().replace(/\/$/, ""))
    .filter(Boolean);

  // Drift guard: a renamed hosted path must be renamed here too. In a tree
  // with none of them (public-only.sh's own copy, or after the hosted code is
  // deleted in #1056 phase 2) there is nothing to drift from; a tree with
  // some but not all of them is drift.
  it("names only paths that exist, or none of them is present", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries).size).toBe(entries.length);
    const present = entries.filter((p) => existsSync(join(root, p)));
    if (present.length === 0) return;
    for (const p of entries) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it("never names a public path", () => {
    const pub = [
      "apps/server",
      "apps/dashboard",
      "apps/landing",
      "apps/auth-broker",
      "apps/directory-broker",
      "apps/demo-ops",
      "packages/auth-core",
      "packages/broker-core",
      "packages/bundle",
      "packages/render",
      "packages/runtime",
      "packages/shared",
      "packages/ui",
      "scripts/setup",
      "scripts/ci",
      "scripts/ops",
      "tests/import",
      "design",
      "docs/ops/staging.md",
      ".github/workflows/ci.yml",
      ".github/workflows/release-please.yml",
      "scripts/ci/public-only.sh",
      "scripts/ci/private-paths.txt",
      "scripts/ci/check-no-test-hooks.ts",
      "scripts/ci/build-release-bundle.ts",
      "scripts/ci/stubs.ts",
      "scripts/ops/check-landing-dist.ts",
      "scripts/ops/check-prod-token.sh",
      "scripts/ops/check-staging-secrets.ts",
      "scripts/ops/conflicting-secrets.ts",
      "scripts/ops/staging-access.ts",
      "scripts/ops/staging-token-id.sh",
    ];
    for (const p of entries)
      for (const q of pub)
        expect(q === p || q.startsWith(`${p}/`), `${p} covers ${q}`).toBe(
          false,
        );
  });
});

describe("ci.yml public-only job", () => {
  const w = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  it("runs the script and is advisory", () => {
    const job = w.jobs["public-only"];
    expect(job).toBeDefined();
    expect(job["continue-on-error"]).toBe(true);
    expect(JSON.stringify(job.steps)).toContain(
      "bash scripts/ci/public-only.sh",
    );
  });
  it("while advisory, a failing run is a warning and never fails the check", () => {
    const step = w.jobs["public-only"].steps.find((s: { run?: string }) =>
      s.run?.includes("bash scripts/ci/public-only.sh"),
    );
    expect(step.run).toMatch(
      /bash scripts\/ci\/public-only\.sh \|\| echo "::warning /,
    );
  });
  it("leaves every required job blocking", () => {
    for (const j of [
      "lint",
      "typecheck",
      "test",
      "build",
      "e2e",
      "no-test-hooks",
      "authz-matrix",
    ])
      expect(w.jobs[j]?.["continue-on-error"], j).toBeUndefined();
  });
});
