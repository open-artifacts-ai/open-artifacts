// #2759: the hub tells a member's own agents when their quiet hours end.
// hello_ok.owner_away_until when the hub already knows, else an `owner_away`
// push; both only to a socket whose hello listed BUS_CAPS.ownerAway; a push at
// each window edge (the hub alarm) and when the member saves their prefs; only
// that member's own hub is ever touched. Time is BusHub.setTestClock.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  decodeServerFrame,
  type ServerFrame,
} from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/app.js";
import { BusHub } from "../../src/bus/hub.js";
import {
  DEFAULT_PREFS,
  nextQuietEdge,
} from "../../src/services/notification-prefs.js";
import { api } from "../helpers.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
  hello,
  hubOf,
  machine,
  member,
  waitFor,
} from "./helpers.js";

const app = createApp();
const CAP = [BUS_CAPS.ownerAway];

/** 22:00 to 07:00 UTC, the design's example. */
const QUIET = { start: "22:00", end: "07:00" };
const day = (h: number, m = 0, d = 1) => Date.UTC(2031, 0, d, h, m);
const iso = (ms: number) => new Date(ms).toISOString();

const clocked = new Set<string>();
const setClock = async (userId: string, ms: number | null) => {
  clocked.add(userId);
  await runInDurableObject(await hubOf(userId), (i) =>
    BusHub.setTestClock(i, ms),
  );
};
afterEach(async () => {
  for (const u of clocked) await setClock(u, null);
  clocked.clear();
});

const savePrefs = (
  userId: string,
  quiet: { start: string; end: string } | null,
) =>
  e.DB.prepare(
    `insert into notification_prefs (user_id, needs_you_browser, updates_browser, browser_all_asks, quiet_start, quiet_end, time_zone, lock_detail, updated_at)
     values (?1, 0, 0, 0, ?2, ?3, 'UTC', 0, 0)
     on conflict (user_id) do update set quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end`,
  )
    .bind(userId, quiet?.start ?? null, quiet?.end ?? null)
    .run();

/** A fresh member with quiet hours, a machine and a socket whose hello (caps) is answered. */
async function open(
  caps: string[],
  o: { quiet?: typeof QUIET | null; at?: number } = {},
) {
  const who = await member();
  if (o.quiet !== null) await savePrefs(who.userId, o.quiet ?? QUIET);
  if (o.at !== undefined) await setClock(who.userId, o.at);
  const m = await machine("MacBook", who.userId);
  const d = await daemon(m.token);
  d.send({ ...hello("h0"), ...(caps.length ? { caps } : {}) } as ClientFrame);
  const ok = await waitFor(d, "hello_ok");
  return { who, m, d, ok };
}
const again = async (d: Daemon, caps: string[]) => {
  const id = `h${Math.random().toString(36).slice(2, 10)}`;
  d.send({ ...hello(id), ...(caps.length ? { caps } : {}) } as ClientFrame);
  for (;;) {
    const f = await waitFor(d, "hello_ok");
    if (f.id === id) return f;
  }
};
const owner = (d: Daemon): Extract<ServerFrame, { type: "owner_away" }>[] =>
  framesSeen(d).filter(
    (f): f is Extract<ServerFrame, { type: "owner_away" }> =>
      f.type === "owner_away",
  );

