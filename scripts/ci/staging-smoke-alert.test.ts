// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// staging-smoke-alert.ts and deploy-staging.yml's report job (#1406): a red
// post-deploy smoke on main keeps one `blocker` issue open, commenting on
// each later red run; a green run closes it; a cancelled run does nothing.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Exec, ISSUE, report } from "./staging-smoke-alert.ts";
import { root, script } from "./stubs.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const RUN = "https://github.com/x/actions/runs/1";
const SHA = "d".repeat(40);

const world = (
  open: { number: number; title: string }[],
  labels = [{ name: "blocker" }],
) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const out = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (args[0] === "issue" && args[1] === "list") return out(open);
    if (args[0] === "label" && args[1] === "list") return out(labels);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
};
const red = (w: ReturnType<typeof world>, result = "failure") =>
  report({ exec: w.exec, repo: REPO, result, run: RUN, sha: SHA });

describe("staging-smoke-alert.ts report", () => {
  it("the first red run opens one blocker issue with the stable title, linking the run", () => {
    const w = world([
      { number: 3, title: "Prod release chain failed: v1.0.0" },
    ]);
    expect(red(w)).toEqual({ action: "opened" });
    const create = w.calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    const at = (f: string) => create?.[(create?.indexOf(f) ?? 0) + 1];
    expect(at("--title")).toBe(ISSUE);
    expect(at("--label")).toBe("blocker");
    expect(at("--body")).toContain(RUN);
    expect(at("--body")).toContain(SHA);
    expect(at("--body")).toContain("`failure`");
    // It reads only open blocker issues.
    expect(w.calls[0]).toEqual([
      "issue",
      "list",
      "--repo",
      REPO,
      "--label",
      "blocker",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "100",
    ]);
  });

  it("a later red run comments on the open issue (a notification), never opens a second", () => {
    const w = world([{ number: 4, title: ISSUE }]);
    expect(red(w)).toEqual({ action: "commented", issue: 4 });
    expect(w.calls.some((c) => c[1] === "create")).toBe(false);
    const c = w.calls.find((x) => x[0] === "issue" && x[1] === "comment");
    expect(c?.slice(0, 5)).toEqual(["issue", "comment", "4", "--repo", REPO]);
    expect(c?.[6]).toBe(`Still red: \`failure\` on ${SHA} in ${RUN}`);
  });

  it("another issue whose title only starts the same is not its own", () => {
    const w = world([{ number: 5, title: `${ISSUE} (old)` }]);
    expect(red(w)).toEqual({ action: "opened" });
  });

  it("a failed deploy, or an unknown result, is red too", () => {
    for (const result of ["failure", "", "neutral"])
      expect(red(world([]), result), result).toEqual({ action: "opened" });
  });

  it("creates the shared label only when it is missing", () => {
    const w = world([], []);
    red(w);
    expect(w.calls.find((c) => c[0] === "label" && c[1] === "create")).toEqual(
      expect.arrayContaining(["label", "create", "blocker"]),
    );
    const v = world([]);
    red(v);
    expect(v.calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(
      false,
    );
  });

  it("a green run closes it with a comment linking the passing run", () => {
    const w = world([
      { number: 4, title: ISSUE },
      { number: 3, title: "Nightly red-line failed: v1.0.0" },
    ]);
    expect(red(w, "success")).toEqual({ action: "closed", issues: [4] });
    const close = w.calls.filter((c) => c[1] === "close");
    expect(close).toEqual([
      [
        "issue",
        "close",
        "4",
        "--repo",
        REPO,
        "--comment",
        `Green again: the smoke passed on ${SHA} in ${RUN}`,
      ],
    ]);
    expect(red(world([]), "success")).toEqual({ action: "none" });
  });

  it("a cancelled or skipped run does nothing at all", () => {
    for (const result of ["cancelled", "skipped"]) {
      const w = world([{ number: 4, title: ISSUE }]);
      expect(red(w, result), result).toEqual({ action: "none" });
      expect(w.calls).toEqual([]);
    }
  });

  it("an API error throws, so the report job goes red", () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(() =>
      report({ exec, repo: REPO, result: "failure", run: RUN, sha: SHA }),
    ).toThrow(/HTTP 502/);
  });

  it("the CLI needs report and --repo", () => {
    const cli = (args: string[]) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          script("staging-smoke-alert.ts"),
          ...args,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      ).status;
    expect(cli([])).not.toBe(0);
    expect(cli(["report", "--result", "cancelled"])).not.toBe(0);
    expect(
      cli(["report", "--repo", REPO, "--result", "cancelled", "--run", RUN]),
    ).toBe(0);
  });
});

describe("deploy-staging.yml report job", () => {
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const w: any = parse(
    readFileSync(join(root, ".github/workflows/deploy-staging.yml"), "utf8"),
  );
  const job = w.jobs.report;

  it("runs after deploy and smoke, whatever they did, on main only", () => {
    expect(job.needs).toEqual(["deploy", "smoke"]);
    expect(job.if).toBe("${{ always() && github.ref == 'refs/heads/main' }}");
  });

  it("is the only job that may write issues, at job level", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    for (const [name, j] of Object.entries(w.jobs))
      if (name !== "report")
        // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
        expect((j as any).permissions, name).toBeUndefined();
  });

  it("reports the smoke's result, or the deploy's when the deploy did not succeed", () => {
    const step = job.steps.find(
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      (s: any) => s.name === "Keep the blocker issue in step",
    );
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      RESULT:
        "${{ needs.deploy.result == 'success' && needs.smoke.result || needs.deploy.result }}",
      RUN: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      SHA: "${{ github.sha }}",
    });
    expect(step.run).toBe(
      'node --experimental-strip-types scripts/ci/staging-smoke-alert.ts report --repo "$GITHUB_REPOSITORY" --result "$RESULT" --run "$RUN" --sha "$SHA"',
    );
    // No secret reaches it.
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.steps[0].with["persist-credentials"]).toBe(false);
  });
});
