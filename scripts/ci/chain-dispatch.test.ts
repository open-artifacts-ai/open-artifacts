// chain-dispatch.ts: the chain's deploy dispatches one run and fails closed
// unless exactly that run is found and succeeds. gh is a stub with a fake
// clock; nothing is dispatched.
import { describe, expect, it } from "vitest";
import { dispatchAndWait, type Exec, outputLine } from "./chain-dispatch.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const CHAIN = "c555-1";
const iso = (ms: number) => new Date(ms).toISOString();

type Run = Record<string, unknown>;
const run = (over: Run = {}): Run => ({
  id: 900,
  status: "in_progress",
  conclusion: null,
  event: "workflow_dispatch",
  head_branch: "main",
  actor: { login: "github-actions[bot]" },
  display_title: `deploy-hosted-platform prod v1.2.3 [${CHAIN}]`,
  created_at: iso(T0 + 2000),
  html_url: "https://github.com/o/r/actions/runs/900",
  ...over,
});

function harness(o: {
  list: () => Run[];
  poll?: (n: number) => Run;
  dispatchFails?: boolean;
  cancelFails?: boolean;
}) {
  let now = T0;
  const calls: string[][] = [];
  let polls = 0;
  const exec: Exec = (_c, a) => {
    calls.push(a);
    if (a[0] === "workflow")
      return o.dispatchFails
        ? { code: 1, stdout: "", stderr: "HTTP 403" }
        : { code: 0, stdout: "", stderr: "" };
    if (a.includes("POST"))
      return o.cancelFails
        ? { code: 1, stdout: "", stderr: "HTTP 409" }
        : { code: 0, stdout: "{}", stderr: "" };
    if (a[1]?.includes("/workflows/"))
      return {
        code: 0,
        stdout: JSON.stringify({ workflow_runs: o.list() }),
        stderr: "",
      };
    return {
      code: 0,
      stdout: JSON.stringify(
        (o.poll ?? (() => run({ status: "completed", conclusion: "success" })))(
          polls++,
        ),
      ),
      stderr: "",
    };
  };
  const go = (extra: Record<string, number> = {}) =>
    dispatchAndWait({
      exec,
      repo: "o/r",
      tag: "v1.2.3",
      chainId: CHAIN,
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
      ...extra,
    });
  return { go, calls, exec };
}

