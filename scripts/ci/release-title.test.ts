// A PR that changes what installs serve must be titled fix: or feat:, so a
// release ships it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  changedFiles,
  check,
  type Exec,
  message,
  RELEASING,
  SERVED,
} from "./release-title.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = "apps/server/src/mcp/skill-template.ts";

describe("check", () => {
  it("fails every title but fix:, feat: or breaking on a served file", () => {
    for (const t of [
      "docs: say how to share a page",
      "docs(skill): say how to share a page",
      "test: cover the skill text",
      "chore: tidy the upgrade guide",
      "Chore(mcp): tool text",
      // #3207's paths with the titles the Prover tried.
      "ci: update upload instructions",
      "refactor(mcp): split the skill",
      "perf: faster skill",
    ]) {
      const v = check(t, ["README.md", SKILL]);
      expect(v, t).toEqual({
        ok: false,
        type: t.slice(0, t.search(/[(:]/)).toLowerCase(),
        served: [SKILL],
      });
    }
  });

  it("fails a title with no type on a served file, and says what to do", () => {
    for (const t of ["update upload instructions", "Fix the skill", ""]) {
      const v = check(t, [SKILL]);
      expect(v, t).toEqual({ ok: false, type: "", served: [SKILL] });
      if (!v.ok) expect(message(v)).toContain("has no fix: or feat: type");
    }
  });

  it("passes fix:, feat: and breaking titles on a served file", () => {
    for (const t of [
      "fix(skill): say how to share a page",
      "feat: a new tool",
      "fix: x",
      "chore!: drop an old tool",
      "docs(skill)!: breaking",
    ])
      expect(check(t, [SKILL]), t).toEqual({ ok: true });
  });

  it("passes a no-release title that touches no served file", () => {
    expect(
      check("docs: contributing", ["CONTRIBUTING.md", "docs/ops/a.md"]),
    ).toEqual({ ok: true });
    expect(check("test: server", ["apps/server/test/skill.test.ts"])).toEqual({
      ok: true,
    });
    expect(check("chore: nothing", [])).toEqual({ ok: true });
    expect(check("update readme", ["README.md"])).toEqual({ ok: true });
  });

  it("the served paths are the skill, upgrade, llms, MCP instructions and tool text, and their emitters", () => {
    const served = (f: string) => SERVED.some((r) => r.test(f));
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
    ]) {
      expect(served(f), f).toBe(true);
      expect(readFileSync(join(root, f), "utf8").length, f).toBeGreaterThan(0);
    }
    for (const f of [
      "apps/server/test/skill.test.ts",
      "apps/dashboard/src/main.tsx",
      "docs/ops/a.md",
      "xapps/server/src/mcp/skill.ts",
    ])
      expect(served(f), f).toBe(false);
    expect([...RELEASING].sort()).toEqual(["feat", "fix"]);
  });

  it("names the files and the fix in its message", () => {
    const v = check("docs: x", [SKILL]);
    if (v.ok) throw new Error("expected a failure");
    const m = message(v);
    expect(m).toContain("titled `docs:`");
    expect(m).toContain(SKILL);
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

  it("runs on PRs into main when a served file changes, and again when the title is edited", () => {
    expect(wf.on.pull_request.types).toEqual([
      "opened",
      "edited",
      "synchronize",
      "reopened",
    ]);
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    // The path filter is the same list the script checks.
    expect(wf.on.pull_request.paths).toEqual([
      "apps/server/src/mcp/**",
      "apps/server/scripts/emit-skill.ts",
      "apps/server/scripts/emit-upgrade.ts",
    ]);
    for (const p of wf.on.pull_request.paths as string[]) {
      const sample = p.replace("**", "x.ts");
      expect(
        SERVED.some((r) => r.test(sample)),
        p,
      ).toBe(true);
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

  it("is the only workflow that reads PR titles", () => {
    const dir = join(root, ".github/workflows");
    const readers = readdirSync(dir).filter((f) =>
      readFileSync(join(dir, f), "utf8").includes("pull_request.title"),
    );
    expect(readers).toEqual(["release-title.yml"]);
  });
});
