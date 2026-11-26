import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIONS_APP_ID,
  arm,
  blocker,
  type Exec,
  planStep,
  RELEASE_BRANCH,
  REQUIRED_CHECKS,
  willWrite,
} from "./release-cadence.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-10-21T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

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
    title?: string;
    createdAt?: string;
    state?: string;
    queued?: boolean;
    draft?: boolean;
    fork?: boolean;
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
  /** The release files at the PR head (default: all 0.6.0). */
  files?: { manifest?: string; changelog?: string };
  /** The repo's tags (default: up to v0.5.0). */
  tags?: string[];
  /** The PR head a fresh read returns (default: the planning read's). */
  headNow?: string;
  /** main's manifest and package.json (default: 0.5.0; null: unreadable). */
  main?: { manifest?: string | null; pkg?: string | null };
  /** The check runs on the head (default: the five required, green). */
  checks?: Partial<CheckRow>[];
  /** main's applied rules (default: the ruleset's five); null: unreadable. */
  rules?: unknown[] | null;
  /** main's branch-protection checks (default: all seven); null: unreadable. */
  protection?: { context: string; app_id: number }[] | null;
  release?: { tag_name: string; published_at: string } | null;
  /** What enqueuePullRequest answers (default: the front, jumped). */
  enqueue?: { position: number; jump: boolean } | null;
};

type CheckRow = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app: number;
  head_sha: string;
  started_at: string | null;
};
/** A check run GitHub Actions reported on the head, green unless told. */
const check = (name: string, o: Partial<CheckRow> = {}): Partial<CheckRow> => ({
  id: 9000,
  name,
  status: "completed",
  conclusion: "success",
  app: ACTIONS_APP_ID,
  started_at: hoursAgo(0.5),
  ...o,
});
const allGreen = () => REQUIRED_CHECKS.map((n) => check(n));

/** A fake `gh`: answers graphql and the REST/issue commands from the fixture and logs every call. */
function fake(f: Fixture) {
  const calls: string[][] = [];
  const oid = f.pr?.oid ?? SHA;
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd !== "gh") return { code: 127, stdout: "", stderr: "no" };
    const path = String(args.find((a) => a.startsWith("repos/")) ?? "");
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
              title: f.pr.title ?? "chore(main): release 0.6.0",
              createdAt: f.pr.createdAt ?? hoursAgo(1),
              isDraft: f.pr.draft ?? false,
              isCrossRepository: f.pr.fork ?? false,
              isInMergeQueue: f.pr.queued ?? false,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid,
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
    const unreadable = { code: 1, stdout: "", stderr: "HTTP 403" };
    if (args[0] === "api" && path.endsWith("/rules/branches/main"))
      return f.rules === null
        ? unreadable
        : ok(
            JSON.stringify(
              f.rules ?? [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [
                      "lint",
                      "typecheck",
                      "test",
                      "build",
                      "e2e",
                    ].map((context) => ({ context, integration_id: 15368 })),
                  },
                },
                { type: "merge_queue", parameters: {} },
              ],
            ),
          );
    if (args[0] === "api" && path.endsWith("/branches/main"))
      return f.protection === null
        ? unreadable
        : ok(
            JSON.stringify({
              protection: {
                enabled: true,
                required_status_checks: {
                  checks:
                    f.protection ??
                    REQUIRED_CHECKS.map((context) => ({
                      context,
                      app_id: 15368,
                    })),
                },
              },
            }),
          );
    const checks = /\/commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
    if (args[0] === "api" && checks)
      return ok(
        (f.checks ?? allGreen())
          .map((r) => `${JSON.stringify({ head_sha: checks[1], ...r })}\n`)
          .join(""),
      );
    const file = /\/contents\/([^?]+)\?ref=(.+)$/.exec(path);
    if (args[0] === "api" && file) {
      const [, name, ref] = file;
      const v = f.versions ?? { main: "0.5.0", head: "0.6.0" };
      const missing = { code: 1, stdout: "", stderr: "HTTP 502" };
      if (ref === "main" && name === "package.json" && f.main?.pkg === null)
        return missing;
      if (ref === "main" && name === "package.json" && f.main?.pkg)
        return ok(JSON.stringify({ version: f.main.pkg }));
      if (ref === "main" && name === ".release-please-manifest.json")
        return f.main?.manifest === null
          ? missing
          : ok(JSON.stringify({ ".": f.main?.manifest ?? v.main }));
      if (name === "package.json")
        return ok(
          JSON.stringify({ version: ref === "main" ? v.main : v.head }),
        );
      if (name === ".release-please-manifest.json")
        return ok(f.files?.manifest ?? JSON.stringify({ ".": "0.6.0" }));
      if (name === "CHANGELOG.md")
        return ok(
          f.files?.changelog ??
            "# Changelog\n\n## [0.6.0](https://x/compare/v0.5.0...v0.6.0) (2026-10-21)\n\n## [0.5.0](https://x) (2026-10-20)\n",
        );
      return { code: 1, stdout: "", stderr: "HTTP 404" };
    }
    if (args[0] === "api" && path.endsWith("/git/matching-refs/tags/v"))
      return ok(
        (f.tags ?? ["v0.4.12", "v0.5.0", "v0.5.0-rc.1"])
          .map((t) => `refs/tags/${t}\n`)
          .join(""),
      );
    if (args[0] === "api" && /\/pulls\/\d+$/.test(path))
      return ok(`${f.headNow ?? oid}\n`);
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

