import { describe, expect, it } from "vitest";
import { AdapterFrame, DaemonFrame } from "../src/index.ts";

const set = (over: object) => ({
  v: 1,
  id: "s",
  type: "set_status",
  state: "working",
  ...over,
});
const ok = (f: object) => AdapterFrame.safeParse(f).success;

describe("set_status requests", () => {
  it("takes the four states and a label of up to 64 characters", () => {
    for (const state of ["working", "idle", "blocked", "waiting_on_owner"])
      expect(ok(set({ state }))).toBe(true);
    expect(ok(set({ label: "é".repeat(64) }))).toBe(true);
    expect(ok(set({ state: "done" }))).toBe(false);
    expect(ok(set({ label: "x".repeat(65) }))).toBe(false);
    // Cleaned like machine labels: no control characters.
    expect(ok(set({ label: "a\nb" }))).toBe(false);
    expect(ok(set({ label: "a\u001b[31mb" }))).toBe(false);
  });

  it("decodes the reply: status_set", () => {
    expect(DaemonFrame.parse({ v: 1, id: "s", type: "status_set" })).toEqual({
      v: 1,
      id: "s",
      type: "status_set",
    });
    const earlier = { code: "bad_frame", message: "m" };
    expect(
      DaemonFrame.parse({ v: 1, id: "s", type: "status_set", earlier }),
    ).toMatchObject({ earlier });
  });
});

describe("no agent card (design: card dropped)", () => {
  it("refuses a card request and a card reply", () => {
    expect(
      ok({
        v: 1,
        id: "c",
        type: "card",
        aud: "https://artifacts.example.com",
        nonce: "n".repeat(16),
      }),
    ).toBe(false);
    expect(
      DaemonFrame.safeParse({ v: 1, id: "c", type: "card", jwt: "a.b.c" })
        .success,
    ).toBe(false);
  });
});
