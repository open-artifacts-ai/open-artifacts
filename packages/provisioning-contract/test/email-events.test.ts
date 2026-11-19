// The shapes a hosted install and the platform share for pulling bounce and
// complaint events (#2650). Both repos run this.
import { describe, expect, it } from "vitest";
import {
  EMAIL_EVENTS_ACK_MAX,
  EMAIL_EVENTS_ACK_PATH,
  EMAIL_EVENTS_PULL_MAX,
  EMAIL_EVENTS_PULL_PATH,
  EmailEventsAckBodySchema,
  EmailEventsAckResponseSchema,
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

  it("the answer: { events: [{ eventId, messageId, kind, bounceType }] }", () => {
    const ok = {
      events: [
        { eventId: "e1", messageId: "m1", kind: "bounced", bounceType: "hard" },
        {
          eventId: "e2",
          messageId: "m2",
          kind: "complained",
          bounceType: null,
        },
        { eventId: "e3", messageId: "m3", kind: "bounced", bounceType: "soft" },
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
      { events: [{ messageId: "m", kind: "bounced" }] },
      { events: [{ eventId: "e", messageId: "", kind: "bounced" }] },
      { events: [{ eventId: "", messageId: "m", kind: "bounced" }] },
      {
        events: [{ eventId: "e", messageId: "m", kind: "", bounceType: null }],
      },
      {
        events: [
          { eventId: "e", messageId: "m", kind: "failed", bounceType: "hard" },
        ],
      },
      { events: [{ eventId: "e", messageId: "m", kind: "bounced" }] },
      {
        events: [
          {
            eventId: "e",
            messageId: "m",
            kind: "bounced",
            bounceType: "permanent",
          },
        ],
      },
      {
        events: [
          { eventId: "e", messageId: "m", kind: "bounced", bounceType: "HARD" },
        ],
      },
      {
        events: [
          {
            eventId: "e",
            messageId: "m",
            kind: "bounced",
            bounceType: "hard",
            recipient: "a@b.co",
          },
        ],
      },
      { events: [], cursor: "x" },
      {
        events: Array.from({ length: EMAIL_EVENTS_PULL_MAX + 1 }, (_, i) => ({
          eventId: `e${i}`,
          messageId: `m${i}`,
          kind: "bounced",
          bounceType: "hard",
        })),
      },
    ])
      expect(
        EmailEventsPullResponseSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("ack: { ts, nonce, eventIds } of 1 to 100, answered { acked }", () => {
    expect(EMAIL_EVENTS_ACK_PATH).toBe("/email-events/ack");
    const ok = { ts: 1_794_000_000_000, nonce: NONCE, eventIds: ["e1", "e2"] };
    expect(EmailEventsAckBodySchema.parse(ok)).toEqual(ok);
    const full = Array.from(
      { length: EMAIL_EVENTS_ACK_MAX },
      (_, i) => `e${i}`,
    );
    expect(
      EmailEventsAckBodySchema.parse({ ...ok, eventIds: full }).eventIds,
    ).toHaveLength(100);
    for (const bad of [
      { ...ok, eventIds: [] },
      { ...ok, eventIds: [...full, "one-more"] },
      { ...ok, eventIds: [""] },
      { ...ok, eventIds: "e1" },
      { ts: ok.ts, nonce: NONCE },
      { ...ok, install: "iabc123456789" },
      { ...ok, nonce: "short" },
    ])
      expect(
        EmailEventsAckBodySchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    expect(EmailEventsAckResponseSchema.parse({ acked: 2 })).toEqual({
      acked: 2,
    });
    for (const bad of [
      {},
      { acked: -1 },
      { acked: 1.5 },
      { acked: 1, more: 1 },
    ])
      expect(EmailEventsAckResponseSchema.safeParse(bad).success).toBe(false);
  });
});
