import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  REMIND_OFF_PATH,
  signRemindOffToken,
  verifyRemindOffToken,
} from "../src/email/setup-reminder.js";
import type { Env } from "../src/env.js";
import { memberSetups } from "../src/services/onboarding.js";
import {
  noRemindKey,
  remindedKey,
  sendSetupReminders,
} from "../src/services/setup-reminder.js";
import { mailer, seedUser, uniq } from "./auth-helpers.js";

// #2632 item 6: one reminder, three days after a first login with no agent.
// A clock far ahead of every other test's sign-ins, so only this file's
// people are due.
const NOW = Date.UTC(2100, 0, 15);
const DAY = 24 * 60 * 60 * 1000;
type Sent = {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

async function signedIn(role: "admin" | "member" | "guest", daysAgo: number) {
  const email = uniq(`rem-${role}`, "rem.test");
  const id = await seedUser(email, role);
  await env.DB.prepare(
    "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id) values (?, ?, 'user', ?, 'auth.signin', 'user', ?)",
  )
    .bind(newId(), NOW - daysAgo * DAY, id, id)
    .run();
  return { id, email };
}
const setting = async (key: string) =>
  (
    await env.DB.prepare("select value from settings where key = ?")
      .bind(key)
      .first<{ value: string }>()
  )?.value ?? null;
const setKey = (key: string) =>
  env.DB.prepare("insert into settings (key, value) values (?, '1')")
    .bind(key)
    .run();

describe("setup reminder (#2632)", () => {
  it("a member 3 to 10 days after first sign-in with no agent gets one email, once", async () => {
    const m = mailer();
    const E = { ...env, ...m.env } as Env;
    const due = await signedIn("member", 4);
    const admin = await signedIn("admin", 9);
    // Everyone who must not get one.
    const tooSoon = await signedIn("member", 2);
    const tooOld = await signedIn("member", 11);
    const guest = await signedIn("guest", 4);
    const agent = await signedIn("member", 4);
    await env.DB.prepare(
      "insert into agent_grants (grant_id, user_id) values (?, ?)",
    )
      .bind(newId(), agent.id)
      .run();
    const optedOut = await signedIn("member", 4);
    await setKey(noRemindKey(optedOut.id));
    const done = await signedIn("member", 4);
    await setKey(`onboarding:completed:${done.id}`);

    expect(await sendSetupReminders(E, NOW)).toBe(2);
    const sent = m.sent as unknown as Sent[];
    expect(sent.map((s) => s.to).sort()).toEqual(
      [due.email, admin.email].sort(),
    );
    const mail = sent.find((s) => s.to === due.email) as Sent;
    expect(mail.subject).toMatch(/^Your agent isn't connected to .+ yet$/);
    expect(mail.text).toMatch(
      /^You joined .+ three days ago\. One step is left: paste this into your agent\./,
    );
    expect(mail.text).toMatch(
      /Set up Open Artifacts for me: follow https?:\/\/[^\s]+\/llms\.txt/,
    );
    expect(mail.text).toContain(`Don't remind me: `);
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(
      new RegExp(`${REMIND_OFF_PATH}\\?t=`),
    );
    expect(Number(await setting(remindedKey(due.id)))).toBe(NOW);
    for (const u of [tooSoon, tooOld, guest, agent, optedOut, done])
      expect(await setting(remindedKey(u.id))).toBeNull();

    // Never twice; the one who was too soon gets theirs a day later.
    expect(await sendSetupReminders(E, NOW)).toBe(0);
    expect(await sendSetupReminders(E, NOW + DAY)).toBe(1);
    expect((m.sent as unknown as Sent[]).map((s) => s.to)).toEqual([
      ...sent.slice(0, 2).map((s) => s.to),
      tooSoon.email,
    ]);

    // Members shows "Reminded {date}".
    const s = await memberSetups(E, [
      { id: due.id, role: "member", lastSeenAt: NOW },
    ] as never);
    expect(s.get(due.id)?.remindedAt).toBe(new Date(NOW).toISOString());
  });

  it("a send that fails releases the claim, so the next day tries again", async () => {
    const m = mailer(true);
    const E = { ...env, ...m.env } as Env;
    const now = NOW + 40 * DAY;
    const u = await signedIn("member", -36);
    expect(await sendSetupReminders(E, now)).toBe(0);
    expect(await setting(remindedKey(u.id))).toBeNull();
  });

  it("with email off, nothing is claimed or sent", async () => {
    const now = NOW + 80 * DAY;
    const u = await signedIn("member", -76);
    expect(
      await sendSetupReminders({ ...env, EMAIL: undefined } as Env, now),
    ).toBe(0);
    expect(await setting(remindedKey(u.id))).toBeNull();
  });
});

describe("Don't remind me (#2632)", () => {
  const app = createApp();
  const hit = (method: string, path: string, body?: string) =>
    app.fetch(
      new Request(`http://app.localhost${path}`, {
        method,
        headers: body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {},
        body,
      }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );

  it("the token names one person; tampered or re-versioned is refused", async () => {
    const t = await signRemindOffToken(env, "user_a");
    expect(await verifyRemindOffToken(env, t)).toBe("user_a");
    const [v, , sig] = t.split(".") as [string, string, string];
    expect(await verifyRemindOffToken(env, `${v}.user_b.${sig}`)).toBeNull();
    expect(await verifyRemindOffToken(env, t.replace(/^v1/, "v2"))).toBeNull();
    expect(await verifyRemindOffToken(env, "")).toBeNull();
  });

  it("GET changes nothing; POST turns reminders off; a bad token is 400", async () => {
    const id = await seedUser(uniq("rem-off", "rem.test"), "member");
    const t = await signRemindOffToken(env, id);
    const q = `${REMIND_OFF_PATH}?t=${encodeURIComponent(t)}`;
    const get = await hit("GET", q);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("Don&#39;t remind me");
    expect(await setting(noRemindKey(id))).toBeNull();
    expect(
      (await hit("POST", REMIND_OFF_PATH, `t=${encodeURIComponent(t)}`)).status,
    ).toBe(200);
    expect(await setting(noRemindKey(id))).not.toBeNull();
    expect((await hit("POST", q)).status).toBe(200);
    expect((await hit("GET", `${REMIND_OFF_PATH}?t=nope`)).status).toBe(400);
    expect((await hit("POST", REMIND_OFF_PATH, "t=nope")).status).toBe(400);
  });
});
