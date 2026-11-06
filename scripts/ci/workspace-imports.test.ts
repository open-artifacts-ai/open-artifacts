import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";
import {
  cycles,
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
  it("has no workspace dependency cycle", () => {
    expect(cycles(workspace(root))).toEqual([]);
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

describe("cycles", () => {
  const chain = (...names: string[]) => names.join(" -> ");
  it("a two-node cycle, reported once, from the same member", () => {
    const p = [
      pkg("packages/a", "@oa/a", ["@oa/b"]),
      pkg("packages/b", "@oa/b", ["@oa/a"]),
    ];
    expect(cycles(p)).toEqual([chain("@oa/a", "@oa/b", "@oa/a")]);
    expect(cycles([...p].reverse())).toEqual([
      chain("@oa/a", "@oa/b", "@oa/a"),
    ]);
  });
  it("a three-node cycle names every member", () => {
    expect(
      cycles([
        pkg("packages/a", "@oa/a", ["@oa/b"]),
        pkg("packages/b", "@oa/b", ["@oa/c"]),
        pkg("packages/c", "@oa/c", ["@oa/a"]),
      ]),
    ).toEqual([chain("@oa/a", "@oa/b", "@oa/c", "@oa/a")]);
  });
  it("a self-dependency is a cycle", () => {
    expect(cycles([pkg("packages/a", "@oa/a", ["@oa/a"])])).toEqual([
      chain("@oa/a", "@oa/a"),
    ]);
  });
  it("an acyclic graph has none, and so does a dependency outside the workspace", () => {
    expect(
      cycles([
        pkg("apps/server", "@oa/server", ["@oa/shared", "zod", "@types/node"]),
        pkg("packages/shared", "@oa/shared", ["@oa/server-utils"]),
        pkg("packages/server-utils", "@oa/server-utils"),
      ]),
    ).toEqual([]);
  });
  it("reports every cycle in the same graph, one per line, in a fixed order", () => {
    expect(
      cycles([
        pkg("packages/a", "@oa/a", ["@oa/b"]),
        pkg("packages/b", "@oa/b", ["@oa/a"]),
        pkg("packages/c", "@oa/c", ["@oa/c"]),
      ]),
    ).toEqual([chain("@oa/a", "@oa/b", "@oa/a"), chain("@oa/c", "@oa/c")]);
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
  // pnpm stub: `ls --json` lists nothing; anything else just logs.
  const pnpm = 'case " $* " in *" ls "*) echo "[]" ;; esac';
  const run = (env: Record<string, string>) => {
    const sb = sandbox({ pnpm });
    const out = join(sb.dir, "out");
    // Every input explicit: the job running this test sets BASE_SHA (and the
    // event), which must never leak in.
    const r = sb.run(["bash", script("test-affected.sh")], {
      env: {
        GITHUB_EVENT_NAME: "",
        BASE_SHA: "",
        TEST_SHARD: "",
        GITHUB_STEP_SUMMARY: "",
        GITHUB_OUTPUT: out,
        ...env,
      },
    });
    let o = "";
    try {
      o = readFileSync(out, "utf8");
    } catch {}
    return { ...r, log: sb.log(), outputs: o };
  };
  const WHOLE: Record<string, string[]> = {
    server: ["pnpm run test:prep", "pnpm --filter @oa/server test"],
    rest: [
      "pnpm run test:prep",
      "pnpm exec vitest run",
      "pnpm -r --if-present --filter !@oa/server test",
    ],
    cpu: ["pnpm run test:prep", "pnpm --filter @oa/server test:cpu"],
  };
  it("a missing or unknown shard fails, and runs nothing", () => {
    for (const TEST_SHARD of ["", "all", "Server"]) {
      const r = run({ GITHUB_EVENT_NAME: "merge_group", TEST_SHARD });
      expect(r.code, TEST_SHARD).toBe(2);
      expect(r.log, TEST_SHARD).toEqual([]);
    }
  });
  it("anything but a pull request runs the whole shard", () => {
    for (const e of ["merge_group", "push", "schedule", "workflow_dispatch"])
      for (const [TEST_SHARD, cmds] of Object.entries(WHOLE)) {
        const r = run({ GITHUB_EVENT_NAME: e, BASE_SHA: "HEAD", TEST_SHARD });
        expect(r.code, `${e} ${TEST_SHARD}`).toBe(0);
        expect(r.log, `${e} ${TEST_SHARD}`).toEqual(cmds);
      }
  });
  it("the three shards together are the whole suite: pnpm test plus test:cpu", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe(
      "pnpm run test:prep && vitest run && pnpm -r --if-present test",
    );
  });
  it("a pull request with no base, or a scope error, runs the whole shard", () => {
    for (const [TEST_SHARD, cmds] of Object.entries(WHOLE)) {
      expect(
        run({ GITHUB_EVENT_NAME: "pull_request", TEST_SHARD }).log,
      ).toEqual(cmds);
      const bad = run({
        GITHUB_EVENT_NAME: "pull_request",
        BASE_SHA: "not-a-commit",
        TEST_SHARD,
      });
      expect(bad.log).toEqual(cmds);
      expect(bad.out).toContain("the scope check failed");
    }
  });
  it("a pull request with nothing affected: rest runs the root suite only; server and cpu run nothing", () => {
    // HEAD...HEAD: nothing changed.
    const ls = "pnpm --filter ...[HEAD] ls --depth -1 --json";
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      BASE_SHA: "HEAD",
      TEST_SHARD: "rest",
    });
    expect(r.code).toBe(0);
    expect(r.log).toEqual([ls, "pnpm run test:prep", "pnpm exec vitest run"]);
    for (const TEST_SHARD of ["server", "cpu"]) {
      const x = run({
        GITHUB_EVENT_NAME: "pull_request",
        BASE_SHA: "HEAD",
        TEST_SHARD,
      });
      expect(x.code, TEST_SHARD).toBe(0);
      expect(x.log, TEST_SHARD).toEqual([ls]);
      expect(x.out, TEST_SHARD).toContain("@oa/server is not affected");
    }
  });
  it("a pull request that affects the server: each shard runs its share", () => {
    const listed = (names: string[]) =>
      `case " $* " in *" ls "*) echo '${JSON.stringify(names.map((name) => ({ name })))}' ;; esac`;
    const runWith = (names: string[], TEST_SHARD: string) => {
      const sb = sandbox({ pnpm: listed(names) });
      const r = sb.run(["bash", script("test-affected.sh")], {
        env: {
          GITHUB_EVENT_NAME: "pull_request",
          BASE_SHA: "HEAD",
          GITHUB_STEP_SUMMARY: "",
          GITHUB_OUTPUT: join(sb.dir, "out"),
          TEST_SHARD,
        },
      });
      return { ...r, log: sb.log() };
    };
    const ls = "pnpm --filter ...[HEAD] ls --depth -1 --json";
    const both = ["@oa/server", "@oa/dashboard"];
    expect(runWith(both, "server").log).toEqual([
      ls,
      "pnpm run test:prep",
      "pnpm --filter @oa/server test",
    ]);
    expect(runWith(both, "cpu").log).toEqual([
      ls,
      "pnpm run test:prep",
      "pnpm --filter @oa/server test:cpu",
    ]);
    expect(runWith(both, "rest").log).toEqual([
      ls,
      "pnpm run test:prep",
      "pnpm exec vitest run",
      "pnpm -r --if-present --filter ...[HEAD] --filter !@oa/server test",
    ]);
    // Only the server: rest runs the root suite and no package.
    expect(runWith(["@oa/server"], "rest").log).toEqual([
      ls,
      "pnpm run test:prep",
      "pnpm exec vitest run",
    ]);
  });
});
