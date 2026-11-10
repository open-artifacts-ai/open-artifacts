import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: exec }));

import {
  ancestorChain,
  ProcStartUnknownError,
  procStartOf,
} from "../src/session.ts";

const timeout = () =>
  Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });

describe("ps timeouts", () => {
  beforeEach(() => exec.mockReset());

  it("procStartOf throws unknown on a timeout, null on a plain failure", () => {
    exec.mockImplementationOnce(() => {
      throw timeout();
    });
    expect(() => procStartOf(5)).toThrow(ProcStartUnknownError);
    exec.mockImplementationOnce(() => {
      throw new Error("exit 1");
    });
    expect(procStartOf(5)).toBeNull();
  });

  it("ancestorChain returns the shorter chain when ps times out", () => {
    exec
      .mockImplementationOnce(() => "40\n")
      .mockImplementationOnce(() => {
        throw timeout();
      });
    expect(ancestorChain(50)).toEqual([50, 40]);
  });
});
