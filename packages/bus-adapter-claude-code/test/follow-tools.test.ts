// follow, unfollow and following in the shared MCP tools (Claude Code, OpenCode, Codex), #1317.
import {
  type DaemonClient,
  type DaemonFrame,
  FOLLOW_DAEMON_BAD_FRAME,
  FOLLOW_OLD_DAEMON,
  followingText,
  followText,
  unfollowText,
} from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import { callTool, TOOLS } from "../src/tools.ts";

type Frame = { type: string } & Record<string, unknown>;

function daemon(answer: (f: Frame) => Record<string, unknown>) {
  const frames: Frame[] = [];
  const request = vi.fn(async (f: Frame) => {
    frames.push(f);
    return { v: 1, id: "1", ...answer(f) } as DaemonFrame;
  });
  return { frames, client: { request } as unknown as DaemonClient };
}

const URL_A = "https://x.test/a/abc";
const entry = {
  artifact_id: "abc",
  url: URL_A,
  followed_at: "2026-11-09T10:00:00.000Z",
};
const call = (
  name: string,
  args: Record<string, unknown>,
  d: ReturnType<typeof daemon>,
) => callTool(name, args, d.client);

describe("follow tools: shape", () => {
  it("are plain and short, and take an artifact id or link", () => {
    for (const n of ["follow", "unfollow"]) {
      const t = TOOLS.find((x) => x.name === n);
      expect(t?.inputSchema).toEqual({
        type: "object",
        properties: { artifact: { type: "string" } },
        required: ["artifact"],
        additionalProperties: false,
      });
      expect(t?.description.length).toBeLessThan(100);
      expect(t?.description).not.toMatch(/claude/i);
    }
    expect(TOOLS.find((x) => x.name === "following")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("follow tools: requests", () => {
  it("follow sends the artifact only (never an address) and says what the agent gets", async () => {
    const d = daemon(() => ({ type: "followed", ...entry }));
    const r = await call(
      "follow",
      { artifact: ` ${URL_A} `, name: "other", namespace: "ns", from: "x" },
      d,
    );
    expect(d.frames).toEqual([{ type: "follow", artifact: URL_A, late: true }]);
    expect(r).toEqual({
      content: [{ type: "text", text: followText(URL_A) }],
    });
  });

  it("unfollow says whether it was followed", async () => {
    for (const removed of [true, false]) {
      const d = daemon(() => ({ type: "unfollowed", removed }));
      const r = await call("unfollow", { artifact: "abc" }, d);
      expect(d.frames[0]).toMatchObject({ type: "unfollow", artifact: "abc" });
      expect(r.content[0]?.text).toBe(unfollowText(removed, "abc"));
      expect(r.isError).toBeUndefined();
    }
  });

  it("following lists links, or says there are none", async () => {
    const some = daemon(() => ({ type: "follows", follows: [entry] }));
    expect((await call("following", {}, some)).content[0]?.text).toBe(
      followingText([entry]),
    );
    const none = daemon(() => ({ type: "follows", follows: [] }));
    expect((await call("following", {}, none)).content[0]?.text).toBe(
      "You are not following any artifacts.",
    );
  });

  it("an empty artifact is refused before any request", async () => {
    const d = daemon(() => ({ type: "followed", ...entry }));
    for (const name of ["follow", "unfollow"]) {
      const r = await call(name, { artifact: "  " }, d);
      expect(r.isError).toBe(true);
    }
    expect(d.frames).toEqual([]);
  });
});

describe("follow tools: refusals", () => {
  it("shows the hub's own copy for not_found and follow_limit", async () => {
    for (const message of [
      "Not found",
      "At most 200 follows per member; unfollow one first",
    ]) {
      const d = daemon(() => ({ type: "error", code: "x", message }));
      const r = await call("follow", { artifact: "abc" }, d);
      expect(r).toEqual({
        content: [{ type: "text", text: `oa-bus: ${message}` }],
        isError: true,
      });
    }
  });

  it("the daemon's own bad_frame refusals are shown as they are, not as an old daemon (#1766)", async () => {
    for (const message of Object.values(FOLLOW_DAEMON_BAD_FRAME)) {
      const d = daemon(() => ({ type: "error", code: "bad_frame", message }));
      expect(await call("follow", { artifact: "abc" }, d)).toEqual({
        content: [{ type: "text", text: `oa-bus: ${message}` }],
        isError: true,
      });
    }
  });

  it("a daemon too old for the frames (bad_frame) says to update", async () => {
    const d = daemon(() => ({
      type: "error",
      code: "bad_frame",
      message: "Invalid input",
    }));
    for (const [name, args] of [
      ["follow", { artifact: "abc" }],
      ["unfollow", { artifact: "abc" }],
      ["following", {}],
    ] as const) {
      const r = await call(name, args, d);
      expect(r).toEqual({
        content: [{ type: "text", text: FOLLOW_OLD_DAEMON }],
        isError: true,
      });
    }
  });
});
