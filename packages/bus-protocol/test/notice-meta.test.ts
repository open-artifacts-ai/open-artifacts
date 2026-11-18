// #2768: deliver.meta, a server notice's structured fields.
import { describe, expect, it } from "vitest";
import { BUS_CAPS } from "../src/caps.ts";
import { decodeServerFrame } from "../src/protocol.ts";

const MID = "7Yb3kQmZ1xRt9PvA";
const deliver = (over: Record<string, unknown>) =>
  decodeServerFrame(
    JSON.stringify({
      v: 1,
      id: "d",
      type: "deliver",
      msg_id: MID,
      to_ref: "s1",
      from_name: "open-artifacts",
      namespace: "ns",
      body: "hi",
      ...over,
    }),
  ).ok;
const meta = {
  kind: "ask_later",
  user_id: "u_1",
  until: "2026-11-20T09:00:00Z",
};

describe("notice_meta", () => {
  it("is the token notice_meta", () =>
    expect(BUS_CAPS.noticeMeta).toBe("notice_meta"));

  it("accepts meta from the reserved sender", () => {
    expect(deliver({ meta })).toBe(true);
    expect(deliver({ meta: { kind: "shared", artifact_id: "art1" } })).toBe(
      true,
    );
    expect(deliver({})).toBe(true);
  });

  it("refuses meta from any other sender", () => {
    expect(deliver({ from_name: "alice", meta })).toBe(false);
  });

  it("refuses a bad until, kind, id or an unknown key", () => {
    expect(deliver({ meta: { ...meta, until: "tomorrow" } })).toBe(false);
    expect(deliver({ meta: { ...meta, until: "2026-13-45T99:00:00Z" } })).toBe(
      false,
    );
    expect(deliver({ meta: { ...meta, kind: "Ask Later" } })).toBe(false);
    expect(deliver({ meta: { ...meta, user_id: "a b" } })).toBe(false);
    expect(deliver({ meta: { ...meta, user_id: "x".repeat(129) } })).toBe(
      false,
    );
    expect(deliver({ meta: { ...meta, extra: "x" } })).toBe(false);
    expect(deliver({ meta: {} })).toBe(false);
  });
});