const go = (g: ReturnType<typeof fake>, l = logs()) =>
  arm({ exec: g.exec, repo: REPO, log: l.log });

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

describe("arm: the release PR jumps the queue as soon as its CI goes green", () => {
  it("queues a green release PR at the front at once, however many code PRs are queued", async () => {
    // Leo: "Code merge to release should be 10, maybe 20 mins MAX". No
    // drain wait and no cap: the first event that sees its CI green queues it.
    for (const n of [0, 1, 5, 40]) {
      const g = fake({ pr: {}, queue: codePrs(n) });
      const l = logs();
      expect(await go(g, l)).toEqual({ action: "enqueued", pr: 301 });
      expect(enqueues(g)).toHaveLength(1);
      expect(l.out.join("\n")).toContain(
        `at the front of the merge queue (position 1, jump: true), ahead of ${n} code PRs`,
      );
      // No auto-merge: nothing waits for the queue to drain.
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("jumps, pinned to the head CI tested and the PR's node id", async () => {
    const g = fake({ pr: { id: "PR_kwDOabc" } });
    await go(g);
    const [m] = enqueues(g);
    expect(m?.id).toBe("PR_kwDOabc");
    expect(m?.oid).toBe(SHA);
    expect(m?.query).toContain("enqueuePullRequest(input:");
    expect(m?.query).toContain("jump: true");
    expect(m?.query).toContain("expectedHeadOid: $oid");
  });

  it("asks for the PR's node id, draft and fork state with the release PR", async () => {
    const g = fake({ pr: {} });
    await go(g);
    const q = g.calls.find((c) => String(c[4]).startsWith("query=query")) ?? [];
    expect(q.join(" ")).toMatch(/nodes \{\s+id\s+number/);
    expect(q.join(" ")).toContain("isDraft");
    expect(q.join(" ")).toContain("isCrossRepository");
    expect(q.join(" ")).toContain(`head=${RELEASE_BRANCH}`);
  });

  it("enqueues with a write runner when given one, and reads with the other", async () => {
    const g = fake({ pr: {} });
    const writes: string[][] = [];
    const writeExec: Exec = (cmd, args) => {
      writes.push(args);
      return g.exec(cmd, args);
    };
    await arm({ exec: g.exec, writeExec, repo: REPO, log: logs().log });
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[3])).toMatch(/^query=mutation/);
  });

  it("#3240: a head release-please pushed after CI tested the old one is never queued", async () => {
    // CI passed on SHA; release-please force-pushed NEW_SHA before the
    // enqueue. The fresh read right before it sees the move.
    const g = fake({ pr: {}, headNow: NEW_SHA });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "untested", pr: 301 });
    expect(enqueues(g)).toEqual([]);
    expect(l.out.join("\n")).toContain(
      `head moved to ${NEW_SHA} after CI tested ${SHA}`,
    );
    const reads = g.calls.map((c) => c.join(" "));
    const fresh = reads.findIndex((c) => c.includes(`repos/${REPO}/pulls/301`));
    const planned = reads.findIndex((c) => c.includes("query=query"));
    expect(fresh).toBeGreaterThan(planned);
  });
});

