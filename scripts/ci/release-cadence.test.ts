import { describe, expect, it } from "vitest";
import {
  arm,
  blocker,
  DRAIN_CAP_MS,
  type Exec,
  RELEASE_BRANCH,
  willWrite,
} from "./release-cadence.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-10-21T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type Ctx = {
  __typename: string;
  completedAt?: string;
  createdAt?: string;
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
};
type Fixture = {
  pr?: {
    number?: number;
    createdAt?: string;
    state?: string;
    queued?: boolean;
    armed?: boolean;
    armedBy?: string;
    oid?: string;
    contexts?: Ctx[];
  };
  queue?: { headRefName: string; number: number }[] | null;
  issues?: {
    number: number;
    title: string;
    createdAt: string;
    body?: string;
  }[];
  /** package.json versions at main and at the PR head (default: differ). */
  versions?: { main: string; head: string };
  release?: { tag_name: string; published_at: string } | null;
};

/** A fake `gh`: answers graphql and the REST/issue commands from the fixture and logs every call. */
function fake(f: Fixture) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd !== "gh") return { code: 127, stdout: "", stderr: "no" };
    if (args[0] === "api" && args[1] === "graphql") {
      const pr = f.pr
        ? [
            {
              number: f.pr.number ?? 301,
              url: `https://github.com/${REPO}/pull/${f.pr.number ?? 301}`,
              title: "chore(main): release 0.6.0",
              createdAt: f.pr.createdAt ?? hoursAgo(1),
              isInMergeQueue: f.pr.queued ?? false,
              autoMergeRequest: f.pr.armed
                ? {
                    enabledAt: hoursAgo(0),
                    enabledBy: { login: f.pr.armedBy ?? "oa-release" },
                  }
                : null,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: f.pr.oid ?? "abc123",
                      statusCheckRollup: {
                        state: f.pr.state ?? "SUCCESS",
                        contexts: { nodes: f.pr.contexts ?? [] },
                      },
                    },
                  },
                ],
              },
            },
          ]
        : [];
      const queue =
        f.queue === null || f.queue === undefined
          ? f.queue === null
            ? null
            : { entries: { totalCount: 0, nodes: [] } }
          : {
              entries: {
                totalCount: f.queue.length,
                nodes: f.queue.map((e) => ({
                  pullRequest: { number: e.number, headRefName: e.headRefName },
                })),
              },
            };
      return ok(
        JSON.stringify({
          data: {
            repository: { pullRequests: { nodes: pr }, mergeQueue: queue },
          },
        }),
      );
    }
    if (
      args[0] === "api" &&
      String(args[3]).includes("/contents/package.json")
    ) {
      const v = f.versions ?? { main: "0.5.0", head: "0.6.0" };
      return ok(
        JSON.stringify({
          version: String(args[3]).endsWith("?ref=main") ? v.main : v.head,
        }),
      );
    }
    if (args[0] === "issue" && args[1] === "list")
      return ok(JSON.stringify(f.issues ?? []));
    if (args[0] === "api" && String(args[1]).endsWith("/releases/latest"))
      return f.release
        ? ok(JSON.stringify(f.release))
        : { code: 1, stdout: "", stderr: "HTTP 404" };
    return ok("");
  };
  const wrote = (verb: string) =>
    calls.filter((c) => c[0] === "gh" && c.slice(1, 3).join(" ") === verb);
  return { exec, calls, wrote };
}
const logs = () => {
  const out: string[] = [];
  return { log: (s: string) => out.push(s), out };
};

const arm_ = (g: ReturnType<typeof fake>, extra: { capMs?: number } = {}) =>
  arm({
    exec: g.exec,
    repo: REPO,
    log: logs().log,
    now: () => NOW,
    appLogin: "oa-release[bot]",
    ...extra,
  });
const green = (minutesAgo: number): Ctx[] => [
  {
    __typename: "CheckRun",
    name: "a",
    conclusion: "SUCCESS",
    completedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  },
  {
    __typename: "CheckRun",
    name: "b",
    conclusion: "SUCCESS",
    completedAt: new Date(NOW - (minutesAgo + 20) * 60_000).toISOString(),
  },
];
const QUEUED = [{ number: 11, headRefName: "feat/a" }];

