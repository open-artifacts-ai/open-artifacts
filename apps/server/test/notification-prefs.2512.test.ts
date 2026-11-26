// #2512 S4: the member's notification choices and quiet hours.
import { env } from "cloudflare:workers";
import { type NotificationPrefs, newId, R } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import {
  awayUntil,
  DEFAULT_PREFS,
  PREFS_WRITES_PER_DAY,
  quietState,
} from "../src/services/notification-prefs.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

const mk = (p: string, role: "member" | "guest" = "member") =>
  login(`${p}-${tag}@x.com`, role);
const put = (cookie: string, body: unknown) =>
  api(app, R.meNotificationPrefs, cookie, { method: "PUT", body });
const mine = (userId: string) =>
  E.DB.prepare(
    "select detail, target_id, action from audit_events where actor_id = ? and action = 'settings.change' order by at",
  )
    .bind(userId)
    .all<{ detail: string; target_id: string; action: string }>();
const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_PREFS,
  ...over,
});

describe("GET and PUT /me/notification-prefs", () => {
  it("no row is the defaults; a save is read back; the audit row names what changed", async () => {
    const a = await mk("a");
    const g = await api(app, R.meNotificationPrefs, a.cookie);
    expect(g.status).toBe(200);
    expect(await g.json()).toEqual(DEFAULT_PREFS);
    const next = prefs({
      interrupt: "none",
      needsYou: { inApp: true, browser: false },
      updates: { inApp: true, browser: true },
      browserAllAsks: false,
      quietHours: { start: "22:00", end: "07:30" },
      timeZone: "America/Los_Angeles",
      lockScreenDetail: true,
    });
    // No device is enrolled: the account choices save all the same. Updates are
    // list-only (#3024): their browser setting is never saved, so it reads off.
    const r = await put(a.cookie, next);
    expect(r.status).toBe(200);
    const saved = { ...next, updates: { inApp: true, browser: false } };
    expect(await r.json()).toEqual(saved);
    expect(
      await (await api(app, R.meNotificationPrefs, a.cookie)).json(),
    ).toEqual(saved);
    const rows = (await mine(a.userId)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_id).toBe(a.userId);
    const changes = JSON.parse(rows[0]?.detail ?? "{}").notificationPrefs;
    expect(Object.keys(changes).sort()).toEqual([
      "browser",
      "browserAllAsks",
      "interrupt",
      "lockScreenDetail",
      "quietHours",
      "timeZone",
    ]);
    expect(
      (
        await E.DB.prepare(
          "select count(*) as n from push_subscriptions where user_id = ?",
        )
          .bind(a.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // An old row with Updates on still reads off.
    await E.DB.prepare(
      "update notification_prefs set updates_browser = 1 where user_id = ?",
    )
      .bind(a.userId)
      .run();
    expect(
      (
        (await (
          await api(app, R.meNotificationPrefs, a.cookie)
        ).json()) as NotificationPrefs
      ).updates.browser,
    ).toBe(false);
    next.updates.browser = false;
    // Turning quiet hours off clears them.
    await put(a.cookie, { ...next, quietHours: null });
    expect(
      (
        (await (
          await api(app, R.meNotificationPrefs, a.cookie)
        ).json()) as NotificationPrefs
      ).quietHours,
    ).toBeNull();
    // An unchanged save writes no audit row.
    await put(a.cookie, { ...next, quietHours: null });
    expect((await mine(a.userId)).results).toHaveLength(2);
  });

  it("round-trips interrupt and pause and accepts legacy settings writes", async () => {
    const a = await mk("interrupt");
    const pausedUntil = "2030-10-05T12:00:00.000Z";
    const legacy = {
      needsYou: { inApp: true, browser: true },
      updates: { inApp: true, browser: false },
      browserAllAsks: true,
      quietHours: null,
      timeZone: "UTC",
      lockScreenDetail: false,
    };
    expect(
      await (await api(app, R.meNotificationPrefs, a.cookie)).json(),
    ).toMatchObject({
      interrupt: "mentions",
      pausedUntil: null,
    });
    expect(
      await (
        await put(a.cookie, { ...legacy, interrupt: "everything", pausedUntil })
      ).json(),
    ).toMatchObject({
      interrupt: "everything",
      pausedUntil,
      needsYou: { browser: true },
    });
    expect(
      await (await put(a.cookie, { ...legacy, lockScreenDetail: true })).json(),
    ).toMatchObject({
      interrupt: "everything",
      pausedUntil,
    });
    expect(
      await (
        await put(a.cookie, {
          ...legacy,
          pausedUntil: null,
          needsYou: { inApp: true, browser: false },
        })
      ).json(),
    ).toMatchObject({
      interrupt: "none",
      pausedUntil: null,
      needsYou: { browser: false },
    });
    expect(await (await put(a.cookie, legacy)).json()).toMatchObject({
      interrupt: "mentions",
      needsYou: { browser: true },
    });
    expect(
      (await put(a.cookie, { ...legacy, pausedUntil: "tomorrow" })).status,
    ).toBe(400);
  });

  it("is each person's own", async () => {
    const a = await mk("own-a");
    const b = await mk("own-b");
    await put(a.cookie, prefs({ lockScreenDetail: true }));
    expect(
      (
        (await (
          await api(app, R.meNotificationPrefs, b.cookie)
        ).json()) as NotificationPrefs
      ).lockScreenDetail,
    ).toBe(false);
  });

  it("saving takes a person in a browser: a token gets 404, anonymous 401; reading is open to a token", async () => {
    const a = await mk("tok");
    const pat = (await createPat(E, a.userId, "prefs")).token;
    expect((await put(pat, prefs({ lockScreenDetail: true }))).status).toBe(
      404,
    );
    expect((await api(app, R.meNotificationPrefs, pat)).status).toBe(200);
    expect(
      (
        await app.fetch(
          new Request(`http://app.localhost${R.meNotificationPrefs}`, {
            method: "PUT",
            headers: {
              "x-oa-request": "1",
              "content-type": "application/json",
            },
            body: JSON.stringify(prefs()),
          }),
          E,
          { waitUntil() {}, passThroughOnException() {} } as never,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        (await (
          await api(app, R.meNotificationPrefs, a.cookie)
        ).json()) as NotificationPrefs
      ).lockScreenDetail,
    ).toBe(false);
  });

  it("refuses a bad time zone, empty quiet hours, a bad time and a stray key", async () => {
    const a = await mk("bad");
    for (const body of [
      prefs({ timeZone: "Mars/Olympus" }),
      prefs({ quietHours: { start: "08:00", end: "08:00" } }),
      prefs({ quietHours: { start: "8:00", end: "09:00" } }),
      prefs({ quietHours: { start: "24:00", end: "09:00" } }),
      { ...prefs(), updates: { inApp: false, browser: true } },
      {},
    ])
      expect((await put(a.cookie, body)).status, JSON.stringify(body)).toBe(
        400,
      );
  });

  it("is rate limited per person per day, counting only real changes", async () => {
    const a = await mk("rate");
    // A frozen clock: UTC midnight mid-loop would start a new day's count.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    try {
      for (let i = 0; i < PREFS_WRITES_PER_DAY; i++)
        expect(
          (await put(a.cookie, prefs({ lockScreenDetail: i % 2 === 0 })))
            .status,
        ).toBe(200);
      const r = await put(
        a.cookie,
        prefs({ lockScreenDetail: false, browserAllAsks: false }),
      );
      expect(r.status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("quiet hours", () => {
  const at = (iso: string) => Date.parse(iso);
  const q = (start: string, end: string, timeZone = "UTC") => ({
    quietHours: { start, end },
    timeZone,
  });

  it("a same-day window", () => {
    const w = q("09:00", "17:00");
    expect(quietState(w, at("2026-11-18T08:59:59Z")).quiet).toBe(false);
    expect(quietState(w, at("2026-11-18T09:00:00Z")).quiet).toBe(true);
    const mid = quietState(w, at("2026-11-18T12:30:00Z"));
    expect(mid).toEqual({ quiet: true, until: at("2026-11-18T17:00:00Z") });
    expect(quietState(w, at("2026-11-18T17:00:00Z")).quiet).toBe(false);
  });

  it("a window across midnight ends the next morning", () => {
    const w = q("22:00", "07:30");
    expect(quietState(w, at("2026-11-18T21:59:00Z")).quiet).toBe(false);
    expect(quietState(w, at("2026-11-18T23:15:10Z"))).toEqual({
      quiet: true,
      until: at("2026-11-19T07:30:00Z"),
    });
    expect(quietState(w, at("2026-11-19T03:00:00Z"))).toEqual({
      quiet: true,
      until: at("2026-11-19T07:30:00Z"),
    });
    expect(quietState(w, at("2026-11-19T07:30:00Z")).quiet).toBe(false);
  });

  it("uses the person's own time zone, daylight saving included", () => {
    const w = q("22:00", "07:00", "America/Los_Angeles");
    // 2026-11-18 is PST (UTC-8): 22:00 PST is 06:00Z the next day.
    expect(quietState(w, at("2026-11-18T05:59:00Z")).quiet).toBe(false);
    expect(quietState(w, at("2026-11-18T07:00:00Z")).quiet).toBe(true);
    // 14:30Z is 06:30 PST in November, still quiet; in July (PDT, UTC-7) it is 07:30.
    expect(quietState(w, at("2026-11-18T14:30:00Z")).quiet).toBe(true);
    expect(quietState(w, at("2026-07-18T14:30:00Z")).quiet).toBe(false);
  });

  it("none set, or an unknown zone, is never quiet", () => {
    expect(quietState({ quietHours: null, timeZone: "UTC" }, 0).quiet).toBe(
      false,
    );
    expect(
      quietState(
        { quietHours: { start: "00:00", end: "23:59" }, timeZone: "x/y" },
        0,
      ).quiet,
    ).toBe(false);
  });

  it("awayUntil is the end of the window during it, else null", async () => {
    const a = await mk("away");
    expect(await awayUntil(E, a.userId)).toBeNull();
    await put(
      a.cookie,
      prefs({ quietHours: { start: "22:00", end: "07:30" } }),
    );
    const now = Date.parse("2026-11-18T23:00:00Z");
    expect(await awayUntil(E, a.userId, now)).toBe(
      Date.parse("2026-11-19T07:30:00Z"),
    );
    expect(
      await awayUntil(E, a.userId, Date.parse("2026-11-18T12:00:00Z")),
    ).toBeNull();
  });
});
