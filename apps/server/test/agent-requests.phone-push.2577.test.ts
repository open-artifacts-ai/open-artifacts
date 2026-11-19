import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { recordHolds } from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import { HELD_EXCERPT } from "../src/services/inbox-items.js";
import { DEFAULT_HELD_BODY, pushPayload } from "../src/services/push.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2577: "Send held requests to my phone". Off by default (inbox only); on, a
// newly held request queues one browser push with fixed text, never the words.

const E = env as unknown as Env;
// A VAPID pair so push is on; nothing is sent here, only queued.
const EP = {
  ...E,
  VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
} as Env;
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
/** The member's browser: notifications on and one subscription. */
async function enroll() {
  await E.DB.prepare(
    `insert into notification_prefs (user_id, needs_you_browser, updated_at) values (?1, 1, ?2)
     on conflict (user_id) do update set needs_you_browser = 1`,
  )
    .bind(owner.userId, Date.now())
    .run();
  await E.DB.prepare(
    `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     values (?1, ?2, ?3, 'p', 'a', ?4)`,
  )
    .bind(newId(), owner.userId, `https://e.example/${newId()}`, Date.now())
    .run();
}

describe("the phone switch", () => {
  it("is off by default; a browser session toggles it alone or with the other switch, audited once per change", async () => {
    expect(await get()).toEqual({ on: true, phonePush: false });
    const a0 = await audits();
    const r = await put({ phonePush: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ on: true, phonePush: true });
    expect(await get()).toEqual({ on: true, phonePush: true });
    await put({ phonePush: true });
    expect(await audits()).toBe(a0 + 1);
    // The other switch keeps it; both at once.
    expect(await (await put({ on: false })).json()).toEqual({
      on: false,
      phonePush: true,
    });
    expect(await (await put({ on: true, phonePush: false })).json()).toEqual({
      on: true,
      phonePush: false,
    });
  });

  it("a token cannot save it but can read it; an empty or unknown body is 400", async () => {
    const pat = (await createPat(E, owner.userId, "pp")).token;
    expect(
      (
        await api(app, R.agentRequests, pat, {
          method: "PUT",
          body: { phonePush: true },
        })
      ).status,
    ).toBe(403);
    expect((await api(app, R.agentRequests, pat)).status).toBe(200);
    expect((await put({})).status).toBe(400);
    expect((await put({ phonePush: "yes" })).status).toBe(400);
    expect((await put({ other: 1 })).status).toBe(400);
    expect((await get()).phonePush).toBe(false);
  });
});

describe("a held request and the phone", () => {
  it("off: nothing is queued; on: one push per new request with fixed text, none again for more on the same page", async () => {
    await enroll();
    await put({ phonePush: false });
    const off = await page();
    await hold(off, "c-off");
    expect(
      (await pending()).filter((p) => p.excerpt === HELD_EXCERPT),
    ).toHaveLength(0);
    expect(await pending()).toHaveLength(0);

    await put({ phonePush: true });
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
