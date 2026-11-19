// #2793 S3b: the guest frames and the guest delivery marker.
import { describe, expect, it } from "vitest";
import {
  BUS_CAPS,
  ClientFrameSchema,
  GUEST_DELIVERY_KINDS,
  NoticeMetaSchema,
  ServerFrameSchema,
} from "../src/index.ts";

const HASH = "a".repeat(64);

describe("guest frames (#2793 S3b)", () => {
  it("guest_up carries only the ref, the kind and the name", () => {
    const ok = {
      v: 1,
      id: "g1",
      type: "guest_up",
      agent_ref: "sess-1",
      kind: "claude-code",
      proposed_name: "my session",
    };
    expect(ClientFrameSchema.safeParse(ok).success).toBe(true);
    for (const extra of ["namespace", "global", "cwd", "roles", "repo"])
      expect(ClientFrameSchema.safeParse({ ...ok, [extra]: "x" }).success).toBe(
        false,
      );
    expect(ClientFrameSchema.safeParse({ ...ok, kind: "codex" }).success).toBe(
      false,
    );
  });

  it("proof_seen is a server frame carrying only a hash", () => {
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "p1",
        type: "proof_seen",
        hash: HASH,
      }).success,
    ).toBe(true);
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "p1",
        type: "proof_seen",
        hash: "nope",
      }).success,
    ).toBe(false);
    expect(
      ClientFrameSchema.safeParse({
        v: 1,
        id: "p1",
        type: "proof_seen",
        hash: HASH,
      }).success,
    ).toBe(false);
  });

  it("a notice's meta.guest is one of the three structured kinds", () => {
    expect(GUEST_DELIVERY_KINDS).toEqual(["reply", "mention", "answer"]);
    for (const guest of GUEST_DELIVERY_KINDS)
      expect(
        NoticeMetaSchema.safeParse({ kind: "comment", guest }).success,
      ).toBe(true);
    expect(
      NoticeMetaSchema.safeParse({ kind: "comment", guest: "message" }).success,
    ).toBe(false);
    expect(BUS_CAPS.guest).toBe("guest");
  });
});
