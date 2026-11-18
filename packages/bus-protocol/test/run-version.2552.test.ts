import { describe, expect, it } from "vitest";
import {
  BUS_CAPS,
  CLIENT_FRAMES,
  ClientFrameSchema,
  MAX_CAPS,
  SERVER_FRAMES,
  ServerFrameSchema,
  UPDATE_REASONS,
} from "../src/index.ts";

const ok = {
  v: 1,
  id: "r1",
  type: "update_report",
  event: "stepped_back",
  from: "1.0.0",
  to: "1.1.0",
  reason: "hub_unreachable",
  rescue_version: 1,
  at: "2026-11-15T12:00:00.000Z",
};
const hello = {
  v: 1,
  id: "h",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.3",
};

describe("run_version cap (#2552)", () => {
  it("is one token, within MAX_CAPS of the other caps", () => {
    expect(BUS_CAPS.runVersion).toBe("run_version");
    expect(Object.values(BUS_CAPS)).toHaveLength(15);
    expect(Object.values(BUS_CAPS).length).toBeLessThanOrEqual(MAX_CAPS);
  });
  it("hello_ok.run_version is strict x.y.z, at most 32 chars", () => {
    for (const v of ["1.2.3", "0.0.0", "10.20.30"])
      expect(
        ServerFrameSchema.safeParse({ ...hello, run_version: v }).success,
      ).toBe(true);
    for (const v of [
      "1.2",
      "1.2.3-x",
      "01.2.3",
      "1.2.3 ",
      "v1.2.3",
      "1.2.3+b",
      "١.٢.٣",
      `1.2.${"9".repeat(40)}`,
      "",
    ])
      expect(
        ServerFrameSchema.safeParse({ ...hello, run_version: v }).success,
        v,
      ).toBe(false);
    expect(ServerFrameSchema.safeParse(hello).success).toBe(true);
  });
  it("the push, install_now and update_ack decode strictly", () => {
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "p",
        type: "run_version",
        run_version: "1.2.3",
      }).success,
    ).toBe(true);
    expect(
      ServerFrameSchema.safeParse({ v: 1, id: "p", type: "run_version" })
        .success,
    ).toBe(false);
    expect(
      ServerFrameSchema.safeParse({ v: 1, id: "i", type: "install_now" })
        .success,
    ).toBe(true);
    // No field at all: no version, no URL, no source.
    for (const extra of [
      { version: "1.2.3" },
      { url: "https://x.test" },
      { run_version: "1.2.3" },
    ])
      expect(
        ServerFrameSchema.safeParse({
          v: 1,
          id: "i",
          type: "install_now",
          ...extra,
        }).success,
      ).toBe(false);
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "a",
        type: "update_ack",
        ok: true,
      }).success,
    ).toBe(true);
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "a",
        type: "update_ack",
        ok: true,
        why: "x",
      }).success,
    ).toBe(false);
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        id: "a",
        type: "update_ack",
        ok: "yes",
      }).success,
    ).toBe(false);
  });
  it("update_report: closed reasons, versions, capped detail, strict keys", () => {
    expect(ClientFrameSchema.safeParse(ok).success).toBe(true);
    expect(
      ClientFrameSchema.safeParse({ ...ok, detail: "x".repeat(200) }).success,
    ).toBe(true);
    expect(
      ClientFrameSchema.safeParse({ ...ok, detail: "x".repeat(201) }).success,
    ).toBe(false);
    expect(ClientFrameSchema.safeParse({ ...ok, to: "" }).success).toBe(true);
    for (const bad of [
      { reason: "because" },
      { event: "gone" },
      { to: "1.1" },
      { from: "latest" },
      { rescue_version: -1 },
      { rescue_version: 1.5 },
      { at: "yesterday" },
      { extra: 1 },
    ])
      expect(ClientFrameSchema.safeParse({ ...ok, ...bad }).success).toBe(
        false,
      );
    for (const e of [
      "updated",
      "refused",
      "stepped_back",
      "needs_you",
      "held",
      "switching",
    ])
      expect(ClientFrameSchema.safeParse({ ...ok, event: e }).success).toBe(
        true,
      );
    expect(UPDATE_REASONS).toContain("other");
  });
  it("frames flow one way each", () => {
    expect(CLIENT_FRAMES).toContain("update_report");
    expect(SERVER_FRAMES).toEqual(
      expect.arrayContaining(["run_version", "install_now", "update_ack"]),
    );
    expect(ServerFrameSchema.safeParse(ok).success).toBe(false);
    expect(
      ClientFrameSchema.safeParse({ v: 1, id: "i", type: "install_now" })
        .success,
    ).toBe(false);
  });
});
