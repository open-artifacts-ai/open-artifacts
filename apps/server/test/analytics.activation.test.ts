// #2479, #2879: activation events to PostHog. Hosted only, key required, once
// per member and step, an anonymous per-member id, fixed payload, best effort.
import { env } from "cloudflare:workers";
import { newId, WELCOME_TITLE } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  activation,
  BACKFILL_KEY,
  backfillActivation,
  memberDistinctId,
  memberFirstKey,
  noteMemberFirst,
  resetAnalyticsMemo,
  sendActivation,
} from "../src/services/analytics.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const on = (over: Partial<Env> = {}) =>
  ({
    ...env,
    HOSTED: "1",
    POSTHOG_KEY: "phc_test",
    INSTALL_ID: "inst123",
    ...over,
  }) as Env;

const fetchSpy = vi.fn();
let held: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void held.push(p) };
const flush = async () => {
  await Promise.all(held);
  held = [];
};
const clear = () =>
  env.DB.prepare(
    "delete from settings where key like 'analytics:%' or key = 'onboarding:welcome' or key like 'onboarding:named:%' or key like 'onboarding:mention-replied:%' or key like 'onboarding:ask-answered:%'",
  ).run();
const bodies = () =>
  fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body as string));
const member = async (prefix: string, role: "member" | "guest" = "member") => {
  const l = await login(`${prefix}-${tag}@x.com`, role);
  return { ...l, email: `${prefix}-${tag}@x.com` };
};

