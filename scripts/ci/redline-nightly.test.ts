// The nightly: one run per release, never beside another red-line run, and
// its result lands in a `blocker` issue, not in a session or an email.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Exec, plan, ranArtifact, report } from "./redline-nightly.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-11-03T03:17:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const TAG = "v0.99.0";
type R = {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
};

const world = (o: {
  latest?: string;
  staging?: R[];
  nightly?: R[];
  ran?: number;
  failApi?: string;
}) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const path = args[1] ?? "";
    if (o.failApi && path.includes(o.failApi))
      return { code: 1, stdout: "", stderr: "HTTP 502" };
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (path.endsWith("/releases/latest"))
      return json({ tag_name: o.latest ?? TAG });
    if (path.includes("/workflows/redline-staging.yml/"))
      return json({ workflow_runs: o.staging ?? [] });
    if (path.includes("/workflows/redline-nightly.yml/"))
      return json({ workflow_runs: o.nightly ?? [] });
    if (path.includes("/actions/artifacts"))
      return json({ total_count: o.ran ?? 0 });
    throw new Error(`unexpected ${path}`);
  };
  return { exec, calls };
};
const go = (o: Parameters<typeof world>[0], version = "0.99.0") =>
  plan({
    exec: world(o).exec,
    repo: REPO,
    ownRun: 1,
    now: NOW,
    stagingVersion: async () => version,
  });
const done = (id: number, title: string, conclusion: string): R => ({
  id,
  status: "completed",
  conclusion,
  display_title: title,
  created_at: hoursAgo(30),
});

describe("plan", () => {
  it("runs a new release that staging runs", async () => {
    expect(await go({})).toMatchObject({ run: true, tag: TAG });
  });

  it("idle: a release that had its nightly uses nothing", async () => {
    expect(await go({ ran: 1 })).toMatchObject({ run: false });
  });

  it("idle: a candidate run on the tag counts, green or red", async () => {
    for (const c of ["success", "failure"])
      expect(
        await go({ staging: [done(9, `redline-staging ${TAG}`, c)] }),
      ).toMatchObject({ run: false });
  });

  it("a cancelled run, or one on another tag, doesn't count", async () => {
    expect(
      await go({
        staging: [
          done(9, `redline-staging ${TAG}`, "cancelled"),
          done(8, "redline-staging v0.98.0", "success"),
        ],
      }),
    ).toMatchObject({ run: true });
  });

  it("skips while any red-line run is going, in either workflow", async () => {
    for (const status of ["queued", "in_progress", "waiting"]) {
      const busy: R = {
        id: 7,
        status,
        conclusion: null,
        display_title: "x",
      };
      expect(await go({ staging: [busy] })).toMatchObject({ run: false });
      expect(await go({ nightly: [busy] })).toMatchObject({ run: false });
    }
  });

  it("its own run in progress isn't a reason to skip", async () => {
    expect(
      await go({
        nightly: [
          {
            id: 1,
            status: "in_progress",
            conclusion: null,
            display_title: "x",
          },
        ],
      }),
    ).toMatchObject({ run: true });
  });

  it("waits 3 h after any candidate run, so it never holds one", async () => {
    const r = (h: number): R => ({
      ...done(9, "redline-staging v0.98.0", "success"),
      created_at: hoursAgo(h),
    });
    expect(await go({ staging: [r(2.9)] })).toMatchObject({ run: false });
    expect(await go({ staging: [r(3.1)] })).toMatchObject({ run: true });
  });

  it("waits until staging runs the release", async () => {
    expect(await go({}, "0.98.0")).toMatchObject({
      run: false,
      why: "staging runs 0.98.0, not v0.99.0",
    });
  });

  it("an API error or an odd tag throws, never a quiet skip", async () => {
    await expect(go({ failApi: "/releases/latest" })).rejects.toThrow("502");
    await expect(go({ failApi: "/workflows/" })).rejects.toThrow("502");
    await expect(go({ failApi: "/actions/artifacts" })).rejects.toThrow("502");
    await expect(go({ latest: "v1.2.3-rc1" })).rejects.toThrow("isn't vX.Y.Z");
    await expect(go({ latest: "v1.2.3; x" })).rejects.toThrow("isn't vX.Y.Z");
  });

  it("names the artifact after the tag", () => {
    expect(ranArtifact(TAG)).toBe("redline-nightly-v0.99.0");
  });
});

