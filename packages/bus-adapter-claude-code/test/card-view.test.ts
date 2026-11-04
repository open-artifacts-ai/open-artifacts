// AC5c: roles and status, as list_agents, self and send_message show them.
import type { DaemonClient, DaemonFrame } from "@oa/bus-ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool } from "../src/tools.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Frame = { type: string } & Record<string, unknown>;

function daemon(answer: (f: Frame) => Record<string, unknown>) {
  const frames: Frame[] = [];
  const request = vi.fn(async (f: Frame) => {
    frames.push(f);
    return { v: 1, id: "1", ...answer(f) } as DaemonFrame;
  });
  return { frames, client: { request } as unknown as DaemonClient };
}

const row = (r: Record<string, unknown>) => ({
  name: "code-96",
  namespace: "default",
  kind: "claude-code",
  live: true,
  state: "live",
  global: false,
  machine_label: "mbp",
  ...r,
});

const list = async (rows: Record<string, unknown>[]) => {
  const d = daemon(() => ({ type: "roster", agents: rows.map(row) }));
  const out = await callTool("list_agents", {}, d.client);
  return out.content[0]?.text;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("list_agents (AC5c)", () => {
  it("shows a role holder as role → name", async () => {
    expect(await list([{ role: "lane-6" }])).toBe(
      "- lane-6 → code-96 (claude-code, default, mbp)",
    );
  });

  it("shows a status with its label after the name, as the agent's own report", async () => {
    expect(
      await list([
        {
          status: "working",
          status_label: "writing tests",
          status_at: minsAgo(1),
        },
      ]),
    ).toBe(
      '- code-96 (claude-code, default, mbp)  agent says: working · "writing tests"',
    );
  });

  it("shows a status without a label", async () => {
    expect(await list([{ status: "idle", status_at: minsAgo(0) }])).toBe(
      "- code-96 (claude-code, default, mbp)  agent says: idle",
    );
  });

  it("says how old a stale status is", async () => {
    expect(
      await list([
        {
          role: "lane-6",
          status: "working",
          status_label: "writing tests",
          status_at: minsAgo(120),
        },
        { name: "b", status: "blocked", status_at: minsAgo(12) },
      ]),
    ).toBe(
      [
        '- lane-6 → code-96 (claude-code, default, mbp)  agent says: working · "writing tests" · 2 h ago',
        "- b (claude-code, default, mbp)  agent says: blocked · 12 min ago",
      ].join("\n"),
    );
  });

  it("strips controls and invisibles from a hostile role and label, and caps them", async () => {
    const out = await list([
      {
        role: "\x1b]52;c;aGk=\x07lane\u202e-6\x1b[8m",
        status: "working\x1b[2J",
        status_label: `\x1b[31mred\u200b "x"\n${"y".repeat(100)}`,
      },
    ]);
    expect(out).toBe(
      `- lane-6 → code-96 (claude-code, default, mbp)  agent says: working · "red 'x' ${"y".repeat(56)}"`,
    );
  });

  it("below the gate, rows carry nothing new and nothing new shows", async () => {
    expect(await list([{}, { name: "b", state: "queued" }])).toBe(
      [
        "- code-96 (claude-code, default, mbp)",
        "- b (claude-code, default, mbp) (queued)",
      ].join("\n"),
    );
  });
});

describe("self (AC5c)", () => {
  const agent = (r: Record<string, unknown>) => ({
    name: "code-96",
    namespace: "default",
    kind: "claude-code",
    live: true,
    global: false,
    ...r,
  });

  it("asks for its own card fields and names the role it holds", async () => {
    const d = daemon(() => ({
      type: "agent",
      agent: agent({
        role: "lane-6",
        status: "working",
        status_at: minsAgo(1),
      }),
    }));
    const out = (await callTool("self", {}, d.client)).content[0]?.text;
    expect(d.frames[0]).toMatchObject({ type: "self", card: true });
    expect(out).toContain('"role": "lane-6"');
    expect(out).toMatch(
      /\n\nYou hold the role lane-6: the user pointed it at you, so messages sent to lane-6 reach you\.$/,
    );
  });

  it("without a role (or below the gate), is the entry alone", async () => {
    const d = daemon(() => ({ type: "agent", agent: agent({}) }));
    const out = (await callTool("self", {}, d.client)).content[0]?.text;
    expect(out).toBe(JSON.stringify(agent({}), null, 2));
  });

  it("cleans a hostile role and label", async () => {
    const d = daemon(() => ({
      type: "agent",
      agent: agent({
        role: "lane\u202e-6\x1b]0;x\x07",
        status: "idle",
        status_label: "a\u2066b\x1b[31m",
      }),
    }));
    const out = (await callTool("self", {}, d.client)).content[0]?.text ?? "";
    for (const c of ["\u202e", "\u2066", "\x1b", "\x07"])
      expect(out).not.toContain(c);
    expect(out).toContain('"role": "lane-6"');
    expect(out).toContain('"status_label": "ab"');
  });
});

describe("send_message receipts (AC5c)", () => {
  it("names the holder, then the role, with to_name", async () => {
    const d = daemon(() => ({
      type: "receipt",
      msg_id: "m",
      state: "delivered",
      to_name: "code-96",
    }));
    const out = await callTool(
      "send_message",
      { to: "lane-6", text: "hi" },
      d.client,
    );
    expect(out.content[0]?.text).toBe("✓  Delivered to code-96 (lane-6).");
  });

  it("a to_name equal to the target shows once", async () => {
    const d = daemon(() => ({
      type: "receipt",
      msg_id: "m",
      state: "pending",
      to_name: "code-96",
    }));
    const out = await callTool(
      "send_message",
      { to: "code-96", text: "hi" },
      d.client,
    );
    expect(out.content[0]?.text).toMatch(/^○ {2}Queued for code-96\. /);
  });

  it("role_vacant is refused with its copy", async () => {
    const d = daemon(() => ({
      type: "receipt",
      msg_id: "m",
      state: "refused",
      reason: "role_vacant",
    }));
    const out = await callTool(
      "send_message",
      { to: "lane-6", text: "hi" },
      d.client,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe(
      [
        '×  Refused (role_vacant): your message to lane-6, "hi",',
        "   was not delivered.",
        "   No one holds lane-6 right now.",
        "   Ask the user to point it at an agent, or message an agent by name.",
      ].join("\n"),
    );
  });
});
