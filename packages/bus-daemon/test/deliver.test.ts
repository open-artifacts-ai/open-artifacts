import type { DeliverFrame } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentTable } from "../src/agents.ts";
import { createDeliver } from "../src/deliver.ts";

const frame = (msg_id: string): DeliverFrame => ({
  v: 1,
  id: `d-${msg_id}`,
  type: "deliver",
  msg_id,
  to_ref: "A",
  from_name: "peer",
  namespace: "ns",
  body: "hi",
});

describe("createDeliver", () => {
  it("logs, never leaks, a rejection from the settle handler", async () => {
    const agents = new AgentTable();
    agents.up({
      ref: "A",
      kind: "pi",
      proposedName: "a",
      busName: "a",
      namespace: "ns",
      global: false,
      pid: 1,
      cwd: "/",
      live: true,
    });
    const leaked = vi.fn();
    process.on("unhandledRejection", leaked);
    let finish!: () => void;
    const log = vi.fn();
    const d = createDeliver({
      agents,
      hub: {
        send: () => {
          throw new Error("socket gone");
        },
      },
      transports: {
        pi: () =>
          new Promise((r) => {
            finish = () => r({ ok: true });
          }),
      },
      onClosed: () => {},
      log,
    });
    try {
      const first = d.deliver(frame("mmmmmmmmmmmmmmm1"));
      const joined = d.deliver(frame("mmmmmmmmmmmmmmm1"));
      finish();
      await expect(first).resolves.toBeUndefined();
      await expect(joined).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(leaked).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/socket gone/));
    } finally {
      process.off("unhandledRejection", leaked);
    }
  });
});

describe("peer bodies never carry terminal controls", () => {
  const evil = "hi \x1b]52;c;cHduZWQ=\x07 \x1b[8mrm -rf ~\x1b[0m \x9b2J\x07";
  it.each(["claude-code", "opencode", "pi"] as const)(
    "%s's transport gets the body and sender name stripped",
    async (kind) => {
      const agents = new AgentTable();
      agents.up({
        ref: "A",
        kind,
        proposedName: "a",
        busName: "a",
        namespace: "ns",
        global: false,
        pid: 1,
        cwd: "/",
        live: true,
      });
      const fn = vi.fn(async () => ({ ok: true }) as const);
      const d = createDeliver({
        agents,
        hub: { send: () => true },
        transports: { [kind]: fn },
        onClosed: () => {},
      });
      await d.deliver({
        ...frame("mmmmmmmmmmmmmmm1"),
        from_name: "pe\x1b[8mer",
        body: evil,
      });
      expect(fn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ from_name: "peer", body: "hi  rm -rf ~ " }),
      );
    },
  );
});
