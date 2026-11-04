// AC5a: AgentCard on its own, with a fake hub link and clock.
import type { ClientFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { AgentCard } from "../src/card.ts";
import type { Timer } from "../src/sent.ts";

/** A clock that fires only when told. */
function manual() {
  let due: (() => void)[] = [];
  const after: Timer = (_ms, fn) => {
    due.push(fn);
    return () => {
      due = due.filter((f) => f !== fn);
    };
  };
  const tick = () => {
    const now = due;
    due = [];
    for (const f of now) f();
  };
  return { after, tick };
}

describe("AgentCard status (AC5a)", () => {
  it("a status the queue refuses at push, link open, goes again when the window ends", () => {
    const { after, tick } = manual();
    const sent: ClientFrame[] = [];
    let accept = false;
    const card = new AgentCard({
      send: (f) => {
        if (!accept) return false;
        sent.push(f);
        return true;
      },
      cancel: () => {},
      open: () => true,
      after,
    });
    const replies: unknown[] = [];
    card.status("A", "blocked", "x", (f) => replies.push(f));
    expect(replies).toEqual([{ type: "status_set" }]);
    expect(sent).toHaveLength(0);
    accept = true;
    tick();
    expect(sent).toMatchObject([
      { type: "status", from_ref: "A", state: "blocked", label: "x" },
    ]);
    // Not owed: the next call carries no earlier refusal.
    tick();
    card.status("A", "idle", undefined, (f) => replies.push(f));
    expect(replies.at(-1)).toEqual({ type: "status_set" });
  });

  it("a newer status in the window replaces the refused one", () => {
    const { after, tick } = manual();
    const sent: ClientFrame[] = [];
    let accept = false;
    const card = new AgentCard({
      send: (f) => {
        if (accept) sent.push(f);
        return accept;
      },
      cancel: () => {},
      open: () => true,
      after,
    });
    card.status("A", "blocked", undefined, () => {});
    card.status("A", "working", undefined, () => {});
    accept = true;
    tick();
    expect(sent).toMatchObject([{ type: "status", state: "working" }]);
  });

  it("refused with the link closed, it is owed: told on the next call", () => {
    const { after } = manual();
    const card = new AgentCard({
      send: () => false,
      cancel: () => {},
      open: () => false,
      after,
    });
    card.status("A", "blocked", undefined, () => {});
    const replies: unknown[] = [];
    card.status("A", "idle", undefined, (f) => replies.push(f));
    expect(replies[0]).toMatchObject({
      type: "status_set",
      earlier: { code: "hub_unavailable" },
    });
  });
});