describe("arm: CI is looked up by head SHA on every event (the Prover's #3249 replay)", () => {
  // #3249: release 0.253.1, tag v0.253.0, its CI green. A later event in the
  // one-slot concurrency queue (an unrelated CI completion, a dispatch) can
  // replace its CI event; whatever event runs must still queue it.
  const f3249: Fixture = {
    pr: { number: 3249, title: "chore(main): release 0.253.1" },
    versions: { main: "0.253.0", head: "0.253.1" },
    files: {
      manifest: JSON.stringify({ ".": "0.253.1" }),
      changelog: "# Changelog\n\n## [0.253.1](https://x) (2026-11-26)\n",
    },
    tags: ["v0.252.0", "v0.253.0"],
  };

  it("any event queues a green head: the planner reads its required checks, not the event", async () => {
    const g = fake(f3249);
    expect(await go(g)).toEqual({ action: "enqueued", pr: 3249 });
    const list = g.calls
      .map((c) => c.join(" "))
      .find((c) => c.includes("/check-runs?"));
    expect(list).toContain(
      `repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100`,
    );
    // No run listing: the job has no actions: read.
    expect(g.calls.some((c) => c.join(" ").includes("/actions/"))).toBe(false);
  });

  it("the floor is main's seven required checks, all jobs of ci.yml", () => {
    // The ruleset's five plus branch protection's no-test-hooks and
    // authz-matrix, as main listed them on 2026-11-26.
    expect(REQUIRED_CHECKS).toEqual([
      "lint",
      "typecheck",
      "test",
      "build",
      "e2e",
      "no-test-hooks",
      "authz-matrix",
    ]);
    const ci = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
      "utf8",
    );
    for (const j of REQUIRED_CHECKS)
      expect(ci, j).toMatch(new RegExp(`^  ${j}:$`, "m"));
  });

  it("each of the seven, when missing on the head, blocks the enqueue", async () => {
    for (const name of REQUIRED_CHECKS) {
      const g = fake({
        ...f3249,
        checks: REQUIRED_CHECKS.filter((n) => n !== name).map((n) => check(n)),
      });
      const l = logs();
      expect(await go(g, l), name).toEqual({ action: "untested", pr: 3249 });
      expect(l.out.join("\n"), name).toContain(`${name} has not reported`);
      expect(enqueues(g), name).toEqual([]);
    }
  });

  it("the floor holds when main's live rules list fewer checks", async () => {
    // Rules and protection list only the ruleset's five: authz-matrix and
    // no-test-hooks are still required.
    const five = ["lint", "typecheck", "test", "build", "e2e"];
    const g = fake({
      ...f3249,
      protection: five.map((context) => ({ context, app_id: 15368 })),
      checks: five.map((n) => check(n)),
    });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "untested", pr: 3249 });
    expect(l.out.join("\n")).toContain("no-test-hooks has not reported");
    expect(l.out.join("\n")).toContain("authz-matrix has not reported");
    const none = fake({
      ...f3249,
      rules: [],
      protection: [],
      checks: five.map((n) => check(n)),
    });
    expect((await go(none)).action).toBe("untested");
  });

  it("a check main's rules or protection add later is required too, from its own app", async () => {
    const extra = [
      ...REQUIRED_CHECKS.map((context) => ({ context, app_id: 15368 })),
      { context: "public-only", app_id: 15368 },
    ];
    const g = fake({ ...f3249, protection: extra });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "untested", pr: 3249 });
    expect(l.out.join("\n")).toContain("public-only has not reported");
    const ok = fake({
      ...f3249,
      protection: extra,
      checks: [...allGreen(), check("public-only")],
    });
    expect((await go(ok)).action).toBe("enqueued");
    // A rule naming another app needs that app's check, not Actions'.
    const other = fake({
      ...f3249,
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "scan", integration_id: 777 }],
          },
        },
      ],
      checks: [...allGreen(), check("scan")],
    });
    const lo = logs();
    expect(await go(other, lo)).toEqual({ action: "untested", pr: 3249 });
    expect(lo.out.join("\n")).toContain("scan has not reported");
    const otherOk = fake({
      ...f3249,
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "scan", integration_id: 777 }],
          },
        },
      ],
      checks: [...allGreen(), check("scan", { app: 777 })],
    });
    expect((await go(otherOk)).action).toBe("enqueued");
  });

  it("fails closed when main's rules or protection can't be read", async () => {
    for (const f of [{ rules: null }, { protection: null }] as Fixture[]) {
      const g = fake({ ...f3249, ...f });
      await expect(go(g), JSON.stringify(f)).rejects.toThrow(/HTTP 403/);
      expect(enqueues(g)).toEqual([]);
      await expect(
        planStep({ exec: fake({ ...f3249, ...f }).exec, repo: REPO }),
      ).rejects.toThrow(/HTTP 403/);
    }
  });

  it("the newest run of each check decides: a newer red rerun blocks an older green one", async () => {
    const rest = REQUIRED_CHECKS.filter((n) => n !== "e2e").map((n) =>
      check(n),
    );
    const g = fake({
      ...f3249,
      checks: [
        ...rest,
        check("e2e", { id: 1, started_at: hoursAgo(2) }),
        check("e2e", { id: 2, conclusion: "failure", started_at: hoursAgo(1) }),
      ],
    });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "untested", pr: 3249 });
    expect(l.out.join("\n")).toContain("CI has not passed (e2e is failure)");
    // A newer green rerun after a red one queues it.
    const g2 = fake({
      ...f3249,
      checks: [
        ...rest,
        check("e2e", { id: 2, conclusion: "failure", started_at: hoursAgo(1) }),
        check("e2e", { id: 4, started_at: hoursAgo(0.2) }),
      ],
    });
    expect((await go(g2)).action).toBe("enqueued");
  });

  it("the Prover's case: an older green e2e and a newer queued rerun with no start time make zero enqueues", async () => {
    const rest = REQUIRED_CHECKS.filter((n) => n !== "e2e").map((n) =>
      check(n),
    );
    const green = check("e2e", { id: 100, started_at: hoursAgo(1) });
    const queued = check("e2e", {
      id: 200,
      status: "queued",
      conclusion: null,
      started_at: null,
    });
    for (const checks of [
      [...rest, green, queued],
      // Order in the reply never matters.
      [...rest, queued, green],
      // A running rerun with a lower id than a later green one still holds.
      [
        ...rest,
        check("e2e", { id: 50, status: "in_progress", conclusion: null }),
        green,
      ],
    ]) {
      const g = fake({ ...f3249, checks });
      const l = logs();
      expect(await go(g, l)).toEqual({ action: "untested", pr: 3249 });
      expect(enqueues(g)).toEqual([]);
      expect(l.out.join("\n")).toMatch(/e2e is (queued|in_progress)/);
    }
    // Once that rerun succeeds, the same head proceeds.
    const done = fake({
      ...f3249,
      checks: [
        ...rest,
        green,
        { ...queued, status: "completed", conclusion: "success" },
      ],
    });
    expect(await go(done)).toEqual({ action: "enqueued", pr: 3249 });
    expect(enqueues(done)[0]?.oid).toBe(SHA);
  });

  it("the newest completed run is picked by check-run id, not start time", async () => {
    const rest = REQUIRED_CHECKS.filter((n) => n !== "e2e").map((n) =>
      check(n),
    );
    // The red run has the higher id but an earlier (skewed) start time.
    const g = fake({
      ...f3249,
      checks: [
        ...rest,
        check("e2e", {
          id: 300,
          conclusion: "failure",
          started_at: hoursAgo(5),
        }),
        check("e2e", { id: 200, started_at: hoursAgo(0.1) }),
      ],
    });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "untested", pr: 3249 });
    expect(l.out.join("\n")).toContain("e2e is failure");
  });

  it("a required check missing, pending, red, from another app or on another SHA is untested", async () => {
    const without = (name: string, ...extra: Partial<CheckRow>[]) => [
      ...REQUIRED_CHECKS.filter((n) => n !== name).map((n) => check(n)),
      ...extra,
    ];
    for (const [checks, want] of [
      [[], "lint has not reported"],
      [without("e2e"), "e2e has not reported"],
      [
        without(
          "test",
          check("test", { status: "in_progress", conclusion: null }),
        ),
        "test is in_progress",
      ],
      [
        without("build", check("build", { conclusion: "cancelled" })),
        "build is cancelled",
      ],
      [
        without("build", check("build", { conclusion: "skipped" })),
        "build is skipped",
      ],
      // Another app posting a check named "lint" proves nothing.
      [without("lint", check("lint", { app: 999 })), "lint has not reported"],
      [
        without("lint", check("lint", { head_sha: NEW_SHA })),
        "lint has not reported",
      ],
    ] as const) {
      const g = fake({ ...f3249, checks: [...checks] });
      const l = logs();
      expect((await go(g, l)).action, want).toBe("untested");
      expect(l.out.join("\n"), want).toContain(want);
      expect(enqueues(g)).toEqual([]);
    }
  });

  it("never queues a draft release PR (#3243 was put in draft), nor a fork's", async () => {
    for (const pr of [{ draft: true }, { fork: true }]) {
      const g = fake({ pr });
      expect((await go(g)).action).toBe("draft");
      expect(enqueues(g)).toEqual([]);
      expect(await willWrite({ exec: fake({ pr }).exec, repo: REPO })).toBe(
        false,
      );
    }
  });
});

