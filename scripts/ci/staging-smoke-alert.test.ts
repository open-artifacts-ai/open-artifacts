// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// staging-smoke-alert.ts and deploy-staging.yml's report job (#1406): a red
// post-deploy smoke on main keeps one `blocker` issue open, commenting on
// each later red run; a green run closes it; a cancelled run does nothing.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Exec, ISSUE, LOGIN_RE, report } from "./staging-smoke-alert.ts";
import { root, script } from "./stubs.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const RUN = "https://github.com/x/actions/runs/1";
const SHA = "d".repeat(40);

const LOGIN = "owner-login";
const world = (
  open: { number: number; title: string }[],
  labels = [{ name: "blocker" }],
  /** gh issue edit --add-assignee fails. */
  assignFails = false,
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
    if (args[0] === "issue" && args[1] === "create")
      return {
        code: 0,
        stdout: `https://github.com/${REPO}/issues/12\n`,
        stderr: "",
      };
    if (args[0] === "issue" && args[1] === "edit" && assignFails)
      return { code: 1, stdout: "", stderr: "could not assign user" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
};
const red = (
  w: ReturnType<typeof world>,
  result = "failure",
  notify = "",
  log: (l: string) => void = () => {},
) =>
  report({ exec: w.exec, repo: REPO, result, run: RUN, sha: SHA, notify, log });
const OPENED = { action: "opened", issue: 12, notified: "none" };

describe("staging-smoke-alert.ts report", () => {
  it("the first red run opens one blocker issue with the stable title, linking the run", () => {
    const w = world([
      { number: 3, title: "Prod release chain failed: v1.0.0" },
    ]);
    expect(red(w)).toEqual(OPENED);
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
    expect(red(w)).toEqual({ action: "commented", issue: 4, notified: "none" });
    expect(w.calls.some((c) => c[1] === "create")).toBe(false);
    const c = w.calls.find((x) => x[0] === "issue" && x[1] === "comment");
    expect(c?.slice(0, 5)).toEqual(["issue", "comment", "4", "--repo", REPO]);
    expect(c?.[6]).toBe(`Still red: \`failure\` on ${SHA} in ${RUN}`);
  });

  it("another issue whose title only starts the same is not its own", () => {
    const w = world([{ number: 5, title: `${ISSUE} (old)` }]);
    expect(red(w)).toEqual(OPENED);
  });

  it("a failed deploy, or an unknown result, is red too", () => {
    for (const result of ["failure", "", "neutral"])
      expect(red(world([]), result), result).toEqual(OPENED);
  });

  it("OA_ALERT_GITHUB_LOGIN set: the new issue is assigned to it; each repeat red comment @-mentions it", () => {
    const logs: string[] = [];
    const w = world([]);
    expect(red(w, "failure", LOGIN, (l) => logs.push(l))).toEqual({
      action: "opened",
      issue: 12,
      notified: "assigned",
    });
    // Assigned after the issue exists, never as part of its creation.
    expect(w.calls.find((c) => c[1] === "create")?.includes("--assignee")).toBe(
      false,
    );
    expect(w.calls.at(-1)).toEqual([
      "issue",
      "edit",
      "12",
      "--repo",
      REPO,
      "--add-assignee",
      LOGIN,
    ]);
    const v = world([{ number: 4, title: ISSUE }]);
    expect(red(v, "failure", LOGIN, (l) => logs.push(l))).toEqual({
      action: "commented",
      issue: 4,
      notified: "mentioned",
    });
    const c = v.calls.find((x) => x[1] === "comment");
    expect(c?.[6]).toBe(`@${LOGIN} Still red: \`failure\` on ${SHA} in ${RUN}`);
    expect(v.calls.some((x) => x[1] === "edit")).toBe(false);
    expect(logs).toEqual([]);
  });

  it("OA_ALERT_GITHUB_LOGIN unset: no assignment, no mention, and it says so", () => {
    for (const notify of ["", "  "]) {
      const logs: string[] = [];
      const w = world([]);
      expect(red(w, "failure", notify, (l) => logs.push(l))).toEqual(OPENED);
      expect(w.calls.some((c) => c[1] === "edit")).toBe(false);
      expect(JSON.stringify(w.calls)).not.toContain("@");
      expect(logs).toEqual([
        "staging-smoke-alert: OA_ALERT_GITHUB_LOGIN is empty; no assignment or mention",
      ]);
      const v = world([{ number: 4, title: ISSUE }]);
      red(v, "failure", notify, () => {});
      expect(v.calls.find((x) => x[1] === "comment")?.[6]).toBe(
        `Still red: \`failure\` on ${SHA} in ${RUN}`,
      );
    }
  });

  it("one leading @ is dropped: @login works like login", () => {
    const w = world([{ number: 4, title: ISSUE }]);
    expect(red(w, "failure", ` @${LOGIN} `)).toEqual({
      action: "commented",
      issue: 4,
      notified: "mentioned",
    });
    expect(w.calls.find((x) => x[1] === "comment")?.[6]).toBe(
      `@${LOGIN} Still red: \`failure\` on ${SHA} in ${RUN}`,
    );
    const v = world([]);
    red(v, "failure", `@${LOGIN}`);
    expect(v.calls.at(-1)?.slice(-2)).toEqual(["--add-assignee", LOGIN]);
  });

  it("set but not a GitHub login: the issue is still kept in step, with no mention, then the job fails", () => {
    for (const bad of [
      "@@owner",
      "a b",
      "-owner",
      "owner-",
      "own--er",
      "x".repeat(40),
      "owner\n@evil",
      "@",
    ]) {
      expect(LOGIN_RE.test(bad.replace(/^@/, "")), bad).toBe(false);
      // A repeat red run: commented, no mention, then it throws.
      const logs: string[] = [];
      const v = world([{ number: 4, title: ISSUE }]);
      expect(() => red(v, "failure", bad, (l) => logs.push(l)), bad).toThrow(
        /OA_ALERT_GITHUB_LOGIN is set but is not a GitHub login/,
      );
      expect(v.calls.find((x) => x[1] === "comment")?.[6], bad).toBe(
        `Still red: \`failure\` on ${SHA} in ${RUN}`,
      );
      expect(logs[0], bad).toContain("is not a GitHub login");
      // A first red run: opened, never assigned, then it throws.
      const w = world([]);
      expect(() => red(w, "failure", bad), bad).toThrow(/not a GitHub login/);
      expect(
        w.calls.some((c) => c[1] === "create"),
        bad,
      ).toBe(true);
      expect(
        w.calls.some((c) => c[1] === "edit"),
        bad,
      ).toBe(false);
      // A green run still closes the issue, and still fails the job.
      const g = world([{ number: 4, title: ISSUE }]);
      expect(() => red(g, "success", bad), bad).toThrow(/not a GitHub login/);
      expect(
        g.calls.some((c) => c[1] === "close"),
        bad,
      ).toBe(true);
    }
    // A cancelled run does nothing at all, a bad value included.
    const c = world([{ number: 4, title: ISSUE }]);
    expect(red(c, "cancelled", "a b")).toEqual({ action: "none" });
    expect(c.calls).toEqual([]);
    for (const ok of ["octocat", "a", "a-b-c", "A1", "x".repeat(39)])
      expect(LOGIN_RE.test(ok), ok).toBe(true);
  });

  it("gh issue create output that isn't an issue URL throws", () => {
    for (const stdout of [
      "",
      "created",
      `https://github.com/${REPO}/pull/12`,
    ]) {
      const exec: Exec = (_c, args) => {
        if (args[1] === "list")
          return {
            code: 0,
            stdout: args[0] === "label" ? '[{"name":"blocker"}]' : "[]",
            stderr: "",
          };
        if (args[1] === "create") return { code: 0, stdout, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };
      expect(
        () =>
          report({ exec, repo: REPO, result: "failure", run: RUN, sha: SHA }),
        stdout,
      ).toThrow(/gh issue create: no issue url/);
    }
  });

  it("an assignment that fails leaves the issue open and @-mentions the login instead", () => {
    const logs: string[] = [];
    const w = world([], [{ name: "blocker" }], true);
    expect(red(w, "failure", LOGIN, (l) => logs.push(l))).toEqual({
      action: "opened",
      issue: 12,
      notified: "mentioned",
    });
    expect(w.calls.at(-1)).toEqual([
      "issue",
      "comment",
      "12",
      "--repo",
      REPO,
      "--body",
      `@${LOGIN} the staging smoke is red on main: ${RUN}`,
    ]);
    expect(logs).toEqual([
      "staging-smoke-alert: assigning issue 12 failed (could not assign user); mentioning instead",
    ]);
  });

  it("no login is written in the code or the workflow", () => {
    for (const f of [
      "scripts/ci/staging-smoke-alert.ts",
      ".github/workflows/deploy-staging.yml",
    ])
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/leourbina/);
  });

  it("a green or cancelled run never assigns or mentions", () => {
    for (const result of ["success", "cancelled"]) {
      const w = world([{ number: 4, title: ISSUE }]);
      red(w, result, LOGIN);
      expect(JSON.stringify(w.calls), result).not.toContain("@");
      expect(
        w.calls.some((c) => c[1] === "edit"),
        result,
      ).toBe(false);
    }
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
      // The login comes from a repo variable, never from code.
      NOTIFY: "${{ vars.OA_ALERT_GITHUB_LOGIN }}",
    });
    expect(step.run).toBe(
      'node --experimental-strip-types scripts/ci/staging-smoke-alert.ts report --repo "$GITHUB_REPOSITORY" --result "$RESULT" --run "$RUN" --sha "$SHA" --notify "$NOTIFY"',
    );
    // No secret reaches it.
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.steps[0].with["persist-credentials"]).toBe(false);
  });
});