describe("hello: caps (#2759)", () => {
  it("a released daemon's strict hello_ok decoder (at most 16 caps, no owner_away_until) still accepts the hub's hello_ok to a 12-cap hello", async () => {
    // The last released daemon's hello_ok, pinned: strict, caps capped at 16.
    const RELEASED_MAX_CAPS = 16;
    const ReleasedHelloOk = z.strictObject({
      v: z.literal(1),
      id: z.string(),
      type: z.literal("hello_ok"),
      machine_id: z.string(),
      machine_label: z.string(),
      server_version: z.string(),
      caps: z.array(z.string()).max(RELEASED_MAX_CAPS).optional(),
      run_version: z.string().nullable().optional(),
    });
    const listed = [
      "rename",
      "roles",
      "ids",
      "mailbox",
      "links",
      "reach",
      "follow",
      "link",
      "link_arg",
      "waiting",
      "waiting_query",
      "notice_ack",
    ];
    expect(listed).toHaveLength(12);
    const { d, ok } = await open(listed, { at: day(23) });
    const raw = d.raw
      .map((t) => {
        try {
          return JSON.parse(t) as { type?: string };
        } catch {
          return {};
        }
      })
      .find((f) => f.type === "hello_ok");
    const parsed = ReleasedHelloOk.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // Never owner_away, whatever else the hub lists.
    expect(ok.caps).not.toContain("owner_away");
    expect(ok.owner_away_until).toBeUndefined();
    // No push either: an older daemon refuses unknown frames.
    await again(d, listed);
    expect(owner(d)).toEqual([]);
  });

  it("a daemon that lists owner_away gets it in caps (17, past the old 16); no cap at all: no caps field", async () => {
    const { d, ok } = await open(CAP);
    expect(ok.caps).toContain("owner_away");
    expect(ok.caps?.length).toBeGreaterThan(16);
    // A new daemon's decoder (bus-protocol's, MAX_CAPS 32) accepts all 17.
    const rawOk = d.raw.find((t) => t.includes('"hello_ok"')) ?? "";
    const dec = decodeServerFrame(rawOk);
    expect(dec.ok).toBe(true);
    expect(
      dec.ok && dec.frame.type === "hello_ok" ? dec.frame.caps?.length : 0,
    ).toBe(17);
    const none = await open([]);
    expect(none.ok.caps).toBeUndefined();
    expect(none.ok.owner_away_until).toBeUndefined();
    expect(owner(none.d)).toEqual([]);
  });
});

describe("owner_away_until and the push", () => {
  it("in quiet hours: a cold hello is followed by a push; the next hello_ok carries the field", async () => {
    const at = day(23);
    const { d, ok } = await open(CAP, { at });
    // Cold hub: the hub does not yet know, so a push follows.
    expect(ok.owner_away_until).toBeUndefined();
    const push = await waitFor(d, "owner_away");
    expect(push.until).toBe(iso(day(7, 0, 2)));
    const ok2 = await again(d, CAP);
    expect(ok2.owner_away_until).toBe(iso(day(7, 0, 2)));
  });

  it("outside quiet hours it is null; with no quiet hours set, null too", async () => {
    const out = await open(CAP, { at: day(12) });
    expect((await waitFor(out.d, "owner_away")).until).toBeNull();
    expect((await again(out.d, CAP)).owner_away_until).toBeNull();
    const none = await open(CAP, { quiet: null, at: day(23) });
    expect((await waitFor(none.d, "owner_away")).until).toBeNull();
  });

  it("the alarm pushes at the window's start and at its end", async () => {
    const { who, d } = await open(CAP, { at: day(21) });
    expect((await waitFor(d, "owner_away")).until).toBeNull();
    // 22:00 passes: quiet hours begin.
    await setClock(who.userId, day(22, 0) + 30_000);
    await runDurableObjectAlarm(await hubOf(who.userId));
    expect((await waitFor(d, "owner_away")).until).toBe(iso(day(7, 0, 2)));
    // 07:00 the next day passes: they end.
    await setClock(who.userId, day(7, 0, 2) + 30_000);
    await runDurableObjectAlarm(await hubOf(who.userId));
    expect((await waitFor(d, "owner_away")).until).toBeNull();
  });
});

