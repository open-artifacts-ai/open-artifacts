// A PR that changes shipped code (apps/**, packages/**) must be titled fix: or
// feat: (or a breaking type!:), so release-please opens a release for it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  changedFiles,
  check,
  type Exec,
  isShipped,
  message,
  RELEASING,
  SHIPPED_TREES,
} from "./release-title.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = "apps/server/src/mcp/skill-template.ts";
const PUSH_SERVICE = "apps/server/src/services/push.ts";
const PR_3367_FILES = [
  "apps/dashboard/src/foryou/push.ts",
  "apps/dashboard/test/push-rekey.test.tsx",
  "apps/server/migrations/0057_push_subscription_diagnostics.sql",
  "apps/server/src/db/schema.ts",
  "apps/server/src/services/push.ts",
  "apps/server/src/services/web-push.ts",
  "apps/server/test/push.2512.test.ts",
  "packages/shared/src/inbox.ts",
];

describe("check", () => {
  it("fails #3367's non-conventional title on its shipped files and ignores its test files", () => {
    const v = check(
      "Show push provider results and replace subscriptions on re-enrollment",
      PR_3367_FILES,
    );
    expect(v).toEqual({
      ok: false,
      type: "",
      shipped: [
        "apps/dashboard/src/foryou/push.ts",
        "apps/server/migrations/0057_push_subscription_diagnostics.sql",
        "apps/server/src/db/schema.ts",
        "apps/server/src/services/push.ts",
        "apps/server/src/services/web-push.ts",
        "packages/shared/src/inbox.ts",
      ],
    });
    if (!v.ok) expect(message(v)).toContain("has no fix: or feat: type");
  });

  it("fails every title but lowercase fix:, feat: or breaking on a shipped file", () => {
    for (const t of [
      "docs: say how to share a page",
      "docs(skill): say how to share a page",
      "test: cover the skill text",
      "chore: tidy the upgrade guide",
      "Chore(mcp): tool text",
      "ci: update upload instructions",
      "refactor(mcp): split the skill",
      "perf: faster skill",
    ]) {
      const v = check(t, ["README.md", SKILL, PUSH_SERVICE]);
      expect(v, t).toEqual({
        ok: false,
        type: t.slice(0, t.search(/[(:]/)).toLowerCase(),
        shipped: [SKILL, PUSH_SERVICE],
      });
    }
    // Uppercase Fix:/Feat: and missing space after colon do not trigger release-please.
    expect(check("Fix: uppercase type", [PUSH_SERVICE])).toEqual({
      ok: false,
      type: "Fix",
      shipped: [PUSH_SERVICE],
    });
    expect(check("Feat!: uppercase breaking", [PUSH_SERVICE])).toEqual({
      ok: false,
      type: "Feat",
      shipped: [PUSH_SERVICE],
    });
    expect(check("fix:missing-space", [PUSH_SERVICE])).toEqual({
      ok: false,
      type: "",
      shipped: [PUSH_SERVICE],
    });
    expect(check("fix:   ", [PUSH_SERVICE])).toEqual({
      ok: false,
      type: "",
      shipped: [PUSH_SERVICE],
    });
  });

  it("fails a title with no type on a shipped file, and says what to do", () => {
    for (const t of [
      "update upload instructions",
      "Fix the skill",
      "Enable Antigravity by default when installed",
      "",
    ]) {
      const v = check(t, [PUSH_SERVICE]);
      expect(v, t).toEqual({ ok: false, type: "", shipped: [PUSH_SERVICE] });
      if (!v.ok) expect(message(v)).toContain("has no fix: or feat: type");
    }
  });

  it("passes fix:, feat: and breaking titles on shipped files", () => {
    for (const t of [
      "fix(skill): say how to share a page",
      "fix(ci): every shipped change needs a releasable PR title",
      "feat: a new tool",
      "fix: x",
      "chore!: drop an old tool",
      "docs(skill)!: breaking",
    ])
      expect(check(t, PR_3367_FILES), t).toEqual({ ok: true });
  });

  it("passes a no-release title that touches no shipped file", () => {
    expect(
      check("docs: contributing", ["CONTRIBUTING.md", "docs/ops/a.md"]),
    ).toEqual({ ok: true });
    expect(
      check("test: server", [
        "apps/server/test/skill.test.ts",
        "apps/server/test/bus/hub.rename.test.ts",
        "apps/dashboard/e2e/push.spec.ts",
        "packages/provisioning-contract/test-workerd/fixture-proof.test.ts",
      ]),
    ).toEqual({ ok: true });
    expect(
      check("chore(main): release 0.277.0", [
        "package.json",
        "CHANGELOG.md",
        ".release-please-manifest.json",
      ]),
    ).toEqual({ ok: true });
    expect(check("ci: tighten workflow", [".github/workflows/ci.yml"])).toEqual(
      { ok: true },
    );
    expect(check("chore: nothing", [])).toEqual({ ok: true });
    expect(check("update readme", ["README.md"])).toEqual({ ok: true });
  });

  it("classifies shipped code across apps/** and packages/** and excludes test/doc-only paths", () => {
    for (const f of [
      "apps/server/src/mcp/skill-template.ts",
      "apps/server/src/mcp/skill.ts",
      "apps/server/src/mcp/upgrade-template.ts",
      "apps/server/src/mcp/llms.ts",
      "apps/server/src/mcp/instructions.ts",
      "apps/server/src/mcp/tool-defs.ts",
      "apps/server/src/mcp/tools/artifacts.ts",
      "apps/server/scripts/emit-skill.ts",
      "apps/server/scripts/emit-upgrade.ts",
      "apps/server/src/services/push.ts",
      "apps/server/migrations/0057_push_subscription_diagnostics.sql",
      "apps/dashboard/src/main.tsx",
      "apps/dashboard/index.html",
      "apps/landing/src/content/docs/upgrade.md",
      "apps/auth-broker/src/index.ts",
      "packages/shared/src/inbox.ts",
      "packages/bus-cli/src/index.ts",
      "packages/bus-cli/output-style/artifacts-teammate.md",
      "packages/claude-code-shortcuts/plugin/README.md",
      "packages/provisioning-contract/src/authz.ts",
    ]) {
      expect(isShipped(f), f).toBe(true);
      expect(readFileSync(join(root, f), "utf8").length, f).toBeGreaterThan(0);
    }
    for (const f of [
      "apps/server/test/skill.test.ts",
      "apps/dashboard/e2e/foo.spec.ts",
      "apps/landing/test-browser/a.test.ts",
      "packages/provisioning-contract/test-workerd/fixture-proof.test.ts",
      "packages/bus-adapter-hermes/tests/a.test.ts",
      "packages/bus-ipc/test-setup/home-sentinel.ts",
      "packages/render/fixtures/kitchen-sink.md",
      "packages/ui/ladle/controls.stories.tsx",
      "apps/dashboard/dev/mock-askslots.html",
      "packages/bus-cli/design/PALETTE.md",
      "packages/bus-cli/docs/status-json.md",
      "apps/server/src/foo.test.ts",
      "apps/server/vitest.config.ts",
      "apps/server/wrangler.test.jsonc",
      "apps/dashboard/playwright.config.ts",
      "apps/auth-broker/README.md",
      "packages/shared/HOSTED_CONTRACT.md",
      "packages/bus-protocol/CONTRACT.md",
      "docs/ops/a.md",
      "scripts/ci/release-title.ts",
      "package.json",
      "CHANGELOG.md",
      ".release-please-manifest.json",
      "xapps/server/src/mcp/skill.ts",
    ])
      expect(isShipped(f), f).toBe(false);
    expect([...RELEASING].sort()).toEqual(["feat", "fix"]);
    expect(SHIPPED_TREES).toHaveLength(2);
  });

  it("names the files and the fix in its message", () => {
    const v = check("docs: x", [PUSH_SERVICE]);
    if (v.ok) throw new Error("expected a failure");
    const m = message(v);
    expect(m).toContain("titled `docs:`");
    expect(m).toContain(PUSH_SERVICE);
    expect(m).toContain("Retitle it fix: or feat:");
  });
});

describe("changedFiles", () => {
  it("lists the PR's files from the API, renames by both names", () => {
    const calls: string[][] = [];
    const exec: Exec = (_c, args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: `${SKILL}\nold/name.ts\nREADME.md\n`,
        stderr: "",
      };
    };
    expect(changedFiles(exec, "o/n", 12)).toEqual([
      SKILL,
      "old/name.ts",
      "README.md",
    ]);
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain("repos/o/n/pulls/12/files?per_page=100");
  });

  it("an API failure is an error, never a pass", () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(() => changedFiles(exec, "o/n", 12)).toThrow(/HTTP 502/);
  });
});

