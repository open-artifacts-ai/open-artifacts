// "While you were away" (#2512, design v10): the quiet-hours summary row.
import { env } from "cloudflare:workers";
import {
  type Inbox,
  type Member,
  type NotificationPrefs,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { awayWindow } from "../src/services/inbox-away.js";
import { DEFAULT_PREFS } from "../src/services/notification-prefs.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const HOUR = 3_600_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const savePrefs = (u: U, over: Partial<NotificationPrefs>) =>
  api(app, R.meNotificationPrefs, u.cookie, {
    method: "PUT",
    body: { ...DEFAULT_PREFS, ...over },
  });
const inbox = async (u: U) =>
  (await (await api(app, R.meInbox, u.cookie)).json()) as Inbox;
const awayOf = async (u: U) =>
  (await inbox(u)).updates.find((i) => i.kind === "away");

/** An update row for `u` on `artifactId`, created at `at`. */
async function item(u: U, artifactId: string, at: number, readAt?: number) {
  await E.DB.prepare(
    `insert into inbox_items (id, user_id, kind, level, key, artifact_id, actor, excerpt, created_at, read_at)
     values (?, ?, 'comment', 'update', ?, ?, '{"kind":"user","ref":"x","name":"X"}', 'hi', ?, ?)`,
  )
    .bind(
      newId(),
      u.userId,
      `comment:${newId()}`,
      artifactId,
      at,
      readAt ?? null,
    )
    .run();
}

let owner: U;
beforeAll(async () => {
  owner = await mk("aw-owner");
});
async function page(readers: U[]) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of readers)
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "viewer" },
    });
  return a.id;
}

describe("awayWindow", () => {
  const noon = Date.UTC(2026, 10, 18, 12, 0);
  it("an overnight span: the last one that has ended", () => {
    const w = awayWindow({ start: "22:00", end: "07:00" }, "UTC", noon);
    expect(w).toEqual({
      start: Date.UTC(2026, 10, 17, 22),
      end: Date.UTC(2026, 10, 18, 7),
    });
    // Before today's 07:00 it is still the night before's.
    const early = Date.UTC(2026, 10, 18, 5, 0);
    expect(awayWindow({ start: "22:00", end: "07:00" }, "UTC", early)).toEqual({
      start: Date.UTC(2026, 10, 16, 22),
      end: Date.UTC(2026, 10, 17, 7),
    });
  });
  it("a span inside one day starts the same day", () => {
    expect(awayWindow({ start: "09:00", end: "10:30" }, "UTC", noon)).toEqual({
      start: Date.UTC(2026, 10, 18, 9),
      end: Date.UTC(2026, 10, 18, 10, 30),
    });
  });
  it("is on the person's clock, DST included", () => {
    // Paris in November is UTC+1: 22:00-07:00 there is 21:00-06:00 UTC.
    expect(
      awayWindow({ start: "22:00", end: "07:00" }, "Europe/Paris", noon),
    ).toEqual({
      start: Date.UTC(2026, 10, 17, 21),
      end: Date.UTC(2026, 10, 18, 6),
    });
    // In June it is UTC+2.
    const june = Date.UTC(2026, 5, 18, 12);
    expect(
      awayWindow({ start: "22:00", end: "07:00" }, "Europe/Paris", june),
    ).toEqual({
      start: Date.UTC(2026, 5, 17, 20),
      end: Date.UTC(2026, 5, 18, 5),
    });
  });
  it("no quiet hours: no window", () => {
    expect(awayWindow(null, "UTC", noon)).toBeNull();
  });
});

describe("the row", () => {
  /** Quiet hours that ended two hours ago and lasted eight, in UTC. */
  const lately = (now = Date.now()) => ({
    start: hhmm(now - 10 * HOUR),
    end: hhmm(now - 2 * HOUR),
    endAt: Math.floor((now - 2 * HOUR) / 60_000) * 60_000,
  });

  it("summarizes the unread updates of the last span, with their pages, first in Updates", async () => {
    const u = await mk("aw-row");
    const a = await page([u]);
    const b = await page([u]);
    const q = lately();
    expect(
      (await savePrefs(u, { quietHours: { start: q.start, end: q.end } }))
        .status,
    ).toBe(200);
    const inside = q.endAt - 3 * HOUR;
    await item(u, a, inside);
    await item(u, a, inside + 1000);
    await item(u, b, inside + 2000);
    // Outside the window, or already read: not counted.
    await item(u, a, q.endAt + 60_000);
    await item(u, a, inside - 20 * HOUR);
    await item(u, b, inside + 3000, Date.now());
    const inb = await inbox(u);
    const away = inb.updates[0];
    expect(away?.kind).toBe("away");
    expect(away?.level).toBe("update");
    expect(away?.artifact).toBeNull();
    expect(away?.away).toMatchObject({ count: 3, pages: 2 });
    expect(away?.id).toBe(`away:${away?.away?.since}`);
    expect(away?.readAt).toBeNull();
    // It sums up the rows; it adds no unread of its own.
    const unreadRows = inb.updates.filter(
      (i) => i.kind !== "away" && !i.readAt,
    );
    expect(inb.counts.unreadUpdates).toBe(unreadRows.length);
  });

  it("no quiet hours, or nothing unread in the window: no row", async () => {
    const u = await mk("aw-none");
    const a = await page([u]);
    await item(u, a, Date.now() - HOUR);
    expect(await awayOf(u)).toBeUndefined();
    const q = lately();
    await savePrefs(u, { quietHours: { start: q.start, end: q.end } });
    // The window holds no update of theirs.
    expect(await awayOf(u)).toBeUndefined();
  });

  it("reading it by id keeps it away for that window, and a new window brings it back", async () => {
    const u = await mk("aw-read");
    const a = await page([u]);
    const q = lately();
    await savePrefs(u, { quietHours: { start: q.start, end: q.end } });
    await item(u, a, q.endAt - 2 * HOUR);
    const before = await awayOf(u);
    expect(before).toBeDefined();
    const r = await api(app, R.meInboxRead, u.cookie, {
      method: "POST",
      body: { ids: [before?.id] },
    });
    expect(await r.json()).toEqual({ read: 1 });
    expect(await awayOf(u)).toBeUndefined();
    // The updates it summed are still listed and still unread.
    expect(
      (await inbox(u)).updates.filter((i) => i.kind === "comment"),
    ).toHaveLength(1);
    // Only that window is read: its start is kept.
    const stored = await E.DB.prepare(
      "select value from settings where key = ?",
    )
      .bind(`inbox:away_read:${u.userId}`)
      .first<{ value: string }>();
    expect(Number(stored?.value)).toBe(
      Date.parse(before?.away?.since as string),
    );
  });
});