describe("chain-dispatch", () => {
  it("dispatches main's workflow with the chain's inputs, finds the one run and returns on success", () => {
    const h = harness({ list: () => [run()] });
    const r = h.go();
    expect(r).toEqual({
      runId: 900,
      url: "https://github.com/o/r/actions/runs/900",
      conclusion: "success",
    });
    const d = h.calls[0] as string[];
    expect(d.slice(0, 2)).toEqual(["workflow", "run"]);
    expect(d).toContain("deploy-hosted-platform.yml");
    expect(d[d.indexOf("--ref") + 1]).toBe("main");
    for (const f of [
      "env=prod",
      "tag=v1.2.3",
      "verify_only=false",
      "require_newer=true",
      `chain_id=${CHAIN}`,
    ])
      expect(d).toContain(f);
  });
  it("waits through in-progress polls", () => {
    const h = harness({
      list: () => [run()],
      poll: (n) =>
        n < 3 ? run() : run({ status: "completed", conclusion: "success" }),
    });
    expect(h.go().conclusion).toBe("success");
  });
  it("fails when no run appears before the find deadline", () => {
    const h = harness({ list: () => [] });
    expect(() => h.go({ findTimeoutMs: 60_000 })).toThrow(
      /no run for chain id/,
    );
  });
  it("fails when two runs match", () => {
    const h = harness({ list: () => [run(), run({ id: 901 })] });
    expect(() => h.go()).toThrow(/2 runs match/);
  });
  it("ignores a run by another actor, event, branch or chain id (so finds none)", () => {
    for (const over of [
      { actor: { login: "someone" } },
      { actor: null },
      { event: "workflow_call" },
      { head_branch: "feature" },
      { display_title: "deploy-hosted-platform prod v1.2.3 [c555-10]" },
      { display_title: "deploy-hosted-platform prod v1.2.3" },
      // The title is exact: another env or tag is not our run.
      { display_title: `deploy-hosted-platform staging v1.2.3 [${CHAIN}]` },
      { display_title: `deploy-hosted-platform prod v1.2.4 [${CHAIN}]` },
      { display_title: `x deploy-hosted-platform prod v1.2.3 [${CHAIN}]` },
      { display_title: `deploy-hosted-platform prod v1.2.3 [${CHAIN}] extra` },
    ]) {
      const h = harness({ list: () => [run(over)] });
      expect(
        () => h.go({ findTimeoutMs: 30_000 }),
        JSON.stringify(over),
      ).toThrow(/no run for chain id/);
    }
  });
  it("ignores a run created before the dispatch", () => {
    const h = harness({
      list: () => [run({ created_at: iso(T0 - 10 * 60_000) })],
    });
    expect(() => h.go({ findTimeoutMs: 30_000 })).toThrow(
      /no run for chain id/,
    );
  });
  it("fails on any conclusion but success", () => {
    for (const c of ["failure", "cancelled", "timed_out", "skipped", null]) {
      const h = harness({
        list: () => [run()],
        poll: () => run({ status: "completed", conclusion: c }),
      });
      expect(() => h.go(), String(c)).toThrow(/concluded/);
    }
  });
  it("on the wait timeout, cancels the dispatched run, then fails saying so", () => {
    const h = harness({ list: () => [run()], poll: () => run() });
    expect(() => h.go({ waitTimeoutMs: 120_000 })).toThrow(
      /did not finish.*cancelled the dispatched run https:\/\/github.com\/o\/r\/actions\/runs\/900/,
    );
    const i = h.calls.findIndex((a) => a.includes("POST"));
    expect(h.calls[i]).toEqual([
      "api",
      "-X",
      "POST",
      "repos/o/r/actions/runs/900/cancel",
    ]);
    // Then one re-read of the run, and nothing after it.
    expect(h.calls.slice(i + 1)).toEqual([
      ["api", "repos/o/r/actions/runs/900"],
    ]);
  });
  it("on the wait timeout, still fails (and says so) when the cancel is refused and the run is not green", () => {
    const h = harness({
      list: () => [run()],
      poll: () => run(),
      cancelFails: true,
    });
    expect(() => h.go({ waitTimeoutMs: 120_000 })).toThrow(
      /could not cancel the dispatched run/,
    );
  });
  it("a run that completed green at the deadline is a success and is never cancelled", () => {
    // The poll at the deadline already shows completed/success.
    const h = harness({
      list: () => [run()],
      poll: (n) =>
        n < 2 ? run() : run({ status: "completed", conclusion: "success" }),
    });
    // 10 s polls: the third poll lands past a 15 s deadline.
    expect(h.go({ waitTimeoutMs: 15_000 }).conclusion).toBe("success");
    expect(h.calls.some((a) => a.join(" ").includes("/cancel"))).toBe(false);
  });
  it("after a cancel attempt (accepted or refused 409) it re-reads once: green is a success, anything else fails", () => {
    for (const cancelFails of [false, true]) {
      // In progress until the cancel call, then completed/success.
      let cancelled = false;
      const base = harness({
        list: () => [run()],
        poll: () => run(),
        cancelFails,
      });
      const exec: Exec = (c, a) => {
        if (a.includes("POST")) cancelled = true;
        if (
          cancelled &&
          a[0] === "api" &&
          !a.includes("POST") &&
          !a[1]?.includes("/workflows/")
        )
          return {
            code: 0,
            stdout: JSON.stringify(
              run({ status: "completed", conclusion: "success" }),
            ),
            stderr: "",
          };
        return base.exec(c, a);
      };
      let now = T0;
      const r = dispatchAndWait({
        exec,
        repo: "o/r",
        tag: "v1.2.3",
        chainId: CHAIN,
        now: () => now,
        sleep: (m) => {
          now += m;
        },
        waitTimeoutMs: 120_000,
      });
      expect(r.conclusion, String(cancelFails)).toBe("success");
      expect(cancelled).toBe(true);
    }
    // Re-read shows it cancelled: fails with the note.
    const h = harness({
      list: () => [run()],
      poll: (n) => (n < 100 ? run() : run()),
    });
    expect(() => h.go({ waitTimeoutMs: 120_000 })).toThrow(
      /cancelled the dispatched run/,
    );
  });
  it("never cancels a run that completed, failed or succeeded", () => {
    for (const c of ["success", "failure"]) {
      const h = harness({
        list: () => [run()],
        poll: () => run({ status: "completed", conclusion: c }),
      });
      try {
        h.go();
      } catch {}
      expect(h.calls.some((a) => a.join(" ").includes("/cancel"))).toBe(false);
    }
  });
  it("fails when the dispatch is refused, and finds nothing", () => {
    const h = harness({ list: () => [run()], dispatchFails: true });
    expect(() => h.go()).toThrow(/gh workflow run/);
    expect(h.calls).toHaveLength(1);
  });
  it("refuses a bad tag or chain id before any call", () => {
    const h = harness({ list: () => [] });
    expect(() =>
      dispatchAndWait({
        exec: () => {
          throw new Error("called");
        },
        repo: "o/r",
        tag: "v1.2",
        chainId: CHAIN,
        now: () => T0,
        sleep: () => {},
      }),
    ).toThrow(/not a release tag/);
    expect(() =>
      dispatchAndWait({
        exec: () => {
          throw new Error("called");
        },
        repo: "o/r",
        tag: "v1.2.3",
        chainId: "a b",
        now: () => T0,
        sleep: () => {},
      }),
    ).toThrow(/bad chain id/);
    expect(h.calls).toHaveLength(0);
  });
  it("reports the run as soon as it is found, even if it later fails", () => {
    const seen: number[] = [];
    let now = T0;
    const exec: Exec = (_c, a) => ({
      code: 0,
      stdout:
        a[0] === "workflow"
          ? ""
          : a[1]?.includes("/workflows/")
            ? JSON.stringify({ workflow_runs: [run()] })
            : JSON.stringify(
                run({ status: "completed", conclusion: "failure" }),
              ),
      stderr: "",
    });
    expect(() =>
      dispatchAndWait({
        exec,
        repo: "o/r",
        tag: "v1.2.3",
        chainId: CHAIN,
        now: () => now,
        sleep: (m) => {
          now += m;
        },
        onFound: (id) => seen.push(id),
      }),
    ).toThrow(/concluded failure/);
    expect(seen).toEqual([900]);
  });
});

describe("outputLine", () => {
  it("is one line: a multi-line error cannot add a deploy_run= line", () => {
    const evil =
      "boom\ndeploy_run=999\r\ndeploy_url=http://x\u2028deploy_conclusion=success\u0000";
    const line = outputLine("deploy_note", evil);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line.includes("\u0000")).toBe(false);
    const lines = line.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("deploy_note=")).toBe(true);
    expect(lines.some((l) => l.startsWith("deploy_run="))).toBe(false);
  });
  it("caps the length", () => {
    expect(outputLine("k", "a".repeat(1000)).length).toBeLessThanOrEqual(303);
  });
});