beforeEach(async () => {
  held = [];
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  resetAnalyticsMemo();
  await clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("activation events", () => {
  it("sends nothing when not hosted, and writes nothing", async () => {
    const u = await member("an-off");
    await activation(on({ HOSTED: undefined }), "agent_named", u.userId);
    await noteMemberFirst(
      on({ HOSTED: undefined }),
      u.userId,
      "agent_connected",
    );
    await backfillActivation(on({ HOSTED: undefined }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "select 1 from settings where key like 'analytics:%'",
      ).first(),
    ).toBeNull();
  });

  it("sends nothing without a key", async () => {
    const u = await member("an-nokey");
    for (const POSTHOG_KEY of [undefined, "  "]) {
      await activation(on({ POSTHOG_KEY }), "agent_named", u.userId);
      await noteMemberFirst(on({ POSTHOG_KEY }), u.userId, "agent_connected");
      await backfillActivation(on({ POSTHOG_KEY }));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts one event with only the allowed fields: no email, name, user id, IP or user agent", async () => {
    const u = await member("an-pay");
    await env.DB.prepare("update users set name = 'Pat Payload' where id = ?1")
      .bind(u.userId)
      .run();
    await sendActivation(on(), "agent_named", u.userId, Date.UTC(2026, 10, 14));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/capture/");
    expect(init.method).toBe("POST");
    expect(Object.keys(init.headers)).toEqual(["content-type"]);
    const id = await memberDistinctId(on(), u.userId);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(u.userId);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      api_key: "phc_test",
      event: "agent_named",
      distinct_id: id,
      properties: {
        instance_id: "inst123",
        plan: null,
        time: "2026-11-14T00:00:00.000Z",
        $groups: { instance: "inst123" },
        $geoip_disable: true,
      },
    });
    const raw = init.body as string;
    for (const secret of [
      u.userId,
      u.email,
      "Pat Payload",
      "pat-payload",
      "an-pay",
    ])
      expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/\$set|"\$ip"|\bip\b|user_agent|user-agent/i);
  });

  it("honours POSTHOG_HOST", async () => {
    const u = await member("an-host");
    await sendActivation(
      on({ POSTHOG_HOST: "https://eu.i.posthog.com/" }),
      "agent_named",
      u.userId,
    );
    expect(fetchSpy.mock.calls[0][0]).toBe("https://eu.i.posthog.com/capture/");
  });

  it("two members are two anonymous ids under one instance id; the id is stable and keyed by the secret", async () => {
    const a = await member("an-a");
    const b = await member("an-b");
    const ia = await memberDistinctId(on(), a.userId);
    const ib = await memberDistinctId(on(), b.userId);
    expect(ia).not.toBe(ib);
    expect(await memberDistinctId(on(), a.userId)).toBe(ia);
    // Rotating SESSION_SECRET gives a new id (accepted; never stored).
    expect(
      await memberDistinctId(
        on({ SESSION_SECRET: "another-secret-0123456789abcdef" }),
        a.userId,
      ),
    ).not.toBe(ia);
    await noteMemberFirst(on(), a.userId, "agent_connected", ctx);
    await noteMemberFirst(on(), b.userId, "agent_connected", ctx);
    await flush();
    const sent = bodies();
    expect(sent.map((x) => x.distinct_id).sort()).toEqual([ia, ib].sort());
    expect(new Set(sent.map((x) => x.properties.instance_id))).toEqual(
      new Set(["inst123"]),
    );
  });

  it("each step fires once per member, not once per instance", async () => {
    const a = await member("an-once-a");
    const b = await member("an-once-b");
    for (const u of [a, b, a, b]) {
      await noteMemberFirst(on(), u.userId, "agent_connected", ctx);
      await flush();
    }
    resetAnalyticsMemo();
    for (const u of [a, b]) {
      await noteMemberFirst(on(), u.userId, "agent_connected", ctx);
      await noteMemberFirst(on(), u.userId, "signed_up", ctx);
    }
    await flush();
    const ev = bodies().map((x) => x.event);
    expect(ev.filter((e) => e === "agent_connected")).toHaveLength(2);
    expect(ev.filter((e) => e === "signed_up")).toHaveLength(2);
    expect(
      await env.DB.prepare("select 1 as x from settings where key = ?1")
        .bind(memberFirstKey("agent_connected", a.userId))
        .first(),
    ).not.toBeNull();
  });

  it("an agent acting for a person is that person's event; an anonymous guest sends none", async () => {
    const p = await member("an-for");
    const g = await member("an-guest", "guest");
    await noteMemberFirst(on(), p.userId, "agent_named", ctx);
    await noteMemberFirst(on(), g.userId, "agent_connected", ctx);
    await noteMemberFirst(on(), g.userId, "first_page_published", ctx);
    await noteMemberFirst(on(), "no-such-user", "agent_connected", ctx);
    await flush();
    const sent = bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0].distinct_id).toBe(await memberDistinctId(on(), p.userId));
  });

  it("the first page published fires once per member, never for the Welcome", async () => {
    const owner = await member("an-owner");
    const u = await getUser(on(), owner.userId);
    if (!u) throw new Error("no user");
    const e = on();
    const pub = (title: string, format: "html" | "markdown" = "html") =>
      publish(
        e,
        u,
        { title, format, content: "<p>x</p>", visibility: "private" },
        null,
        ctx,
      ).then(async (r) => {
        await flush();
        return r;
      });
    // The Welcome seed is being written (claimed, id not yet recorded).
    await env.DB.prepare(
      "insert into settings (key, value) values ('onboarding:welcome', ?1)",
    )
      .bind(JSON.stringify({ userId: owner.userId, artifactId: "" }))
      .run();
    await pub(WELCOME_TITLE);
    // The provisioner's self-test: a markdown page with the same title.
    await pub(WELCOME_TITLE, "markdown");
    expect(fetchSpy).not.toHaveBeenCalled();
    await pub("Secret plan");
    await pub("Another");
    expect(bodies().map((b) => b.event)).toEqual(["first_page_published"]);
    expect(JSON.stringify(bodies())).not.toContain("Secret plan");
  });

  it("a throwing or failing send never throws", async () => {
    const u = await member("an-fail");
    fetchSpy.mockRejectedValueOnce(new Error("boom https://x.test/?k=secret"));
    await expect(
      activation(on(), "agent_named", u.userId),
    ).resolves.toBeUndefined();
    fetchSpy.mockResolvedValueOnce(new Response("no", { status: 500 }));
    await expect(
      sendActivation(on(), "agent_named", u.userId),
    ).resolves.toBeUndefined();
    fetchSpy.mockRejectedValueOnce(new Error("boom"));
    await expect(
      noteMemberFirst(on(), u.userId, "first_page_published", ctx),
    ).resolves.toBeUndefined();
    await flush();
    // Without SESSION_SECRET there is no id: no send, no throw.
    await expect(
      sendActivation(on({ SESSION_SECRET: "" }), "agent_named", u.userId),
    ).resolves.toBeUndefined();
  });

  it("with a ctx the send runs after the response", async () => {
    const u = await member("an-ctx");
    const h: Promise<unknown>[] = [];
    await activation(on(), "agent_named", u.userId, {
      waitUntil: (p) => void h.push(p),
    });
    expect(h).toHaveLength(1);
    await Promise.all(h);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a send that never answers never delays the caller", async () => {
    fetchSpy.mockReturnValue(new Promise(() => {}));
    const owner = await member("an-slow");
    const u = await getUser(on(), owner.userId);
    if (!u) throw new Error("no user");
    const done = async () => {
      await activation(on(), "agent_named", owner.userId);
      await noteMemberFirst(on(), owner.userId, "agent_connected");
      await publish(
        on(),
        u,
        {
          title: "Quick",
          format: "html",
          content: "<p>x</p>",
          visibility: "private",
        },
        null,
      );
      return "done";
    };
    // The send never settles; the caller finishing at all is the proof (a
    // caller that waited on it would hit the test timeout instead).
    expect(await done()).toBe("done");
  });
});

