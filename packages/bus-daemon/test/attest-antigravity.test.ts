import { describe, expect, it } from "vitest";
import { attest, procStartOf } from "../src/attest.ts";
import { hello } from "./helpers.ts";

const agy = (proc_start?: string, pid = process.pid) =>
  hello({
    kind: "antigravity",
    agent_ref: "conv-1",
    pid,
    attest: proc_start === undefined ? {} : { proc_start },
  });
const AGY = "/Users/u/.local/bin/agy";

describe("antigravity attestation", () => {
  it("admits an agy process whose start time matches", () => {
    expect(attest(agy("a"), { comm: () => AGY, procStart: () => "a" })).toEqual(
      { ok: true },
    );
    expect(
      attest(agy("a"), { comm: () => "agy", procStart: () => "a" }),
    ).toEqual({ ok: true });
  });

  it("requires a proc_start", () => {
    expect(attest(agy(), { comm: () => AGY, procStart: () => "a" })).toEqual({
      ok: false,
      reason: "antigravity hello has no proc_start",
    });
  });

  it("refuses a pid that does not run agy, or cannot be told", () => {
    for (const comm of ["node", "/usr/bin/agy-helper", "gemini", null])
      expect(
        attest(agy("a"), { comm: () => comm, procStart: () => "a" }),
      ).toEqual({ ok: false, reason: "antigravity pid does not run agy" });
  });

  it("refuses a gone process and a reused pid", () => {
    expect(
      attest(agy("a"), { comm: () => AGY, procStart: () => null }),
    ).toEqual({ ok: false, reason: "antigravity process is not running" });
    expect(attest(agy("a"), { comm: () => AGY, procStart: () => "b" })).toEqual(
      { ok: false, reason: "antigravity process start time moved" },
    );
  });

  it("reads the real process name by default, so this test process is refused", () => {
    const mine = procStartOf(process.pid) as string;
    expect(attest(agy(mine))).toEqual({
      ok: false,
      reason: "antigravity pid does not run agy",
    });
  });
});
