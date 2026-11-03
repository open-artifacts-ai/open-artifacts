import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InfraError } from "../src/fetch-timeout.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { NotRefused, tagLeg } from "../src/refused.ts";
import { buildReport, formatReport } from "../src/report.ts";
import {
  type Budget,
  MAX_RETRIED_CASES,
  retryableError,
  retryCase,
  runBudget,
} from "../src/retry.ts";

const leg = (e: Error, name: string) =>
  tagLeg(e, {
    leg: name as "A's credential at A",
    host: "rl-a",
    expected: "allowed",
  });
const storage = new Error(
  "rl-a seed GET /x: status 503, body sha256:ab (9 bytes), code storage_unavailable",
);
const internal = new Error(
  "rl-a seed GET /x: status 500, body sha256:ba8ffbc8ccb01eed (56 bytes), code internal",
);
const allow = "A's credential at A";
const deny = "A's credential at B";
const open: Budget = { take: () => true };

beforeEach(() => {
  setCurrentTest(() => undefined);
  takeFileNotes();
});

describe("what counts as retryable", () => {
  it("a named error on an allow leg", () => {
    expect(retryableError(leg(storage, allow))).toBe("storage_unavailable");
    expect(
      retryableError(
        leg(
          new InfraError("setup on rl-b got no response (ECONNRESET)"),
          "B's own credential at B",
        ),
      ),
    ).toBe("ECONNRESET");
  });

  it("never a deny leg, even on a named error", () => {
    expect(retryableError(leg(storage, deny))).toBeUndefined();
    expect(
      retryableError(
        leg(new InfraError("x got no response (ECONNRESET)"), deny),
      ),
    ).toBeUndefined();
  });

  it("never a non-refusal, `internal`, or an error naming no leg", () => {
    expect(retryableError(leg(new NotRefused("200"), allow))).toBeUndefined();
    expect(retryableError(leg(internal, allow))).toBeUndefined();
    expect(retryableError(storage)).toBeUndefined();
    expect(retryableError("storage_unavailable")).toBeUndefined();
  });

  it("not a body that merely says it: only the code field does", () => {
    expect(
      retryableError(
        leg(new Error("storage_unavailable was in the text"), allow),
      ),
    ).toBeUndefined();
  });
});

describe("retryCase", () => {
  const flaky = (fails: unknown[]) => {
    let n = 0;
    const calls = { n: 0 };
    return {
      calls,
      run: async () => {
        calls.n++;
        const e = fails[n++];
        if (e) throw e;
        return "ok";
      },
    };
  };

  it("once, with a note, and the second try's answer counts", async () => {
    const f = flaky([leg(storage, allow)]);
    expect(await retryCase(f.run, open)).toBe("ok");
    expect(f.calls.n).toBe(2);
    expect(takeFileNotes()).toEqual([
      "case retried once (storage_unavailable)",
    ]);
  });

  it("a second failure fails", async () => {
    const f = flaky([leg(storage, allow), new Error("still down")]);
    await expect(retryCase(f.run, open)).rejects.toThrow("still down");
    expect(f.calls.n).toBe(2);
  });

  it("a deny leg gets one try", async () => {
    const f = flaky([leg(storage, deny)]);
    await expect(retryCase(f.run, open)).rejects.toThrow();
    expect(f.calls.n).toBe(1);
  });

  it("a spent cap fails, with a note", async () => {
    const f = flaky([leg(storage, allow)]);
    await expect(retryCase(f.run, { take: () => false })).rejects.toThrow();
    expect(f.calls.n).toBe(1);
    expect(takeFileNotes()[0]).toMatch(/cap is spent/);
  });
});

describe("the run's cap", () => {
  it("holds across budgets, as separate test files have", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rl-retry-")), "n");
    for (let i = 0; i < MAX_RETRIED_CASES; i++)
      expect(runBudget(file).take()).toBe(true);
    expect(runBudget(file).take()).toBe(false);
    expect(MAX_RETRIED_CASES).toBe(5);
  });
});

describe("the report", () => {
  it("counts retried cases, and a retried pass still passes", () => {
    const r = buildReport([
      { name: "a", level: "pass", notes: ["case retried once (ECONNRESET)"] },
      { name: "b", level: "pass" },
    ]);
    expect(r.passed).toBe(true);
    expect(formatReport(r)).toContain("Cases retried: 1");
  });
});