describe("report", () => {
  const issues = (
    open: { number: number; title: string }[],
    labels: string[] = ["blocker"],
  ) => {
    const calls: string[][] = [];
    const exec: Exec = (_c, args) => {
      calls.push(args);
      const list =
        args[0] === "label"
          ? labels.map((name) => ({ name }))
          : args[1] === "list"
            ? open
            : null;
      return {
        code: 0,
        stdout: list ? JSON.stringify(list) : "",
        stderr: "",
      };
    };
    return { exec, calls };
  };
  const RUN = "https://github.com/x/y/actions/runs/1";
  const base = { repo: REPO, tag: TAG, run: RUN };
  const OTHER = { number: 5, title: "Release blocked: v0.99.0" };
  const MINE = { number: 6, title: "Nightly red-line failed: v0.98.0" };

  it("red opens one blocker issue with the run", () => {
    const { exec, calls } = issues([OTHER]);
    expect(report({ ...base, exec, result: "failure" })).toEqual({
      action: "opened",
    });
    const create = calls.find((c) => c[1] === "create" && c[0] === "issue");
    expect(create).toContain("Nightly red-line failed: v0.99.0");
    expect(create).toContain("blocker");
    expect(create?.join(" ")).toContain(RUN);
  });

  it("never resets the shared label; creates it only when missing", () => {
    const has = issues([]);
    report({ ...base, exec: has.exec, result: "failure" });
    expect(has.calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(
      false,
    );
    expect(has.calls.flat()).not.toContain("--force");
    const none = issues([], ["blocked-ish"]);
    report({ ...base, exec: none.exec, result: "failure" });
    expect(none.calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(
      true,
    );
  });

  it("red with one open refreshes it, no second issue", () => {
    const { exec, calls } = issues([MINE]);
    expect(report({ ...base, exec, result: "cancelled" })).toEqual({
      action: "refreshed",
      issue: 6,
    });
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("a failed pick still reports, with no tag", () => {
    const { exec, calls } = issues([]);
    report({ ...base, tag: "", exec, result: "failure" });
    expect(calls.find((c) => c[0] === "issue" && c[1] === "create")).toContain(
      "Nightly red-line failed: no release picked",
    );
  });

  it("green closes only its own issue", () => {
    const { exec, calls } = issues([OTHER, MINE]);
    expect(report({ ...base, exec, result: "success" })).toEqual({
      action: "closed",
      issues: [6],
    });
    expect(calls.filter((c) => c[1] === "close")).toHaveLength(1);
  });

  it("green with nothing open does nothing", () => {
    const { exec } = issues([OTHER]);
    expect(report({ ...base, exec, result: "success" })).toEqual({
      action: "none",
    });
  });
});

describe("redline-nightly.yml", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const text = readFileSync(
    join(root, ".github/workflows/redline-nightly.yml"),
    "utf8",
  );
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const w: any = parse(text);

  it("runs on a schedule only: a manual run would fire P30's alert", () => {
    expect(Object.keys(w.on)).toEqual(["schedule"]);
    expect(w.permissions).toEqual({});
  });

  it("calls redline-staging.yml with the picked tag, only when picked", () => {
    const j = w.jobs.redline;
    expect(j.uses).toBe("./.github/workflows/redline-staging.yml");
    expect(j.needs).toBe("pick");
    expect(j.if).toBe("needs.pick.outputs.run == 'true'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(j.with).toEqual({ tag: "${{ needs.pick.outputs.tag }}" });
    expect(j.permissions).toEqual({ contents: "read", "id-token": "write" });
    // The callee's Environments carry its secrets; nothing repo-level goes.
    expect(j.secrets).toBeUndefined();
  });

  it("records the release before it runs", () => {
    const up = w.jobs.pick.steps.find((s: { uses?: string }) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up.with.name).toBe("redline-nightly-${{ steps.plan.outputs.tag }}");
    expect(up.if).toBe("steps.plan.outputs.run == 'true'");
  });

  it("reports whatever happened, and a failed pick too", () => {
    const j = w.jobs.report;
    expect(j.needs).toEqual(["pick", "redline"]);
    expect(j.if).toContain("always()");
    expect(j.if).toContain("needs.pick.result != 'success'");
    expect(j.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("only the report job can write, and it writes issues", () => {
    expect(w.jobs.pick.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    // No assignee: an issue the status refresh reads, not a page to the owner.
    expect(
      text + readFileSync(join(root, "scripts/ci/redline-nightly.ts"), "utf8"),
    ).not.toMatch(/--assignee|oa-blocker/);
  });
});
