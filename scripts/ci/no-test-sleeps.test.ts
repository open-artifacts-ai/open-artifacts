import { describe, expect, it } from "vitest";
import {
  allowedGrowth,
  check,
  grown,
  type Hit,
  isTest,
  scanText,
} from "./no-test-sleeps.ts";

const found = (text: string) => scanText(text).map((h) => h.why);

describe("no-test-sleeps", () => {
  it("catches each bare wait idiom", () => {
    expect(
      found(
        [
          "await new Promise((r) => setTimeout(r, 50));",
          "await new Promise((resolve) => setTimeout(resolve, 1));",
          "await sleep(10);",
          "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
          "await page.waitForTimeout(200);",
          "await new Promise((done) => setTimeout(done, 5));",
        ].join("\n"),
      ),
    ).toEqual([
      "setTimeout promise",
      "setTimeout promise",
      "sleep",
      "sleep",
      "waitForTimeout",
      "setTimeout promise",
    ]);
  });

  it("leaves a signal wait, a fake clock and a comment alone", () => {
    expect(
      found(
        [
          "await waitFor(() => expect(x).toBe(1));",
          "vi.useFakeTimers({ toFake: ['Date'] });",
          "// never await new Promise((r) => setTimeout(r, 1));",
          "await vi.advanceTimersByTimeAsync(1000);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("takes a reason on the line or the one above", () => {
    expect(
      found(
        [
          "await sleep(5); // sleep-ok: the daemon has no ready event yet",
          "// sleep-ok: the socket close has no other signal",
          "await sleep(5);",
          "await sleep(5); // sleep-ok: short",
        ].join("\n"),
      ),
    ).toEqual(["sleep"]); // the last one: "short" is not a reason
  });

  it("sees a generic type argument on the Promise", () => {
    expect(found("await new Promise<void>((r) => setTimeout(r, 5));")).toEqual([
      "setTimeout promise",
    ]);
  });

  it("the baseline may only shrink", () => {
    expect(
      grown(
        { "a.test.ts": 3, "b.test.ts": 1 },
        { "a.test.ts": 3, "b.test.ts": 1 },
      ),
    ).toEqual([]);
    expect(grown({ "a.test.ts": 4 }, { "a.test.ts": 3 })).toEqual([
      { file: "a.test.ts", message: "a.test.ts: 4, was 3 on the base branch" },
    ]);
    expect(grown({ "new.test.ts": 1 }, {})).toEqual([
      {
        file: "new.test.ts",
        message:
          "new.test.ts: 1 added (not in the baseline on the base branch)",
      },
    ]);
    // Lowering is the point, and never a failure.
    expect(grown({ "a.test.ts": 1 }, { "a.test.ts": 9 })).toEqual([]);
  });

  it("allows growth only in a file the change does not touch, and only when the rule changed", () => {
    const grew = [{ file: "a.test.ts", message: "a.test.ts: 4, was 3" }];
    // A rule that finds more waits, in a file nobody edited: allowed.
    expect(
      allowedGrowth(grew, { ruleChanged: true, untouched: () => true }),
    ).toEqual({ allowed: ["a.test.ts: 4, was 3"], denied: [] });
    // The same file edited in this change: a sleep added by the PR, refused.
    expect(
      allowedGrowth(grew, { ruleChanged: true, untouched: () => false }),
    ).toEqual({ allowed: [], denied: ["a.test.ts: 4, was 3"] });
    // No rule change: any growth is a hand edit of the list.
    expect(
      allowedGrowth(grew, { ruleChanged: false, untouched: () => true }),
    ).toEqual({ allowed: [], denied: ["a.test.ts: 4, was 3"] });
  });

  it("knows which files are tests", () => {
    expect(isTest("apps/dashboard/test/a.tsx")).toBe(true);
    expect(isTest("apps/dashboard/e2e/a.spec.ts")).toBe(true);
    expect(isTest("packages/shared/test/a.test.ts")).toBe(true);
    expect(isTest("apps/dashboard/src/a.tsx")).toBe(false);
  });

  it("fails a new wait and a baseline that no longer matches", () => {
    const hits: Hit[] = [
      { file: "a.test.ts", line: 1, why: "sleep", text: "await sleep(1);" },
      { file: "a.test.ts", line: 2, why: "sleep", text: "await sleep(1);" },
      { file: "b.test.ts", line: 1, why: "sleep", text: "await sleep(1);" },
    ];
    const newOne = check(hits, { "a.test.ts": 1 });
    expect(newOne.added).toHaveLength(3);
    expect(newOne.stale).toEqual([]);
    const gone = check(hits, { "c.test.ts": 1 });
    expect(gone.stale).toEqual(["c.test.ts: 1 gone (baseline says 1)"]);
    expect(check(hits, { "a.test.ts": 2, "b.test.ts": 1 })).toEqual({
      added: [],
      stale: [],
    });
  });
});