describe("an edge at or before now never loops the alarm", () => {
  const dueOf = async (userId: string) =>
    runInDurableObject(await hubOf(userId), (_i, st) => ({
      due: Number(
        st.storage.sql
          .exec("select value from meta where key = 'owner_away_due'")
          .toArray()[0]?.value ?? Number.NaN,
      ),
      alarm: st.storage.getAlarm(),
    }));

  it("start equal to end (a row prefs refuse): the next edge is armed at least a minute out, and stays so after an alarm", async () => {
    const at = day(12);
    const { who, d } = await open(CAP, {
      quiet: { start: "08:00", end: "08:00" },
      at,
    });
    await waitFor(d, "owner_away");
    let s = await dueOf(who.userId);
    expect(s.due).toBeGreaterThanOrEqual(at + 60_000);
    expect(await s.alarm).toBeGreaterThanOrEqual(at + 60_000);
    // The alarm fires a minute later: still not due now, still not looping.
    const later = at + 61_000;
    await setClock(who.userId, later);
    await runDurableObjectAlarm(await hubOf(who.userId));
    s = await dueOf(who.userId);
    expect(s.due).toBeGreaterThanOrEqual(later + 60_000);
    expect(await s.alarm).toBeGreaterThanOrEqual(later + 60_000);
  });

  it("the prefs save refuses start equal to end with a 400", async () => {
    const a = await open(CAP, { quiet: null, at: day(12) });
    const r = await api(app, R.meNotificationPrefs, a.who.cookie, {
      method: "PUT",
      body: { ...DEFAULT_PREFS, quietHours: { start: "08:00", end: "08:00" } },
    });
    expect(r.status).toBe(400);
  });
});

describe("a prefs save and other members' hubs", () => {
  const put = (cookie: string, quietHours: typeof QUIET | null) =>
    api(app, R.meNotificationPrefs, cookie, {
      method: "PUT",
      body: { ...DEFAULT_PREFS, quietHours },
    });

  it("saving quiet hours pushes owner_away to that member's sockets, and only theirs", async () => {
    const at = day(23);
    // Two members, each with a cap'd socket; only A saves.
    const a = await open(CAP, { quiet: null, at });
    const b = await open(CAP, { quiet: QUIET, at });
    expect((await waitFor(a.d, "owner_away")).until).toBeNull();
    expect((await waitFor(b.d, "owner_away")).until).toBe(iso(day(7, 0, 2)));
    const bBefore = owner(b.d).length;
    const res = await put(a.who.cookie, QUIET);
    expect(res.status).toBe(200);
    expect((await waitFor(a.d, "owner_away")).until).toBe(iso(day(7, 0, 2)));
    // B's hub was never called: a round trip later it has heard nothing new.
    await again(b.d, CAP);
    expect(owner(b.d)).toHaveLength(bBefore);
  });

  it("a socket without the cap hears nothing, however often the prefs change", async () => {
    const at = day(23);
    const a = await open(["ids"], { quiet: null, at });
    expect((await put(a.who.cookie, QUIET)).status).toBe(200);
    expect((await put(a.who.cookie, null)).status).toBe(200);
    await again(a.d, ["ids"]);
    expect(owner(a.d)).toEqual([]);
  });
});

describe("nextQuietEdge", () => {
  const p = (tz = "UTC") => ({ quietHours: QUIET, timeZone: tz });
  it("inside the window: its end; outside: the next start; none: null", () => {
    expect(nextQuietEdge(p(), day(23))).toBe(day(7, 0, 2));
    expect(nextQuietEdge(p(), day(12))).toBe(day(22));
    // After today's start has passed it is inside; just before midnight's end it is the same night's end.
    expect(nextQuietEdge(p(), day(3))).toBe(day(7));
    expect(
      nextQuietEdge({ quietHours: null, timeZone: "UTC" }, day(12)),
    ).toBeNull();
    // A bad zone is no edge, never a throw.
    expect(nextQuietEdge(p("Mars/Base"), day(12))).toBeNull();
  });
  it("is on the person's clock", () => {
    // Paris in January is UTC+1: 22:00 there is 21:00 UTC.
    expect(nextQuietEdge(p("Europe/Paris"), day(12))).toBe(day(21));
  });
});