describe("the one-time backfill", () => {
  it("sends each member's stored firsts with their original times, once, and never again", async () => {
    const a = await member("an-bf-a");
    const b = await member("an-bf-b");
    const g = await member("an-bf-g", "guest");
    const T1 = Date.UTC(2026, 10, 1, 9);
    const T2 = Date.UTC(2026, 10, 2, 9);
    const set = (k: string, v: string) =>
      env.DB.prepare(
        "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
      )
        .bind(k, v)
        .run();
    await set(`onboarding:named:${a.userId}`, String(T1));
    await set(`onboarding:mention-replied:${a.userId}`, String(T2));
    await set(`onboarding:ask-answered:${b.userId}`, String(T2));
    await set(`onboarding:named:${g.userId}`, String(T1));
    const ia = await memberDistinctId(on(), a.userId);
    const ib = await memberDistinctId(on(), b.userId);
    const ig = await memberDistinctId(on(), g.userId);
    await backfillActivation(on());
    const mine = bodies().filter((x) => [ia, ib, ig].includes(x.distinct_id));
    const sentOf = (id: string) =>
      mine
        .filter((x) => x.distinct_id === id && x.event !== "signed_up")
        .map((x) => [x.event, x.timestamp, x.properties.time]);
    expect(sentOf(ia).sort()).toEqual(
      [
        ["agent_named", "2026-11-01T09:00:00.000Z", "2026-11-01T09:00:00.000Z"],
        [
          "agent_replied_to_mention",
          "2026-11-02T09:00:00.000Z",
          "2026-11-02T09:00:00.000Z",
        ],
      ].sort(),
    );
    expect(sentOf(ib)).toEqual([
      [
        "first_ask_answered",
        "2026-11-02T09:00:00.000Z",
        "2026-11-02T09:00:00.000Z",
      ],
    ]);
    // A guest has none; no text anywhere.
    expect(mine.some((x) => x.distinct_id === ig)).toBe(false);
    expect(JSON.stringify(bodies())).not.toContain(a.email);
    expect(
      await env.DB.prepare("select 1 as x from settings where key = ?1")
        .bind(BACKFILL_KEY)
        .first(),
    ).not.toBeNull();
    // Never again, and a later live first is not a duplicate.
    const before = fetchSpy.mock.calls.length;
    await backfillActivation(on());
    await noteMemberFirst(on(), a.userId, "agent_named", ctx);
    await flush();
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("a live first sent before the backfill is not sent again by it", async () => {
    const a = await member("an-bf-live");
    await noteMemberFirst(on(), a.userId, "agent_named", ctx);
    await flush();
    await env.DB.prepare("insert into settings (key, value) values (?1, ?2)")
      .bind(`onboarding:named:${a.userId}`, String(Date.UTC(2026, 10, 1)))
      .run();
    const ia = await memberDistinctId(on(), a.userId);
    fetchSpy.mockClear();
    await backfillActivation(on());
    expect(
      bodies().filter((x) => x.distinct_id === ia && x.event === "agent_named"),
    ).toHaveLength(0);
  });

  it("is bounded: a long list continues on the next run, then the marker is set", async () => {
    for (let i = 0; i < 3; i++) await member(`an-bf-many${i}`);
    const rows = await env.DB.prepare(
      "select id from users where role <> 'guest' and status = 'active'",
    ).all<{ id: string }>();
    const set = (k: string, v: string) =>
      env.DB.prepare(
        "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
      )
        .bind(k, v)
        .run();
    for (const r of rows.results)
      await set(`onboarding:named:${r.id}`, String(Date.UTC(2026, 10, 1)));
    await backfillActivation(on());
    const total = rows.results.length;
    expect(bodies().filter((x) => x.event === "agent_named")).toHaveLength(
      Math.min(total, 50),
    );
  });
});
