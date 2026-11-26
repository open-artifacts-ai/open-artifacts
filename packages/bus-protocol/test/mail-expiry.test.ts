// deliver.expires_at (BUS_CAPS.mailExpiry): hub-computed receipt expiry.
import { describe, expect, it } from "vitest";
import { BUS_CAPS } from "../src/caps.ts";
import { decodeServerFrame } from "../src/protocol.ts";

const MID = "7Yb3kQmZ1xRt9PvA";
const decode = (over: Record<string, unknown>) =>
  decodeServerFrame(
    JSON.stringify({
      v: 1,
      id: "d",
      type: "deliver",
      msg_id: MID,
      to_ref: "s1",
      from_name: "alice",
      namespace: "ns",
      body: "hi",
      ...over,
    }),
  );

describe("mail_expiry", () => {
  it("is the token mail_expiry", () =>
    expect(BUS_CAPS.mailExpiry).toBe("mail_expiry"));

  it("decodes deliver with and without expires_at", () => {
    const iso = "2026-12-03T10:00:00.000Z";
    const withExpiry = decode({ expires_at: iso });
    expect(withExpiry.ok).toBe(true);
    if (withExpiry.ok && withExpiry.frame.type === "deliver") {
      expect(withExpiry.frame.expires_at).toBe(iso);
    }
    const withoutExpiry = decode({});
    expect(withoutExpiry.ok).toBe(true);
    if (withoutExpiry.ok && withoutExpiry.frame.type === "deliver") {
      expect(withoutExpiry.frame.expires_at).toBeUndefined();
    }
  });

  it("refuses a malformed expires_at", () => {
    for (const bad of [
      "tomorrow",
      "2026-13-45T99:00:00Z",
      "2026-12-03T10:00:00",
      "",
      12345,
      null,
    ]) {
      expect(decode({ expires_at: bad }).ok, String(bad)).toBe(false);
    }
  });
});
