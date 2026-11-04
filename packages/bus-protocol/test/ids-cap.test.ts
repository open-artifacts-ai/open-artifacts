// The "ids" capability: reply ids and agent_gone (#1323 follow-up).
import { describe, expect, it } from "vitest";
import { BUS_CAPS } from "../src/caps.ts";
import { decodeClientFrame, decodeServerFrame } from "../src/protocol.ts";

const MID = "7Yb3kQmZ1xRt9PvA";
const AID = "8Zc4mRnA2ySu9QwB";

describe("ids capability", () => {
  it("is the token ids", () => expect(BUS_CAPS.ids).toBe("ids"));

  it("hello_ok may list the hub's caps", () => {
    const f = {
      v: 1,
      id: "h",
      type: "hello_ok",
      machine_id: MID,
      machine_label: "m",
      server_version: "1",
      caps: ["rename", "ids"],
    };
    expect(decodeServerFrame(JSON.stringify(f)).ok).toBe(true);
    const { caps: _c, ...plain } = f;
    expect(decodeServerFrame(JSON.stringify(plain)).ok).toBe(true);
  });

  it("deliver may carry from_id, an agent id", () => {
    const d = {
      v: 1,
      id: "d",
      type: "deliver",
      msg_id: MID,
      to_ref: "s1",
      from_name: "alice",
      namespace: "ns",
      body: "hi",
    };
    expect(decodeServerFrame(JSON.stringify({ ...d, from_id: AID })).ok).toBe(
      true,
    );
    expect(decodeServerFrame(JSON.stringify(d)).ok).toBe(true);
    expect(
      decodeServerFrame(JSON.stringify({ ...d, from_id: "not an id" })).ok,
    ).toBe(false);
  });

  it("send may carry to_id; agent_gone is a refusal", () => {
    const s = {
      v: 1,
      id: "s",
      type: "send",
      from_ref: "s1",
      to_name: "alice",
      body: "hi",
    };
    expect(decodeClientFrame(JSON.stringify({ ...s, to_id: AID })).ok).toBe(
      true,
    );
    expect(
      decodeServerFrame(
        JSON.stringify({
          v: 1,
          id: "s",
          type: "receipt",
          msg_id: MID,
          state: "refused",
          reason: "agent_gone",
        }),
      ).ok,
    ).toBe(true);
  });
});