describe("the workflow", () => {
  const wf = parse(
    readFileSync(join(root, ".github/workflows/release-title.yml"), "utf8"),
  );
  const job = wf.jobs["release-title"];

  it("runs on PRs into main when apps/** or packages/** changes, and again when the title is edited", () => {
    expect(wf.on.pull_request.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
    ]);
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.pull_request.paths).toEqual(["apps/**", "packages/**"]);
    for (const p of wf.on.pull_request.paths as string[]) {
      const sample = p.replace("**", "pkg/src/x.ts");
      expect(isShipped(sample), p).toBe(true);
    }
  });

  it("reads only, and takes the title through env, never an expression in the script", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    const step = job.steps.find((s: { run?: string }) =>
      s.run?.includes("release-title.ts"),
    );
    expect(step.run).not.toContain("${{");
    expect(step.env.PR_TITLE).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ github.event.pull_request.title }}",
    );
  });

  it("is the only workflow that reads PR titles directly from the event context", () => {
    const dir = join(root, ".github/workflows");
    const readers = readdirSync(dir).filter((f) =>
      readFileSync(join(dir, f), "utf8").includes("pull_request.title"),
    );
    expect(readers).toEqual(["release-title.yml"]);
  });
});

describe("pr-title.yml", () => {
  const raw = readFileSync(
    join(root, ".github/workflows/pr-title.yml"),
    "utf8",
  );
  const wf = parse(raw);
  const job = wf.jobs["pr-title"];

  it("runs on every PR (no path filter), re-runs on title edit, and reports on merge_group", () => {
    expect(wf.name).toBe("pr-title");
    expect(Object.keys(wf.on)).toEqual(["pull_request", "merge_group"]);
    expect(wf.on.pull_request.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
    ]);
    expect(wf.on.pull_request.paths).toBeUndefined();
    expect(wf.on.pull_request.branches).toBeUndefined();
    expect(wf.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(wf.concurrency.group).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "pr-title-${{ github.event.pull_request.number || github.ref }}",
    );
  });

  it("pins amannn/action-semantic-pull-request to a full SHA with the 10 allowed types", () => {
    expect(job.steps).toHaveLength(2);
    const prStep = job.steps[0];
    expect(prStep.if).toBe("github.event_name == 'pull_request'");
    expect(prStep.uses).toMatch(
      /^amannn\/action-semantic-pull-request@[0-9a-f]{40}$/,
    );
    expect(raw).toMatch(
      /uses:\s+amannn\/action-semantic-pull-request@[0-9a-f]{40}\s+#\s+v\d/,
    );
    const types = String(prStep.with?.types ?? "")
      .trim()
      .split(/\s+/);
    expect(types).toEqual([
      "feat",
      "fix",
      "docs",
      "chore",
      "ci",
      "test",
      "refactor",
      "perf",
      "build",
      "revert",
    ]);
    const mgStep = job.steps[1];
    expect(mgStep.if).toBe("github.event_name == 'merge_group'");
    expect(mgStep.run).toBeTruthy();
  });

  it("grants only pull-requests: read and uses github.token (no secrets)", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ "pull-requests": "read" });
    expect(job.steps[0].env.GITHUB_TOKEN).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ github.token }}",
    );
    expect(raw).not.toMatch(/secrets\./);
  });
});
