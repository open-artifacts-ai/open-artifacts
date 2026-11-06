// #1295: the daemon-to-adapter IPC is gated like the hub wire. An adapter
// whose hello did not list `mailbox` (an older @oa/bus-ipc, whose decoder has
// a closed state and reason enum and would destroy its socket on a surprise)
// gets rosters without away rows and receipts with the old refusal reasons.
import type { Hello } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentTable } from "../src/agents.ts";
import { Pending, type RouteCtx, routeLocal } from "../src/routes.ts";

// Frozen copies of the decoders before #1295 (origin/main bus-ipc).
const OldRoster = z.object({
  type: z.literal("roster"),
  agents: z.array(
    z.object({
      name: z.string(),
      namespace: z.string(),
      kind: z.string(),
      live: z.boolean(),
      state: z.enum(["live", "queued"]).optional(),
      global: z.boolean(),
    }),
  ),
});
const OLD_REASONS = [
  "unknown_agent",
  "closed",
  "inbox_full",
  "too_large",
  "other_namespace",
  "revoked",
  "ambiguous",
  "role_vacant",
  "agent_gone",
  "recipient_closed",
] as const;
const OldReceipt = z.object({
  type: z.literal("receipt"),
  msg_id: z.string(),
  state: z.enum(["pending", "delivered", "expired", "refused"]),
  reason: z.enum(OLD_REASONS).optional(),
});

const hello = (caps?: string[]): Hello =>
  ({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "claude-code",
    agent_ref: "A",
    pid: 1,
    attest: {},
    ...(caps ? { caps } : {}),
  }) as unknown as Hello;

function setup() {
  const agents = new AgentTable();
  agents.up({
    ref: "A",
    kind: "claude-code",
    proposedName: "a",
    busName: "a",
    namespace: "ns",
    global: false,
    pid: 1,
    cwd: "/x",
    live: true,
  });
  const pending = new Pending();
  const sent: { id: string }[] = [];
  const ctx = {
    agents,
    pending,
    hub: {
      send: (f: { id: string }) => {
        sent.push(f);
        return true;
      },
    },
  } as unknown as RouteCtx;
  return { pending, sent, ctx };
}

async function ask(
  caps: string[] | undefined,
  req: { type: "list" } | { type: "send"; to: string; body: string },
  hubReply: (id: string) => Parameters<Pending["settle"]>[0],
) {
  const { pending, sent, ctx } = setup();
  const got: unknown[] = [];
  routeLocal(
    { v: 1, id: "1", ...req } as never,
    hello(caps),
    (f) => got.push(f),
    ctx,
  );
  pending.settle(hubReply((sent[0] as { id: string }).id));
  return got[0];
}

const rosterOf = (id: string) =>
  ({
    v: 1,
    id,
    type: "roster",
    agents: [
      {
        bus_name: "b",
        kind: "pi",
        namespace: "ns",
        global: false,
        state: "live",
      },
      {
        bus_name: "c",
        kind: "pi",
        namespace: "ns",
        global: false,
        state: "away",
        since: "2026-11-05T10:00:00.000Z",
      },
    ],
  }) as never;
const refusal = (reason: string) => (id: string) =>
  ({
    v: 1,
    id,
    type: "receipt",
    msg_id: "m",
    state: "refused",
    reason,
  }) as never;
const send = { type: "send", to: "x", body: "hi" } as const;

describe("daemon-to-adapter IPC gating (#1295)", () => {
  it("an adapter without the mailbox cap gets no away rows: its old decoder parses", async () => {
    const r = await ask(undefined, { type: "list" }, rosterOf);
    expect(OldRoster.safeParse(r).success).toBe(true);
    expect((r as { agents: unknown[] }).agents).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("since");
  });

  it.each([
    ["mailbox_full", "inbox_full"],
    ["reserved_name", "unknown_agent"],
  ])("without the cap, %s reaches the adapter as %s", async (reason, shown) => {
    const r = await ask(undefined, send, refusal(reason));
    expect(OldReceipt.safeParse(r).success).toBe(true);
    expect((r as { reason: string }).reason).toBe(shown);
  });

  it("without the cap, a pending receipt loses queued and since", async () => {
    const r = await ask(
      undefined,
      send,
      (id) =>
        ({
          v: 1,
          id,
          type: "receipt",
          msg_id: "m",
          state: "pending",
          queued: "away",
          since: "2026-11-05T10:00:00.000Z",
        }) as never,
    );
    expect(r).not.toHaveProperty("queued");
    expect(r).not.toHaveProperty("since");
  });

  it("an adapter that listed mailbox gets away rows and the new reasons as they are", async () => {
    const r = await ask(["mailbox"], { type: "list" }, rosterOf);
    expect(
      (r as { agents: { state: string }[] }).agents.map((a) => a.state),
    ).toEqual(["live", "away"]);
    const f = await ask(["mailbox"], send, refusal("mailbox_full"));
    expect((f as { reason: string }).reason).toBe("mailbox_full");
  });
});