describe("drain cap and head pinning", () => {
  it("the cap is 30 minutes", () => {
    expect(DRAIN_CAP_MS).toBe(30 * 60_000);
  });

  it("waits while green for less than the cap and code PRs are queued", async () => {
    const g = fake({ pr: { contexts: green(29) }, queue: QUEUED });
    expect((await arm_(g)).action).toBe("waiting");
    expect(g.wrote("pr merge")).toEqual([]);
  });

  it("arms and logs 'cap hit' once the latest check completed 30 minutes ago", async () => {
    const g = fake({
      pr: { contexts: green(30), oid: "def456" },
      queue: QUEUED,
    });
    const l = logs();
    const r = await arm({
      exec: g.exec,
      repo: REPO,
      log: l.log,
      now: () => NOW,
    });
    expect(r.action).toBe("armed");
    expect(l.out.join("\n")).toContain("cap hit");
    expect(g.wrote("pr merge")).toHaveLength(1);
  });

  it("measures from the LATEST check, not the first", async () => {
    // latest check finished 10 minutes ago, an older one 50 minutes ago
    const g = fake({ pr: { contexts: green(10) }, queue: QUEUED });
    expect((await arm_(g)).action).toBe("waiting");
  });

  it("the cap is injectable", async () => {
    const g = fake({ pr: { contexts: green(5) }, queue: QUEUED });
    expect((await arm_(g, { capMs: 60_000 * 5 })).action).toBe("armed");
  });

  it("arms with --match-head-commit <sha>", async () => {
    const g = fake({ pr: { oid: "def456" } });
    await arm_(g);
    const [m] = g.wrote("pr merge");
    expect(m?.[m.indexOf("--match-head-commit") + 1]).toBe("def456");
    expect(m).toContain("--auto");
  });

  it("disables auto-merge when armed (not queued), code PRs are queued and the cap is not hit", async () => {
    const g = fake({ pr: { armed: true, contexts: green(5) }, queue: QUEUED });
    expect((await arm_(g)).action).toBe("disarmed");
    expect(g.wrote("pr merge")).toEqual([
      ["gh", "pr", "merge", "301", "--disable-auto", "--repo", REPO],
    ]);
  });

  it("leaves an armed PR alone when the queue is only release PRs, the cap is hit, or it is queued", async () => {
    for (const f of [
      { pr: { armed: true }, queue: [] },
      { pr: { armed: true, contexts: green(31) }, queue: QUEUED },
      { pr: { armed: true, queued: true }, queue: QUEUED },
    ]) {
      const g = fake(f);
      expect((await arm_(g)).action).toBe("already");
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("never disarms a human-armed release, nor when the App login is unknown", async () => {
    const f = {
      pr: { armed: true, armedBy: "leourbina", contexts: green(5) },
      queue: QUEUED,
    };
    const g = fake(f);
    expect((await arm_(g)).action).toBe("already");
    expect(g.wrote("pr merge")).toEqual([]);
    const g2 = fake({ ...f, pr: { ...f.pr, armedBy: "oa-release" } });
    expect(
      (
        await arm({
          exec: g2.exec,
          repo: REPO,
          log: logs().log,
          now: () => NOW,
        })
      ).action,
    ).toBe("already");
    expect(
      await willWrite({
        exec: fake(f).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(false);
  });

  it("willWrite says whether the run would touch the PR", async () => {
    expect(
      await willWrite({
        exec: fake({}).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(false);
    expect(
      await willWrite({
        exec: fake({ pr: {} }).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(true);
    expect(
      await willWrite({
        exec: fake({ pr: {}, queue: QUEUED }).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(false);
    expect(
      await willWrite({
        exec: fake({ pr: { state: "PENDING" } }).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(false);
    expect(
      await willWrite({
        exec: fake({ pr: { armed: true }, queue: QUEUED }).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(true);
    expect(
      await willWrite({
        exec: fake({ pr: { armed: true } }).exec,
        repo: REPO,
        now: () => NOW,
        appLogin: "oa-release",
      }),
    ).toBe(false);
  });
});

describe("arm", () => {
  it("does nothing when there is no release PR", async () => {
    const g = fake({});
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "none",
    });
    expect(g.wrote("pr merge")).toEqual([]);
  });

  it("never re-arms a release PR that already landed while GitHub still reads it open (#2379)", async () => {
    const g = fake({
      pr: { number: 2376, state: "SUCCESS" },
      versions: { main: "0.168.0", head: "0.168.0" },
    });
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "landed",
      pr: 2376,
    });
    expect(g.wrote("pr merge")).toEqual([]);
    expect(l.out.join("\n")).toContain("already landed");
    expect(await willWrite({ exec: g.exec, repo: REPO })).toBe(false);
  });

  it("looks the release PR up by its head branch", async () => {
    const g = fake({ pr: {} });
    await arm({ exec: g.exec, repo: REPO, log: logs().log });
    const q = g.calls.find((c) => c.includes("graphql")) ?? [];
    expect(q.join(" ")).toContain(`head=${RELEASE_BRANCH}`);
    expect(q.join(" ")).toContain("mergeQueue(branch:");
    expect(q.join(" ")).toContain("branch=main");
  });

  it("arms auto-merge when the rollup is SUCCESS and the queue is empty", async () => {
    const g = fake({ pr: { number: 301, state: "SUCCESS" } });
    expect(await arm({ exec: g.exec, repo: REPO, log: logs().log })).toEqual({
      action: "armed",
      pr: 301,
    });
    expect(g.wrote("pr merge")).toEqual([
      [
        "gh",
        "pr",
        "merge",
        "301",
        "--auto",
        "--squash",
        "--match-head-commit",
        "abc123",
        "--repo",
        REPO,
      ],
    ]);
  });

  it("arms when the queue only holds release PRs", async () => {
    const g = fake({
      pr: {},
      queue: [{ number: 299, headRefName: RELEASE_BRANCH }],
    });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("armed");
  });

  it("does not arm while the queue has other entries, and says how many", async () => {
    const g = fake({
      pr: {},
      queue: [
        { number: 11, headRefName: "feat/a" },
        { number: 12, headRefName: "fix/b" },
        { number: 299, headRefName: RELEASE_BRANCH },
      ],
    });
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "waiting",
      entries: 2,
    });
    expect(l.out).toContain("waiting for the queue to drain (2 entries)");
    expect(g.wrote("pr merge")).toEqual([]);
  });

  it("uses the same wording for any count", async () => {
    const g = fake({ pr: {}, queue: [{ number: 11, headRefName: "feat/a" }] });
    const l = logs();
    await arm({ exec: g.exec, repo: REPO, log: l.log });
    expect(l.out).toContain("waiting for the queue to drain (1 entries)");
  });

  it("does not arm a PR whose rollup is not SUCCESS", async () => {
    for (const state of ["PENDING", "FAILURE", "ERROR", "EXPECTED"]) {
      const g = fake({ pr: { state } });
      const l = logs();
      expect((await arm({ exec: g.exec, repo: REPO, log: l.log })).action).toBe(
        "not-green",
      );
      expect(l.out.join("\n")).toContain(state);
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("does nothing when the PR is already armed or already in the queue", async () => {
    for (const pr of [{ armed: true }, { queued: true }]) {
      const g = fake({ pr });
      expect(
        (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
      ).toBe("already");
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("a queue that doesn't exist (null) counts as empty", async () => {
    const g = fake({ pr: {}, queue: null });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("armed");
  });

  it("a failing gh pr merge is an error, not a silent pass", async () => {
    const g = fake({ pr: {} });
    const exec: Exec = (cmd, args) =>
      args[0] === "pr"
        ? { code: 1, stdout: "", stderr: "not allowed" }
        : g.exec(cmd, args);
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("a graphql failure is an error", async () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "bad token" });
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /bad token/,
    );
  });
});

describe("blocker", () => {
  const run = (f: Fixture) => {
    const g = fake(f);
    const l = logs();
    return blocker({
      exec: g.exec,
      repo: REPO,
      now: () => NOW,
      log: l.log,
    }).then((r) => ({ r, g, l }));
  };
  const body = (c: string[]) => c[c.indexOf("--body") + 1] as string;
  const title = (c: string[]) => c[c.indexOf("--title") + 1] as string;

  it("opens one blocker issue naming the failing checks with links when the rollup is FAILURE", async () => {
    const { r, g } = await run({
      pr: {
        state: "FAILURE",
        contexts: [
          {
            __typename: "CheckRun",
            name: "test",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/test",
          },
          {
            __typename: "CheckRun",
            name: "lint",
            conclusion: "SUCCESS",
            detailsUrl: "https://ci/lint",
          },
          {
            __typename: "StatusContext",
            context: "legacy",
            state: "ERROR",
            targetUrl: "https://ci/legacy",
          },
        ],
      },
    });
    expect(r).toEqual({ action: "opened" });
    const [create] = g.wrote("issue create");
    expect(create).toBeDefined();
    expect(title(create as string[])).toMatch(/^Release blocked: /);
    expect(title(create as string[])).toContain("failing checks");
    expect(create).toContain("--label");
    expect(create?.[create.indexOf("--label") + 1]).toBe("blocker");
    const b = body(create as string[]);
    expect(b).toContain("[test](https://ci/test)");
    expect(b).toContain("[legacy](https://ci/legacy)");
    expect(b).not.toContain("lint");
    expect(g.wrote("label create").length).toBe(1);
  });

  it("opens an issue when the PR is older than 24 hours, even if the checks pass", async () => {
    const { r, g } = await run({ pr: { createdAt: hoursAgo(25) } });
    expect(r.action).toBe("opened");
    expect(title(g.wrote("issue create")[0] as string[])).toContain("24 hours");
  });

  it("opens nothing for a young, green PR", async () => {
    const { r, g } = await run({ pr: { createdAt: hoursAgo(23) } });
    expect(r.action).toBe("none");
    expect(g.wrote("issue create")).toEqual([]);
  });

  it("refreshes the existing issue (found by label and title prefix) instead of opening a second", async () => {
    const { r, g } = await run({
      pr: {
        state: "FAILURE",
        contexts: [
          {
            __typename: "CheckRun",
            name: "e2e",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/e2e",
          },
        ],
      },
      issues: [
        {
          number: 7,
          title: "Release blocked: release PR #301 is over 24 hours old",
          createdAt: hoursAgo(30),
        },
        {
          number: 8,
          title: "Release v0.5.0 not live: healthz",
          createdAt: hoursAgo(5),
        },
      ],
    });
    expect(r).toEqual({ action: "refreshed", issue: 7 });
    expect(g.wrote("issue create")).toEqual([]);
    const [edit] = g.wrote("issue edit");
    expect(edit?.[3]).toBe("7");
    expect(body(edit as string[])).toContain("[e2e](https://ci/e2e)");
  });

  it("does not edit the issue when title and body are unchanged", async () => {
    const f: Fixture = { pr: { createdAt: hoursAgo(25) } };
    const first = await run(f);
    const create = first.g.wrote("issue create")[0] as string[];
    const { r, g } = await run({
      ...f,
      issues: [
        {
          number: 7,
          title: title(create),
          body: body(create),
          createdAt: hoursAgo(1),
        },
      ],
    });
    expect(r).toEqual({ action: "none" });
    expect(g.wrote("issue edit")).toEqual([]);
  });

  it("looks issues up by the blocker label", async () => {
    const { g } = await run({ pr: { state: "FAILURE" } });
    const list = g.wrote("issue list")[0] ?? [];
    expect(list).toContain("--label");
    expect(list[list.indexOf("--label") + 1]).toBe("blocker");
  });

  it("closes the issue with a comment when no release PR is open and a newer release shipped", async () => {
    const { r, g } = await run({
      issues: [
        {
          number: 7,
          title: "Release blocked: checks failing",
          createdAt: hoursAgo(30),
        },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(r).toEqual({ action: "closed", issues: [7] });
    const [close] = g.wrote("issue close");
    expect(close?.[3]).toBe("7");
    expect(close?.[close.indexOf("--comment") + 1]).toContain("v0.6.0");
  });

  it("keeps the issue open when the latest release is older than the issue", async () => {
    const { r, g } = await run({
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(3) },
      ],
      release: { tag_name: "v0.5.0", published_at: hoursAgo(50) },
    });
    expect(r.action).toBe("none");
    expect(g.wrote("issue close")).toEqual([]);
  });

  it("closes an older blocker on every run, even while a new release PR is open and healthy", async () => {
    const { r, g } = await run({
      pr: { createdAt: hoursAgo(1) },
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(30) },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(r).toEqual({ action: "closed", issues: [7] });
    const [close] = g.wrote("issue close");
    expect(close?.[close.indexOf("--comment") + 1]).toContain("v0.6.0");
  });

  it("does not refresh an issue it just closed, and leaves one opened after the release", async () => {
    const { g } = await run({
      pr: { state: "FAILURE" },
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(30) },
        { number: 8, title: "Release blocked: y", createdAt: hoursAgo(1) },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(g.wrote("issue close").map((c) => c[3])).toEqual(["7"]);
    expect(g.wrote("issue edit").map((c) => c[3])).toEqual(["8"]);
  });

  it("never touches issues whose title lacks the prefix", async () => {
    const { g } = await run({
      issues: [
        {
          number: 9,
          title: "Release v0.5.0 not live: healthz",
          createdAt: hoursAgo(30),
        },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(g.wrote("issue close")).toEqual([]);
  });

  it("no release at all (404) leaves issues alone", async () => {
    const { r } = await run({
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(30) },
      ],
      release: null,
    });
    expect(r.action).toBe("none");
  });
});
