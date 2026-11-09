// propose_reach in the shared MCP tools (Claude Code, OpenCode, Codex), #1346.
import {
  type DaemonClient,
  type DaemonFrame,
  REACH_OLD_DAEMON,
  reachProposedText,
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

const URL_R = `https://x.test/bus/reach/confirm#${"A".repeat(43)}`;
const proposed = () => ({
  type: "reach_proposed",
  confirm_url: URL_R,
  expires_at: "2026-11-09T11:00:00.000Z",
});
const call = (args: Record<string, unknown>, d: ReturnType<typeof daemon>) =>
  callTool("propose_reach", args, d.client);

describe("propose_reach tool", () => {
  it("takes namespaces only: no field names a session, role or address", () => {
    const t = TOOLS.find((x) => x.name === "propose_reach");
    expect(Object.keys(t?.inputSchema.properties ?? {})).toEqual([
      "namespaces",
    ]);
    expect(t?.inputSchema.required).toEqual(["namespaces"]);
    expect(t?.inputSchema.additionalProperties).toBe(false);
    expect(t?.description).not.toMatch(/claude|—/i);
    expect(t?.description).toMatch(
      /nothing changes until the person confirms/i,
    );
  });

  it("sends the namespaces only, whatever else the caller names, and shows the link", async () => {
    const d = daemon(proposed);
    const r = await call(
      { namespaces: [" a/b ", "c"], nativeRef: "other", from_ref: "other" },
      d,
    );
    expect(r.isError).not.toBe(true);
    expect(r.content[0]?.text).toBe(
      reachProposedText(["a/b", "c"], URL_R, "2026-11-09T11:00:00.000Z"),
    );
    expect(r.content[0]?.text).toContain("Nothing has changed");
    const f = d.frames[0] as Frame;
    expect(f).toMatchObject({
      type: "propose_reach",
      namespaces: ["a/b", "c"],
    });
    expect(f).not.toHaveProperty("nativeRef");
    expect(f).not.toHaveProperty("from_ref");
  });

  it("checks 1 to 10 namespaces before sending anything", async () => {
    const d = daemon(proposed);
    for (const namespaces of [
      [],
      undefined,
      "a",
      ["A"],
      [""],
      Array.from({ length: 11 }, (_, i) => `n${i}`),
    ]) {
      const r = await call({ namespaces }, d);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^oa-bus: namespaces/);
    }
    expect(d.frames).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => `n${i}`);
    expect((await call({ namespaces: ten }, d)).isError).not.toBe(true);
  });

  it("shows the daemon's refusal as-is", async () => {
    for (const [code, message] of [
      ["no_role", "You hold no role."],
      ["ambiguous", "You hold more than one role."],
    ] as const) {
      const r = await call(
        { namespaces: ["x"] },
        daemon(() => ({ type: "error", code, message })),
      );
      expect(r).toMatchObject({
        isError: true,
        content: [{ text: `oa-bus: ${message}` }],
      });
    }
  });

  it("a daemon without the frame (bad_frame) says to update", async () => {
    const r = await call(
      { namespaces: ["x"] },
      daemon(() => ({ type: "error", code: "bad_frame", message: "Invalid" })),
    );
    expect(r).toMatchObject({
      isError: true,
      content: [{ text: REACH_OLD_DAEMON }],
    });
  });
});
