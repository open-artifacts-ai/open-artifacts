// #2759: the hub tells a member's own agents when their quiet hours end.
// hello_ok.owner_away_until when the hub already knows, else an `owner_away`
// push; both only to a socket whose hello listed BUS_CAPS.ownerAway; a push at
// each window edge (the hub alarm) and when the member saves their prefs; only
// that member's own hub is ever touched. Time is BusHub.setTestClock.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { BusHub } from "../../src/bus/hub.js";
import { DEFAULT_PREFS } from "../../src/services/notification-prefs.js";
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

describe("hello: caps intersection (#2759)", () => {
  it("an older daemon (16 caps or fewer, no owner_away) still decodes hello_ok: only the caps it listed, no field, no push", async () => {
    const old = [
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
      "name_chosen",
      "ack_confirm",
      "run_version",
      "notice_meta",
    ];
    expect(old).toHaveLength(16);
    const { d, ok } = await open(old, { at: day(23) });
    // hello_ok decoded strictly (the helper's decoder); only what it listed.
    expect(ok.caps?.length ?? 0).toBeLessThanOrEqual(16);
    expect(ok.caps?.every((c) => old.includes(c))).toBe(true);
    expect(ok.caps).not.toContain("owner_away");
    expect(ok.owner_away_until).toBeUndefined();
    await again(d, old);
    expect(owner(d)).toEqual([]);
  });

  it("a daemon that listed one cap gets just that one back", async () => {
    const { ok } = await open(["ids"]);
    expect(ok.caps).toEqual(["ids"]);
  });

  it("a new daemon gets owner_away in caps; no cap: no caps field at all", async () => {
    const { ok } = await open(CAP);
    expect(ok.caps).toEqual(["owner_away"]);
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