describe("arm: only a consistent, increasing release version is queued", () => {
  it("#3243: refuses 0.246.1 when tag v0.253.0 exists, and says why", async () => {
    const f: Fixture = {
      pr: { number: 3243, title: "chore(main): release 0.246.1" },
      versions: { main: "0.252.1", head: "0.246.1" },
      files: {
        manifest: JSON.stringify({ ".": "0.246.1" }),
        changelog: "# Changelog\n\n## [0.246.1](https://x) (2026-11-26)\n",
      },
      tags: ["v0.246.1", "v0.252.0", "v0.253.0", "v0.99.0"],
    };
    const g = fake(f);
    await expect(go(g)).rejects.toThrow(
      "release PR #3243 not queued: version 0.246.1 is not above the latest tag v0.253.0",
    );
    expect(enqueues(g)).toEqual([]);
    const p = await planStep({ exec: fake(f).exec, repo: REPO });
    expect(p.write).toBe(false);
    expect(p.refused).toEqual([
      "version 0.246.1 is not above the latest tag v0.253.0",
      "version 0.246.1 is not above main's .release-please-manifest.json (0.252.1)",
      "version 0.246.1 is not above main's package.json (0.252.1)",
    ]);
  });

  it("the Prover's control: main unreadable, or main already at 0.253.2, refuses 0.253.1", async () => {
    const base: Fixture = {
      pr: { title: "chore(main): release 0.253.1" },
      versions: { main: "0.253.0", head: "0.253.1" },
      files: {
        manifest: JSON.stringify({ ".": "0.253.1" }),
        changelog: "## [0.253.1](x)\n",
      },
      tags: ["v0.253.0"],
    };
    for (const [main, want] of [
      [{ pkg: null }, "no version readable from main's package.json"],
      [
        { manifest: null },
        "no version readable from main's .release-please-manifest.json",
      ],
      [
        { pkg: "0.253.2" },
        "version 0.253.1 is not above main's package.json (0.253.2)",
      ],
      [
        { manifest: "0.253.2" },
        "version 0.253.1 is not above main's .release-please-manifest.json (0.253.2)",
      ],
      [
        // Equal on main's package.json reads as landed (#2379); equal on
        // its manifest alone refuses.
        { manifest: "0.253.1" },
        "version 0.253.1 is not above main's .release-please-manifest.json (0.253.1)",
      ],
    ] as const) {
      const g = fake({ ...base, main });
      await expect(go(g), JSON.stringify(main)).rejects.toThrow(want);
      expect(enqueues(g)).toEqual([]);
    }
    // The same release with main readable and behind it is queued.
    expect((await go(fake(base))).action).toBe("enqueued");
  });

  it("refuses a title that disagrees with the files (#3240's head: 0.253.0 title, 0.252.1 files)", async () => {
    const g = fake({
      pr: { title: "chore(main): release 0.253.0" },
      versions: { main: "0.252.0", head: "0.252.1" },
      files: {
        manifest: JSON.stringify({ ".": "0.252.1" }),
        changelog: "# Changelog\n\n## [0.252.1](https://x) (2026-11-26)\n",
      },
      tags: ["v0.252.0"],
    });
    await expect(go(g)).rejects.toThrow(
      "versions disagree: title 0.253.0, .release-please-manifest.json 0.252.1, package.json 0.252.1, CHANGELOG.md 0.252.1",
    );
    expect(enqueues(g)).toEqual([]);
  });

  it("refuses when any one file disagrees, or cannot be read", async () => {
    for (const [files, versions, want] of [
      [
        { manifest: JSON.stringify({ ".": "0.5.9" }) },
        undefined,
        "versions disagree",
      ],
      [
        { changelog: "# Changelog\n\n## [0.6.1](x)\n" },
        undefined,
        "versions disagree",
      ],
      [{}, { main: "0.5.0", head: "0.6.1" }, "versions disagree"],
      [
        { manifest: "not json" },
        undefined,
        "no version readable from .release-please-manifest.json",
      ],
      [
        { changelog: "# Changelog\n" },
        undefined,
        "no version readable from CHANGELOG.md",
      ],
    ] as const) {
      const g = fake({ pr: {}, files, versions });
      await expect(go(g), JSON.stringify(files)).rejects.toThrow(want);
      expect(enqueues(g)).toEqual([]);
    }
    const untitled = fake({ pr: { title: "chore(main): release" } });
    await expect(go(untitled)).rejects.toThrow(
      "no version readable from title",
    );
  });

  it("compares versions as numbers, not text, and refuses an equal one", async () => {
    // 0.10.0 is above 0.9.9; text order would say otherwise.
    const g = fake({
      pr: { title: "chore(main): release 0.10.0" },
      versions: { main: "0.9.9", head: "0.10.0" },
      files: {
        manifest: JSON.stringify({ ".": "0.10.0" }),
        changelog: "## [0.10.0](x)\n",
      },
      tags: ["v0.9.9", "v0.9.10-rc.1"],
    });
    expect((await go(g)).action).toBe("enqueued");
    const same = fake({ pr: {}, tags: ["v0.6.0"] });
    await expect(go(same)).rejects.toThrow(
      "version 0.6.0 is not above the latest tag v0.6.0",
    );
    const none = fake({ pr: {}, tags: [] });
    await expect(go(none)).rejects.toThrow("no vX.Y.Z tag readable");
  });
});

