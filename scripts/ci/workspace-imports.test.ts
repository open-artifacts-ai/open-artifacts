import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";
import {
  ownerOf,
  type Pkg,
  ROOT_PATHS,
  scope,
  trackedSources,
  violations,
  workspace,
} from "./workspace-imports.ts";

const pkg = (dir: string, name: string, deps: string[] = []): Pkg => ({
  dir,
  name,
  deps: new Set(deps),
});
const pkgs = [
  pkg("apps/server", "@oa/server", ["@oa/shared"]),
  pkg("apps/auth-broker", "@oa/auth-broker"),
  pkg("packages/shared", "@oa/shared"),
];

// The guard the affected-only run relies on: it runs in the root suite, which
// every pull request runs whatever its scope.
describe("every cross-package import in the repo is declared", () => {
  it("has no undeclared workspace import", () => {
    const v = violations(workspace(root), trackedSources(root));
    expect(v.map((x) => `${x.file}: ${x.spec} (declare ${x.missing})`)).toEqual(
      [],
    );
  });
});

describe("violations", () => {
  it("an import into another package must be declared; its own package and declared ones pass", () => {
    const v = violations(pkgs, [
      {
        path: "apps/server/test/a.ts",
        text: 'import { x } from "../../auth-broker/src/index.ts";',
      },
      {
        path: "apps/server/test/b.ts",
        text: 'const s = await import("../../../packages/shared/src/x.ts");',
      },
      {
        path: "apps/server/src/c.ts",
        text: 'import { d } from "./d.ts"; export * from "../test/e.ts";',
      },
    ]);
    expect(v).toEqual([
      {
        file: "apps/server/test/a.ts",
        spec: "../../auth-broker/src/index.ts",
        missing: "@oa/auth-broker",
      },
    ]);
  });
  it("a non-package path passes only when listed in ROOT_PATHS", () => {
    const v = violations(pkgs, [
      {
        path: "apps/server/test/m.ts",
        text: 'import t from "../../../design/emails/code.html";',
      },
      {
        path: "apps/server/test/n.ts",
        text: 'import t from "../../../docs/secret.md";',
      },
    ]);
    expect(ROOT_PATHS).toContain("design/emails/");
    expect(v.map((x) => x.missing)).toEqual(["docs/secret.md"]);
  });
  it("ownerOf never confuses a sibling with a shared prefix", () => {
    const p = [...pkgs, pkg("apps/server-ext", "@oa/x")];
    expect(ownerOf(p, "apps/server-ext/a.ts")?.name).toBe("@oa/x");
    expect(ownerOf(p, "apps/server/a.ts")?.name).toBe("@oa/server");
    expect(ownerOf(p, "design/a.html")).toBeUndefined();
  });
});

describe("scope", () => {
  it("package files alone: pnpm's affected run", () => {
    expect(scope(["apps/dashboard/src/a.ts", "docs/ops/hosted.md"])).toBe(
      "affected",
    );
  });
  it("root config, the lockfile, a workflow or a ROOT_PATHS file: everything", () => {
    for (const f of [
      "pnpm-lock.yaml",
      "package.json",
      "tsconfig.base.json",
      "biome.json",
      ".github/workflows/ci.yml",
      ".nvmrc",
      "vitest.config.ts",
      "design/emails/code.html",
      "scripts/ci/e2e.sh",
      "scripts/ops/x.sh",
    ])
      expect(scope([f, "apps/dashboard/src/a.ts"]), f).toBe("all");
  });
});

describe("test-affected.sh", () => {
  // pnpm stub: `ls --json` prints $STUB_LS (default: nothing affected); the
  // rest only logs. HEAD...HEAD changes nothing, so scope is "affected".
  const pnpm = 'case " $* " in *" ls "*) echo "${STUB_LS:-[]}" ;; esac';
  const run = (env: Record<string, string>) => {
    const sb = sandbox({ pnpm });
    // Every input explicit: CI's own TEST_SHARD, BASE_SHA and event must
    // never leak in from the job running this test.
    const r = sb.run(["bash", script("test-affected.sh")], {
      env: {
        GITHUB_EVENT_NAME: "",
        BASE_SHA: "",
        TEST_SHARD: "",
        STUB_LS: "",
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
    return { ...r, log: sb.log() };
  };
  const LS = "pnpm --filter ...[HEAD] ls --depth -1 --json";
  it("anything but a pull request runs the shard's share of everything", () => {
    const full: Record<string, string[]> = {
      "": ["pnpm test"],
      server: ["pnpm run test:prep", "pnpm --filter @oa/server test"],
      dashboard: ["pnpm run test:prep", "pnpm --filter @oa/dashboard test"],
      rest: [
        "pnpm run test:prep",
        "pnpm exec vitest run",
        "pnpm -r --if-present --filter !@oa/server --filter !@oa/dashboard test",
      ],
      cpu: ["pnpm run test:prep", "pnpm --filter @oa/server test:cpu"],
    };
    for (const e of ["merge_group", "push", "schedule"])
      for (const [shard, log] of Object.entries(full)) {
        const r = run({
          GITHUB_EVENT_NAME: e,
          BASE_SHA: "HEAD",
          TEST_SHARD: shard,
        });
        expect(r.code, `${e} ${shard}`).toBe(0);
        expect(r.log, `${e} ${shard}`).toEqual(log);
      }
  });
  it("a pull request splits the affected packages across the shards", () => {
    const STUB_LS = JSON.stringify([
      { name: "@oa/server" },
      { name: "@oa/landing" },
      { name: "@oa/redline" },
    ]);
    const pr = (TEST_SHARD: string) =>
      run({
        GITHUB_EVENT_NAME: "pull_request",
        BASE_SHA: "HEAD",
        TEST_SHARD,
        STUB_LS,
      }).log;
    expect(pr("server")).toEqual([
      LS,
      "pnpm run test:prep",
      "pnpm -r --if-present --filter @oa/server test",
    ]);
    expect(pr("cpu")).toEqual([
      LS,
      "pnpm run test:prep",
      "pnpm --filter @oa/server test:cpu",
    ]);
    expect(pr("rest")).toEqual([
      LS,
      "pnpm run test:prep",
      "pnpm exec vitest run",
      "pnpm -r --if-present --filter @oa/landing --filter @oa/redline test",
    ]);
    // Not affected: the shard does nothing at all.
    expect(pr("dashboard")).toEqual([LS]);
  });
  it("a pull request with nothing affected: the root suite only (rest), nothing elsewhere", () => {
    const pr = (TEST_SHARD: string) =>
      run({ GITHUB_EVENT_NAME: "pull_request", BASE_SHA: "HEAD", TEST_SHARD })
        .log;
    expect(pr("rest")).toEqual([
      LS,
      "pnpm run test:prep",
      "pnpm exec vitest run",
    ]);
    for (const s of ["server", "dashboard", "cpu"])
      expect(pr(s), s).toEqual([LS]);
  });
  it("no base, a scope error or an unknown shard never means nothing", () => {
    expect(
      run({ GITHUB_EVENT_NAME: "pull_request", TEST_SHARD: "server" }).log,
    ).toEqual(["pnpm run test:prep", "pnpm --filter @oa/server test"]);
    const bad = run({
      GITHUB_EVENT_NAME: "pull_request",
      BASE_SHA: "not-a-commit",
    });
    expect(bad.log).toEqual(["pnpm test"]);
    expect(bad.out).toContain("the scope check failed");
    expect(run({ GITHUB_EVENT_NAME: "push", TEST_SHARD: "servr" }).code).toBe(
      2,
    );
  });
});
