import { env } from "cloudflare:workers";
import {
  AgentRequestsSwitchSchema,
  type NotificationPrefs,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { recordHolds } from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import { HELD_EXCERPT } from "../src/services/inbox-items.js";
import { DEFAULT_PREFS } from "../src/services/notification-prefs.js";
import { DEFAULT_HELD_BODY, pushPayload } from "../src/services/push.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2577, #3024: a newly held request is Needs you: with the account's Needs you
// on and a device enrolled it queues one browser push with fixed text, never
// the words. There is no separate phone switch.

const E = env as unknown as Env;
// Push is on with a SESSION_SECRET; nothing is sent here, only queued.
const EP = { ...E } as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

let owner: Awaited<ReturnType<typeof login>>;
let sender: Awaited<ReturnType<typeof login>>;
beforeAll(async () => {
  owner = await login(`pp-owner-${tag}@x.com`, "member");
  sender = await login(`pp-sender-${tag}@x.com`, "member");
});

const get = async (cookie = owner.cookie) =>
  (await (await api(app, R.agentRequests, cookie)).json()) as {
    on: boolean;
    phonePush: boolean;
  };
const put = (body: unknown, cookie = owner.cookie) =>
  api(app, R.agentRequests, cookie, { method: "PUT", body });
const audits = async () =>
  (
    await E.DB.prepare(
      "select count(*) as n from audit_events where action = 'agent_requests.switch' and actor_id = ?1",
    )
      .bind(owner.userId)
      .first<{ n: number }>()
  )?.n as number;

async function page() {
  const me = (await getUser(E, owner.userId)) as never;
  const a = await publish(
    E,
    me,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  await putShare(E, me, a.id, {
    email: `pp-sender-${tag}@x.com`,
    role: "editor",
  });
  return a.id;
}
const hold = (artifactId: string, commentId: string) =>
  recordHolds(EP, sender.userId, artifactId, "t1", commentId, [
    {
      agent: { key: "k1", owner: owner.userId, name: "Claude" },
      way: "mention",
    } as never,
  ]);
const pending = async () =>
  (
    await E.DB.prepare(
      "select key, kind, excerpt from push_pending where user_id = ?1 and key like 'held:%'",
    )
      .bind(owner.userId)
      .all<{ key: string; kind: string; excerpt: string }>()
  ).results;
const prefsNow = async () =>
  (await (
    await api(app, R.meNotificationPrefs, owner.cookie)
  ).json()) as NotificationPrefs;
/** The account's choices, saved through the guarded preference route. */
const savePrefs = (needsYouBrowser: boolean) =>
  api(app, R.meNotificationPrefs, owner.cookie, {
    method: "PUT",
    body: {
      ...DEFAULT_PREFS,
      interrupt: needsYouBrowser ? "mentions" : "none",
    },
  });
/** One enrolled device: a subscription row, nothing else. */
async function enrollDevice() {
  await E.DB.prepare(
    `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     values (?1, ?2, ?3, 'p', 'a', ?4)`,
  )
    .bind(newId(), owner.userId, `https://e.example/${newId()}`, Date.now())
    .run();
}
const dropDevices = () =>
  E.DB.prepare("delete from push_subscriptions where user_id = ?1")
    .bind(owner.userId)
    .run();

describe("the held-requests switch (#3024: part of the account's Needs you)", () => {
  it("phonePush is projected from the account's Needs you; saving { on } never changes it and is audited once per change", async () => {
    // No prefs row: Needs you is on by default (#3024), so the projection is on.
    expect(await get()).toEqual({ on: true, phonePush: true });
    const a0 = await audits();
    expect(await (await put({ on: false })).json()).toEqual({
      on: false,
      phonePush: true,
    });
    await put({ on: false });
    expect(await audits()).toBe(a0 + 1);
    expect((await prefsNow()).needsYou.browser).toBe(true);
    // The account's own save moves the projection.
    expect((await savePrefs(false)).status).toBe(200);
    expect(await (await put({ on: true })).json()).toEqual({
      on: true,
      phonePush: false,
    });
    expect(await get()).toEqual({ on: true, phonePush: false });
    expect((await savePrefs(true)).status).toBe(200);
    expect((await get()).phonePush).toBe(true);
  });

  it("an older client's phone-only opt-in is refused and turns on nothing; a token cannot save but can read; bad bodies are 400", async () => {
    const pat = (await createPat(E, owner.userId, "pp")).token;
    expect(
      (
        await api(app, R.agentRequests, pat, {
          method: "PUT",
          body: { on: true },
        })
      ).status,
    ).toBe(403);
    expect((await api(app, R.agentRequests, pat)).status).toBe(200);
    expect((await put({})).status).toBe(400);
    expect((await put({ phonePush: true })).status).toBe(400);
    expect((await put({ on: true, phonePush: true })).status).toBe(400);
    expect((await put({ phonePush: "yes" })).status).toBe(400);
    expect((await put({ other: 1 })).status).toBe(400);
    // Nothing was turned on for any category.
    expect(await prefsNow()).toEqual(DEFAULT_PREFS);
    expect((await get()).phonePush).toBe(true);
  });
});

describe("the dashboard's parse path against the real server", () => {
  // apps/dashboard/src/api/agentAsks.ts: api.get / api.send(PUT { on }) parse the
  // response with AgentRequestsSwitchSchema (strict): the real answers must satisfy it.
  it("GET and a PUT of only { on } answer exactly what the dashboard's schema accepts", async () => {
    const g = await api(app, R.agentRequests, owner.cookie);
    expect(AgentRequestsSwitchSchema.safeParse(await g.json()).success).toBe(
      true,
    );
    const p = await put({ on: false });
    expect(p.status).toBe(200);
    const body = (await p.json()) as Record<string, unknown>;
    expect(AgentRequestsSwitchSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["on", "phonePush"]);
    await put({ on: true });
  });
});

describe("a held request and the phone", () => {
  it("account Needs you off: nothing is queued; on with a device: one push per new request with fixed text, none again for more on the same page", async () => {
    await dropDevices();
    await enrollDevice();
    await savePrefs(false);
    const off = await page();
    await hold(off, "c-off");
    expect(await pending()).toHaveLength(0);

    // On, but no device enrolled: still nothing.
    await savePrefs(true);
    await dropDevices();
    await hold(await page(), "c-nodevice");
    expect(await pending()).toHaveLength(0);

    // On with a device; the held switch is not separately consulted.
    await enrollDevice();
    const on = await page();
    await hold(on, "c-on-1");
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ask", excerpt: HELD_EXCERPT });
    expect(rows[0]?.key).toMatch(/^held:/);
    // A second comment on the same page is the same request: no second push.
    await E.DB.prepare("delete from push_pending where user_id = ?1")
      .bind(owner.userId)
      .run();
    await hold(on, "c-on-2");
    expect(await pending()).toHaveLength(0);
    // A new page is a new request.
    await hold(await page(), "c-on-3");
    expect(await pending()).toHaveLength(1);
  });

  it("the notification text is fixed whatever the lock-screen setting", () => {
    const row = {
      kind: "ask" as const,
      key: "held:r1",
      artifact_id: "a1",
      thread_id: "",
      asker_name: "Dev",
      excerpt: HELD_EXCERPT,
    };
    for (const detail of [false, true])
      expect(
        JSON.stringify(pushPayload([row], detail, "Open Artifacts")),
      ).not.toMatch(/Dev|Claude|words/);
    for (const detail of [false, true])
      expect(pushPayload([row], detail, "Open Artifacts").body).toBe(
        DEFAULT_HELD_BODY,
      );
  });
});