describe("arm: only position 1 is success", () => {
  it("the Prover's control: position 3 with jump: true fails, naming the position", async () => {
    const g = fake({
      pr: {},
      queue: codePrs(2),
      enqueue: { position: 3, jump: true },
    });
    const l = logs();
    await expect(go(g, l)).rejects.toThrow(
      "release PR #301 was queued at position 3 (jump: true), not at the front",
    );
    expect(l.out.join("\n")).not.toContain("at the front of the merge queue");
  });

  it("any position but 1 fails, jumped or not", async () => {
    for (const enqueue of [
      { position: 2, jump: true },
      { position: 3, jump: false },
      { position: 0, jump: true },
    ]) {
      const g = fake({ pr: {}, enqueue });
      await expect(go(g), JSON.stringify(enqueue)).rejects.toThrow(
        `queued at position ${enqueue.position}`,
      );
    }
    expect(
      (await go(fake({ pr: {}, enqueue: { position: 1, jump: false } })))
        .action,
    ).toBe("enqueued");
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
    await expect(go(none)).rejects.toThrow(/no queue entry/);
  });
});

describe("arm: what it leaves alone", () => {
  it("does nothing when there is no release PR", async () => {
    const g = fake({});
    expect(await go(g)).toEqual({ action: "none" });
    expect(enqueues(g)).toEqual([]);
  });

  it("never queues a release PR that already landed while GitHub still reads it open (#2379)", async () => {
    const g = fake({
      pr: { number: 2376, state: "SUCCESS" },
      versions: { main: "0.168.0", head: "0.168.0" },
    });
    const l = logs();
    expect(await go(g, l)).toEqual({ action: "landed", pr: 2376 });
    expect(enqueues(g)).toEqual([]);
    expect(l.out.join("\n")).toContain("already landed");
    expect(await willWrite({ exec: g.exec, repo: REPO })).toBe(false);
  });

  it("does not queue a PR whose rollup is not SUCCESS", async () => {
    for (const state of ["PENDING", "FAILURE", "ERROR", "EXPECTED"]) {
      const g = fake({ pr: { state }, queue: codePrs(1) });
      const l = logs();
      expect((await go(g, l)).action).toBe("not-green");
      expect(l.out.join("\n")).toContain(state);
      expect(enqueues(g)).toEqual([]);
    }
  });

  it("leaves a release PR that is already in the queue alone", async () => {
    const g = fake({ pr: { queued: true }, queue: codePrs(3) });
    expect((await go(g)).action).toBe("already");
    expect(enqueues(g)).toEqual([]);
  });

  it("a queue that doesn't exist (null) is no reason to wait", async () => {
    const g = fake({ pr: {}, queue: null });
    expect((await go(g)).action).toBe("enqueued");
  });

  it("willWrite says whether the run would queue the PR, whatever the queue holds", async () => {
    const ww = (f: Fixture) => willWrite({ exec: fake(f).exec, repo: REPO });
    expect(await ww({})).toBe(false);
    expect(await ww({ pr: {} })).toBe(true);
    expect(await ww({ pr: {}, queue: codePrs(4) })).toBe(true);
    expect(await ww({ pr: {}, checks: [] })).toBe(false);
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
