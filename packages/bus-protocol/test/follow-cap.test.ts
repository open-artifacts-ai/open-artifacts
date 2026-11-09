// The "follow" capability: follow, unfollow and following frames and their
// replies (#1317).
import { describe, expect, it } from "vitest";
import { BUS_CAPS } from "../src/caps.ts";
import {
  decodeClientFrame,
  decodeServerFrame,
  MAX_FOLLOWS,
} from "../src/protocol.ts";

const client = (f: unknown) => decodeClientFrame(JSON.stringify(f)).ok;
const server = (f: unknown) => decodeServerFrame(JSON.stringify(f)).ok;
const entry = (i = 0) => ({
  artifact_id: `art${i}`,
  url: `https://x.test/a/art${i}`,
  followed_at: "2026-11-09T10:00:00.000Z",
});

describe("follow capability", () => {
  it("is the token follow", () => expect(BUS_CAPS.follow).toBe("follow"));

  it("the three client frames name the agent by ref and carry no address", () => {
    const base = { v: 1, id: "f", from_ref: "s1" };
    expect(client({ ...base, type: "follow", artifact: "abc" })).toBe(true);
    expect(client({ ...base, type: "unfollow", artifact: "abc" })).toBe(true);
    expect(client({ ...base, type: "following" })).toBe(true);
    // Strict: an address, a member or a stray key is refused, never ignored.
    for (const extra of [
      { name: "x" },
      { namespace: "ns" },
      { user_id: "u" },
      { to: "x" },
    ]) {
      expect(
        client({ ...base, type: "follow", artifact: "abc", ...extra }),
      ).toBe(false);
      expect(client({ ...base, type: "following", ...extra })).toBe(false);
    }
  });

  it("an artifact is 1 to 2048 well-formed characters, and from_ref is required", () => {
    const base = { v: 1, id: "f", from_ref: "s1", type: "follow" };
    expect(client({ ...base, artifact: "" })).toBe(false);
    expect(client({ ...base, artifact: "x".repeat(2049) })).toBe(false);
    expect(client({ ...base, artifact: "x".repeat(2048) })).toBe(true);
    expect(client({ ...base, artifact: "\ud800" })).toBe(false);
    expect(client({ ...base, artifact: undefined })).toBe(false);
    expect(client({ v: 1, id: "f", type: "follow", artifact: "abc" })).toBe(
      false,
    );
  });

  it("the replies decode, and only as server frames", () => {
    const followed = { v: 1, id: "f", type: "followed", ...entry() };
    const unfollowed = { v: 1, id: "f", type: "unfollowed", removed: true };
    const follows = { v: 1, id: "f", type: "follows", follows: [entry()] };
    for (const f of [followed, unfollowed, follows]) {
      expect(server(f)).toBe(true);
      expect(client(f)).toBe(false);
    }
    expect(server({ ...followed, followed_at: "yesterday" })).toBe(false);
    expect(server({ ...unfollowed, removed: "yes" })).toBe(false);
    expect(server({ ...followed, extra: 1 })).toBe(false);
  });

  it("follows lists at most MAX_FOLLOWS (200), and a full list fits the decoder", () => {
    expect(MAX_FOLLOWS).toBe(200);
    const list = (n: number) => ({
      v: 1,
      id: "f",
      type: "follows",
      follows: Array.from({ length: n }, (_, i) => entry(i)),
    });
    expect(server(list(MAX_FOLLOWS))).toBe(true);
    expect(server(list(MAX_FOLLOWS + 1))).toBe(false);
  });

  it("follow_limit is an error code", () => {
    const err = (code: string) => ({
      v: 1,
      id: "f",
      type: "error",
      code,
      message: "m",
    });
    expect(server(err("follow_limit"))).toBe(true);
    expect(server(err("not_found"))).toBe(true);
    expect(server(err("follow_full"))).toBe(false);
  });
});
