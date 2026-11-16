// The shapes a hosted install and the platform share for pulling bounce and
// complaint events (#2650). Both repos run this.
import { describe, expect, it } from "vitest";
import {
  EMAIL_EVENTS_PULL_MAX,
  EMAIL_EVENTS_PULL_PATH,
  EmailEventsPullBodySchema,
  EmailEventsPullResponseSchema,
} from "../src/index.js";

const NONCE = "abcdefghijklmnop_-0123";

describe("email events pull contract", () => {
  it("the fixed path", () => {
    expect(EMAIL_EVENTS_PULL_PATH).toBe("/email-events/pull");
  });

  it("the request is exactly { ts, nonce }, in any order", () => {
    const ok = { ts: 1_794_000_000_000, nonce: NONCE };
    expect(EmailEventsPullBodySchema.parse(ok)).toEqual(ok);
    expect(
      EmailEventsPullBodySchema.parse({ nonce: NONCE, ts: ok.ts }),
    ).toEqual(ok);
    for (const bad of [
      { ...ok, install: "iabc123456789" },
      { ...ok, since: 1 },
      { nonce: NONCE },
      { ts: ok.ts },
      { ...ok, ts: "1" },
      { ...ok, nonce: "short" },
      { ...ok, nonce: `${"a".repeat(16)}!` },
    ])
      expect(
        EmailEventsPullBodySchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("the answer: { events: [{ messageId, kind, bounceType? }] }", () => {
    const ok = {
      events: [
        { messageId: "m1", kind: "bounced", bounceType: "hard" },
        { messageId: "m2", kind: "complained" },
        { messageId: "m3", kind: "bounced", bounceType: null },
      ],
    };
    expect(EmailEventsPullResponseSchema.parse(ok)).toEqual(ok);
    expect(EmailEventsPullResponseSchema.parse({ events: [] })).toEqual({
      events: [],
    });
    for (const bad of [
      {},
      { events: "x" },
      { events: [{ kind: "bounced" }] },
      { events: [{ messageId: "", kind: "bounced" }] },
      { events: [{ messageId: "m", kind: "" }] },
      { events: [{ messageId: "m", kind: "bounced", recipient: "a@b.co" }] },
      { events: [], cursor: "x" },
      {
        events: Array.from({ length: EMAIL_EVENTS_PULL_MAX + 1 }, (_, i) => ({
          messageId: `m${i}`,
          kind: "bounced",
        })),
      },
    ])
      expect(
        EmailEventsPullResponseSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});
