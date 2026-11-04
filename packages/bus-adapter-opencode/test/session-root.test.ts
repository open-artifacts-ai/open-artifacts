import { describe, expect, it, vi } from "vitest";
import { type Api, rootOf, rootSession } from "../src/session.ts";

const sessions = (all: Record<string, Record<string, unknown>>): Api =>
  vi.fn(async (op: string, params: Record<string, string>) =>
    op === "session.get" ? all[params.sessionID ?? ""] : undefined,
  );

describe("opencode root sessions", () => {
  it("follows parentID to the root and caches it", async () => {
    const api = sessions({
      ses_child: { id: "ses_child", parentID: "ses_root" },
      ses_root: { id: "ses_root", directory: "/work/app" },
    });
    const cache = new Map();
    expect(await rootSession("ses_child", { api, cache })).toEqual({
      root: "ses_root",
      directory: "/work/app",
      title: null,
    });
    expect(await rootOf("ses_child", { api, cache })).toBe("ses_root");
    expect(await rootOf("ses_child", { api, cache })).toBe("ses_root");
    expect(await rootOf("ses_root", { api, cache })).toBe("ses_root");
    expect(api).toHaveBeenCalledTimes(2); // child + root, once
  });

  it("names the root's own directory, top-level or under location", async () => {
    const api = sessions({
      ses_a: { id: "ses_a", directory: "/work/a", title: "Fix login" },
      ses_b: { id: "ses_b", location: { directory: "/work/b" } },
      ses_c: { id: "ses_c", directory: "relative/c" },
    });
    const cache = new Map();
    expect(await rootSession("ses_a", { api, cache })).toEqual({
      root: "ses_a",
      directory: "/work/a",
      title: "Fix login",
    });
    expect(await rootSession("ses_b", { api, cache })).toEqual({
      root: "ses_b",
      directory: "/work/b",
      title: null,
    });
    expect(await rootSession("ses_c", { api, cache })).toEqual({
      root: "ses_c",
      directory: null,
      title: null,
    });
  });

  it("returns the id unchanged, uncached, when the server cannot answer", async () => {
    const cache = new Map();
    expect(await rootOf("ses_x", { api: async () => undefined, cache })).toBe(
      "ses_x",
    );
    const down: Api = async () => {
      throw new Error("service down");
    };
    expect(await rootSession("ses_x", { api: down, cache })).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("gives up on a parent cycle or a chain past the depth cap", async () => {
    const cache = new Map();
    const cycle = sessions({
      ses_a: { id: "ses_a", parentID: "ses_b" },
      ses_b: { id: "ses_b", parentID: "ses_a" },
    });
    expect(await rootSession("ses_a", { api: cycle, cache })).toBeNull();
    const deep: Api = async (_op, p) => ({
      id: p.sessionID,
      parentID: `${p.sessionID}x`,
    });
    expect(
      await rootSession("ses_d", { api: deep, cache, maxDepth: 5 }),
    ).toBeNull();
    expect(cache.size).toBe(0);
  });
});
