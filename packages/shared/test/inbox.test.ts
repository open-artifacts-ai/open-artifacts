import { describe, expect, it } from "vitest";
import {
  InboxMuteBodySchema,
  InboxMutesSchema,
  InboxSchema,
  NotificationPrefsSchema,
  PushPayloadSchema,
  PushSubscribeBodySchema,
} from "../src/index.js";

const item = {
  id: "i1",
  level: "needs_you",
  kind: "ask",
  urgency: "waiting",
  waitingSince: "2026-11-14T00:00:00Z",
  artifact: { id: "a1", title: "Plan" },
  actor: { kind: "agent", name: "builder", me: false },
  text: "Which one?",
  href: "/a/a1",
  createdAt: "2026-11-14T00:00:00Z",
  readAt: null,
};
const prefs = {
  needsYou: { inApp: true, browser: true },
  updates: { inApp: true, browser: false },
  browserAllAsks: false,
  quietHours: { start: "22:00", end: "07:30" },
  timeZone: "America/New_York",
  lockScreenDetail: false,
};

describe("notifications contract", () => {
  it("parses valid samples", () => {
    expect(
      InboxSchema.safeParse({
        needsYou: [item],
        later: [],
        updates: [{ ...item, level: "update", kind: "comment", actor: null }],
        cursor: null,
        counts: { needsYou: 1, unreadUpdates: 1 },
      }).success,
    ).toBe(true);
    expect(NotificationPrefsSchema.safeParse(prefs).success).toBe(true);
    expect(
      NotificationPrefsSchema.safeParse({ ...prefs, quietHours: null }).success,
    ).toBe(true);
    expect(
      PushSubscribeBodySchema.safeParse({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "BAb-_1", auth: "x-_9" },
      }).success,
    ).toBe(true);
    expect(
      PushPayloadSchema.safeParse({
        v: 1,
        title: "t",
        body: "b",
        href: "/a/a1",
        tag: "x",
      }).success,
    ).toBe(true);
  });

  it.each(["//evil", "https://x", "javascript:x"])(
    "rejects href %s",
    (href) => {
      expect(
        InboxSchema.shape.needsYou.element.safeParse({ ...item, href }).success,
      ).toBe(false);
      expect(
        PushPayloadSchema.safeParse({
          v: 1,
          title: "t",
          body: "b",
          href,
          tag: "x",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects bad quiet hours and push endpoints", () => {
    expect(
      NotificationPrefsSchema.safeParse({
        ...prefs,
        quietHours: { start: "24:00", end: "07:00" },
      }).success,
    ).toBe(false);
    expect(
      PushSubscribeBodySchema.safeParse({
        endpoint: "http://x.example/",
        keys: { p256dh: "a", auth: "b" },
      }).success,
    ).toBe(false);
  });

  it("checks href by resolution", () => {
    const el = InboxSchema.shape.needsYou.element;
    for (const href of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
    ])
      expect(el.safeParse({ ...item, href }).success).toBe(false);
    const enc = "/%09/evil.example";
    expect(new URL(enc, "https://x.invalid").origin).toBe("https://x.invalid");
    expect(el.safeParse({ ...item, href: enc }).success).toBe(true);
    expect(el.safeParse({ ...item, href: "/a/x#c" }).success).toBe(true);
  });

  it("parses machine, away, agentId and mutes", () => {
    const el = InboxSchema.shape.needsYou.element;
    expect(
      el.safeParse({
        ...item,
        kind: "machine",
        actor: { kind: "agent", name: "b", me: false },
        agentKey: "ag1",
        machine: { id: "m1", name: "laptop" },
      }).success,
    ).toBe(true);
    expect(
      el.safeParse({
        ...item,
        kind: "away",
        away: { since: "2026-11-14T00:00:00Z", count: 3, pages: 1 },
      }).success,
    ).toBe(true);
    expect(
      el.safeParse({ ...item, away: { since: "x", count: -1 } }).success,
    ).toBe(false);
    expect(
      InboxMutesSchema.safeParse({
        items: [{ kind: "agent", id: "a", name: "A" }],
      }).success,
    ).toBe(true);
    expect(
      InboxMuteBodySchema.safeParse({ kind: "page", id: "p" }).success,
    ).toBe(true);
    expect(InboxMuteBodySchema.safeParse({ kind: "x", id: "p" }).success).toBe(
      false,
    );
  });

  it("allows a null artifact only for machine and away", () => {
    const el = InboxSchema.shape.needsYou.element;
    expect(el.safeParse({ ...item, artifact: null }).success).toBe(false);
    expect(
      el.safeParse({ ...item, kind: "mention", artifact: null }).success,
    ).toBe(false);
    expect(
      el.safeParse({ ...item, kind: "machine", artifact: null }).success,
    ).toBe(true);
    expect(
      el.safeParse({ ...item, kind: "away", artifact: null }).success,
    ).toBe(true);
  });

  it("parses actor animal and away pages", () => {
    const el = InboxSchema.shape.needsYou.element;
    const actor = {
      kind: "agent",
      name: "b",
      me: false,
      for: "Leo",
      linked: true,
      product: "Claude Code",
      animal: { id: "fox", color: 2 },
    };
    expect(el.safeParse({ ...item, actor }).success).toBe(true);
    expect(
      el.safeParse({
        ...item,
        actor: { ...actor, animal: { id: "fox", color: -1 } },
      }).success,
    ).toBe(false);
    const away = { since: "2026-11-14T00:00:00Z", count: 3, pages: 2 };
    expect(el.safeParse({ ...item, kind: "away", away }).success).toBe(true);
    expect(
      el.safeParse({ ...item, kind: "away", away: { ...away, pages: -1 } })
        .success,
    ).toBe(false);
    expect(
      el.safeParse({
        ...item,
        kind: "away",
        away: { since: away.since, count: 1 },
      }).success,
    ).toBe(false);
  });
});
