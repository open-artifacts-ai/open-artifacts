import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  arm,
  blocker,
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
    oid?: string;
    id?: string;
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
  /** What enqueuePullRequest answers (default: the front, jumped). */
  enqueue?: { position: number; jump: boolean } | null;
};

/** A fake `gh`: answers graphql and the REST/issue commands from the fixture and logs every call. */
function fake(f: Fixture) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd !== "gh") return { code: 127, stdout: "", stderr: "no" };
    if (
      args[0] === "api" &&
      args[1] === "graphql" &&
      String(args[3]).startsWith("query=mutation")
    )
      return ok(
        JSON.stringify({
          data: {
            enqueuePullRequest: {
              mergeQueueEntry:
                f.enqueue === undefined
                  ? { position: 1, jump: true }
                  : f.enqueue,
            },
          },
        }),
      );
    if (args[0] === "api" && args[1] === "graphql") {
      const pr = f.pr
        ? [
            {
              id: f.pr.id ?? "PR_node301",
              number: f.pr.number ?? 301,
              url: `https://github.com/${REPO}/pull/${f.pr.number ?? 301}`,
              title: "chore(main): release 0.6.0",
              createdAt: f.pr.createdAt ?? hoursAgo(1),
              isInMergeQueue: f.pr.queued ?? false,
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

/** The enqueuePullRequest calls, as their -f fields. */
const enqueues = (g: ReturnType<typeof fake>) =>
  g.calls
    .filter((c) => String(c[4]).startsWith("query=mutation"))
    .map((c) =>
      Object.fromEntries(
        c
          .filter((_, k) => c[k - 1] === "-f")
          .map((x) => [
            x.slice(0, x.indexOf("=")),
            x.slice(x.indexOf("=") + 1),
          ]),
      ),
    );
const codePrs = (n: number) =>
  Array.from({ length: n }, (_, k) => ({
    number: 11 + k,
    headRefName: `feat/x${k}`,
  }));

describe("arm: the release PR jumps the queue as soon as it is green", () => {
  it("queues a green release PR at the front at once, however many code PRs are queued", async () => {
    // Leo: "Code merge to release should be 10, maybe 20 mins MAX". No
    // drain wait and no cap: the first green event queues it.
    for (const n of [0, 1, 5, 40]) {
      const g = fake({ pr: {}, queue: codePrs(n) });
      const l = logs();
      expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
        action: "enqueued",
        pr: 301,
        jumped: true,
      });
      expect(enqueues(g)).toHaveLength(1);
      expect(l.out).toContain(
        `queued release PR #301 at the front of the merge queue, ahead of ${n} code PRs`,
      );
      // No auto-merge: nothing waits for the queue to drain.
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("jumps, pinned to the head commit it checked and the PR's node id", async () => {
    const g = fake({ pr: { oid: "def456", id: "PR_kwDOabc" } });
    await arm({ exec: g.exec, repo: REPO, log: logs().log });
    const [m] = enqueues(g);
    expect(m?.id).toBe("PR_kwDOabc");
    expect(m?.oid).toBe("def456");
    expect(m?.query).toContain("enqueuePullRequest(input:");
    expect(m?.query).toContain("jump: true");
    expect(m?.query).toContain("expectedHeadOid: $oid");
  });

  it("asks for the PR's node id with the release PR", async () => {
    const g = fake({ pr: {} });
    await arm({ exec: g.exec, repo: REPO, log: logs().log });
    const q = g.calls.find((c) => String(c[4]).startsWith("query=query")) ?? [];
    expect(q.join(" ")).toMatch(/nodes \{\s+id\s+number/);
    expect(q.join(" ")).toContain(`head=${RELEASE_BRANCH}`);
    expect(q.join(" ")).toContain("mergeQueue(branch:");
    expect(q.join(" ")).toContain("branch=main");
  });

  it("says so when GitHub queues it without letting it jump", async () => {
    const g = fake({
      pr: {},
      queue: codePrs(2),
      enqueue: { position: 3, jump: false },
    });
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "enqueued",
      pr: 301,
      jumped: false,
    });
    expect(l.out.join("\n")).toContain(
      "GitHub did not let it jump (position 3)",
    );
  });

  it("an enqueue that GitHub refuses, or that returns no entry, is an error, not a silent pass", async () => {
    const g = fake({ pr: {} });
    const exec: Exec = (cmd, args) =>
      String(args[3]).startsWith("query=mutation")
        ? {
            code: 1,
            stdout: "",
            stderr: "Resource not accessible by integration",
          }
        : g.exec(cmd, args);
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /not accessible/,
    );
    const none = fake({ pr: {}, enqueue: null });
    await expect(
      arm({ exec: none.exec, repo: REPO, log: logs().log }),
    ).rejects.toThrow(/no queue entry/);
  });

  it("does nothing when there is no release PR", async () => {
    const g = fake({});
    expect(await arm({ exec: g.exec, repo: REPO, log: logs().log })).toEqual({
      action: "none",
    });
    expect(enqueues(g)).toEqual([]);
  });

  it("never queues a release PR that already landed while GitHub still reads it open (#2379)", async () => {
    const g = fake({
      pr: { number: 2376, state: "SUCCESS" },
      versions: { main: "0.168.0", head: "0.168.0" },
    });
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "landed",
      pr: 2376,
    });
    expect(enqueues(g)).toEqual([]);
    expect(l.out.join("\n")).toContain("already landed");
    expect(await willWrite({ exec: g.exec, repo: REPO })).toBe(false);
  });

  it("does not queue a PR whose rollup is not SUCCESS", async () => {
    for (const state of ["PENDING", "FAILURE", "ERROR", "EXPECTED"]) {
      const g = fake({ pr: { state }, queue: codePrs(1) });
      const l = logs();
      expect((await arm({ exec: g.exec, repo: REPO, log: l.log })).action).toBe(
        "not-green",
      );
      expect(l.out.join("\n")).toContain(state);
      expect(enqueues(g)).toEqual([]);
    }
  });

  it("leaves a release PR that is already in the queue alone", async () => {
    const g = fake({ pr: { queued: true }, queue: codePrs(3) });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("already");
    expect(enqueues(g)).toEqual([]);
  });

  it("a queue that doesn't exist (null) is no reason to wait", async () => {
    const g = fake({ pr: {}, queue: null });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("enqueued");
  });

  it("willWrite says whether the run would queue the PR, whatever the queue holds", async () => {
    const ww = (f: Fixture) => willWrite({ exec: fake(f).exec, repo: REPO });
    expect(await ww({})).toBe(false);
    expect(await ww({ pr: {} })).toBe(true);
    expect(await ww({ pr: {}, queue: codePrs(4) })).toBe(true);
    expect(await ww({ pr: { state: "PENDING" } })).toBe(false);
    expect(await ww({ pr: { queued: true } })).toBe(false);
  });

  it("the read is an error when graphql fails", async () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "bad token" });
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /bad token/,
    );
  });

  it("has no drain wait or cap left in the code", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./release-cadence.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/DRAIN_CAP|capMs|waiting for the queue to drain/);
    expect(src).not.toContain("--auto");
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
