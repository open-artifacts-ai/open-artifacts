// propose_reach and reach_proposed (#1346).
import { describe, expect, it } from "vitest";
import {
  ADAPTER_CAPS,
  AdapterFrame,
  DaemonFrame,
  REACH_PROPOSAL_MAX,
  reachNamespacesOf,
} from "../src/index.ts";

const ns = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
const frame = (namespaces: unknown) => ({
  v: 1,
  id: "1",
  type: "propose_reach",
  namespaces,
});

describe("propose_reach frame", () => {
  it("has its own cap, no hub cap, and a 1 to 10 limit", () => {
    expect(ADAPTER_CAPS.reach).toBe("reach");
    expect(REACH_PROPOSAL_MAX).toBe(10);
    expect(AdapterFrame.safeParse(frame(ns(1))).success).toBe(true);
    expect(AdapterFrame.safeParse(frame(ns(10))).success).toBe(true);
    for (const bad of [[], ns(11), ["A"], [""], ["a b"], "a", undefined])
      expect(AdapterFrame.safeParse(frame(bad)).success).toBe(false);
  });

  it("drops a session the caller names: the daemon takes it from the connection", () => {
    const r = AdapterFrame.parse({
      ...frame(["a"]),
      nativeRef: "other",
      from_ref: "other",
    });
    expect(r).not.toHaveProperty("nativeRef");
    expect(r).not.toHaveProperty("from_ref");
  });

  it("reach_proposed is a daemon reply", () => {
    expect(
      DaemonFrame.safeParse({
        v: 1,
        id: "1",
        type: "reach_proposed",
        confirm_url: "https://x.test/bus/reach/confirm#a",
        expires_at: "2026-11-09T11:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("reachNamespacesOf", () => {
  it("trims, drops duplicates and refuses 0, 11 and non-canonical", () => {
    expect(reachNamespacesOf([" a ", "a", "b/c"])).toEqual({
      namespaces: ["a", "b/c"],
    });
    for (const bad of [[], ns(11), ["A"], [""], [3], "a", undefined])
      expect(reachNamespacesOf(bad)).toHaveProperty("error");
    expect(reachNamespacesOf(ns(10))).toHaveProperty("namespaces");
  });
});
