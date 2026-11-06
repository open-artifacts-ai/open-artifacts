// The "mailbox" capability: queued/since receipts, mailbox_full,
// reserved_name, away roster rows and agent_up.replaces (#1295).
import { describe, expect, it } from "vitest";
import { BUS_CAPS } from "../src/caps.ts";
import { decodeClientFrame, decodeServerFrame } from "../src/protocol.ts";

const MID = "7Yb3kQmZ1xRt9PvA";
const ok = (f: unknown) => decodeServerFrame(JSON.stringify(f)).ok;

describe("mailbox capability", () => {
  it("is the token mailbox", () => expect(BUS_CAPS.mailbox).toBe("mailbox"));

  it("a send receipt may carry queued and since", () => {
    const r = { v: 1, id: "r", type: "receipt", msg_id: MID, state: "pending" };
    expect(ok(r)).toBe(true);
    const since = "2026-11-05T10:00:00.000Z";
    expect(ok({ ...r, queued: "away", since })).toBe(true);
    expect(ok({ ...r, queued: "offline", since })).toBe(true);
    expect(ok({ ...r, queued: "gone", since })).toBe(false);
    expect(ok({ ...r, queued: "away", since: "yesterday" })).toBe(false);
  });

  it("the new refusals decode", () => {
    for (const reason of ["mailbox_full", "reserved_name"])
      expect(
        ok({
          v: 1,
          id: "r",
          type: "receipt",
          msg_id: MID,
          state: "refused",
          reason,
        }),
      ).toBe(true);
  });

  it("a roster row may be away, with since", () => {
    const row = {
      bus_name: "a",
      kind: "claude-code",
      namespace: "n",
      global: false,
    };
    const roster = (r: object) => ({
      v: 1,
      id: "l",
      type: "roster",
      agents: [r],
    });
    expect(ok(roster({ ...row, state: "live" }))).toBe(true);
    expect(
      ok(roster({ ...row, state: "away", since: "2026-11-05T10:00:00.000Z" })),
    ).toBe(true);
    expect(ok(roster({ ...row, state: "gone" }))).toBe(false);
  });

  it("agent_up may name the ref it replaces", () => {
    const up = {
      v: 1,
      id: "u",
      type: "agent_up",
      agent_ref: "s2",
      kind: "claude-code",
      proposed_name: "a",
      namespace: "n",
      global: false,
    };
    expect(decodeClientFrame(JSON.stringify(up)).ok).toBe(true);
    expect(
      decodeClientFrame(JSON.stringify({ ...up, replaces: "s1" })).ok,
    ).toBe(true);
    expect(decodeClientFrame(JSON.stringify({ ...up, replaces: "" })).ok).toBe(
      false,
    );
  });
});
