import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NotificationPrefs,
  type PushSubscriptions,
  R,
  viewerPath,
} from "@oa/shared";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import {
  A,
  api,
  cleanup,
  expect,
  json,
  needs,
  OAUTH_HOOK_EMAIL,
  oauthAgent,
  type Person,
  person,
  personAt,
  publish,
  SPACES,
  t19Spaces,
  test,
} from "./fixtures";

// #3024 "a real test": a real push reaches a real browser. Person A enrols
// official Google Chrome (the dashboard's own Settings > Notifications switch),
// person B puts an ask to A, then @-mentions A, and the test waits for the
// push to arrive in the browser's service worker and be shown.
//
// Why official Chrome in a persistent context: Playwright's bundled Chromium
// has no push service, and a normal (incognito-like) context is refused
// ("permission denied"). A persistent Chrome profile with the notifications
// permission gets a real fcm.googleapis.com subscription. Needs Google Chrome
// installed (CI: the runner's; locally /usr/bin/google-chrome): without it the
// case fails, never skips.
//
// The wait: the product's /sw.js posts nothing to pages on a push; it calls
// showNotification. So the test reads registration.getNotifications() until
// the wanted one is there. The server sends it on the RECOVERY_CRON tick
// (every 2 minutes) and has no test hook to drain the queue, so a case waits
// up to one tick plus slack.

// The release that ships account push (#3024); a run on an older rl-a skips
// (a failure on the gate run). T19_PUSH_MIN lets a local pair name its own.
const MIN = process.env.T19_PUSH_MIN ?? "0.252.0";
const TICK_WAIT_MS = 4 * 60_000;
const { eng } = SPACES;
const DEFAULT_BODY = "An agent is waiting for your answer";
const MENTION_BODY = "Someone mentioned you";

let keeper: Person;
let b: Person;
test.beforeAll(async ({ browser }) => {
  const admin = await person(browser, "admin", "admin");
  await t19Spaces(admin);
  keeper = await person(browser, "keeper", "member", [
    { spaceId: eng.id, role: "manager" },
  ]);
  // The asker: the OAuth hook's member, whose agent can put an ask (an ask
  // is MCP-only) and who, as a person in a browser session, can @-mention.
  b = await personAt(browser, OAUTH_HOOK_EMAIL, "push-b", "member", [
    { spaceId: eng.id, role: "editor" },
  ]);
});
test.afterAll(cleanup);

/** Official Chrome, a fresh profile, notifications allowed, signed in as `who`. */
async function chromeAs(who: Person): Promise<{
  ctx: BrowserContext;
  page: Page;
  done: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "t19-push-"));
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      channel: "chrome",
      permissions: ["notifications"],
      baseURL: A.app,
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `T19 push needs official Google Chrome (channel "chrome"): ${(e as Error).message}${
        existsSync("/usr/bin/google-chrome")
          ? ""
          : " (/usr/bin/google-chrome is missing)"
      }`,
    );
  }
  await ctx.addCookies([
    {
      name: A.cookieName,
      value: who.cookie,
      url: A.app,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return {
    ctx,
    page: await ctx.newPage(),
    done: async () => {
      await ctx.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const devices = async (p: Person) =>
  (await json<PushSubscriptions>(await api(p, R.mePushSubscriptions))).items;
const prefs = async (p: Person) =>
  json<NotificationPrefs>(await api(p, R.meNotificationPrefs));

/** The notifications this browser's push service worker is showing. */
const shown = (page: Page) =>
  page.evaluate(async () => {
    const reg =
      await navigator.serviceWorker.getRegistration("/notifications/sw/");
    const list = (await reg?.getNotifications()) ?? [];
    return list.map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      href: (n.data as { href?: string } | null)?.href ?? "",
    }));
  });

/**
 * Turns notifications on the way a person does: Settings > Notifications, the
 * "Needs you in this browser" switch (the real subscribe through the
 * dashboard's own code). `allAsks` also picks "Every ask put to me": a
 * plain ask from someone else's agent interrupts only then.
 */
async function enrol(a: Person, page: Page, allAsks: boolean) {
  await page.goto("/settings/notifications");
  const sw = page.getByRole("switch", { name: "Needs you in this browser" });
  await expect(sw).toBeEnabled();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(async () => (await devices(a)).length).toBe(1);
  await expect.poll(async () => (await prefs(a)).needsYou.browser).toBe(true);
  if (allAsks) {
    await page.getByRole("combobox", { name: "Interrupt me for" }).click();
    await page.getByRole("option", { name: "Every ask put to me" }).click();
    await expect.poll(async () => (await prefs(a)).browserAllAsks).toBe(true);
  }
}

/** Turns the switch off (the product's remove path): the device is gone. */
async function remove(a: Person, page: Page) {
  const sw = page.getByRole("switch", { name: "Needs you in this browser" });
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await devices(a)).length).toBe(0);
}

/** One commentable page B owns in t19-eng, which A can read. */
async function pageForB(title: string) {
  const { id } = await publish(
    b,
    {
      title: `${title} ${Date.now()}`,
      format: "html",
      content: `<!doctype html><title>${title}</title><p>${title}</p>`,
      comments: true,
      spaceId: eng.id,
    },
    keeper,
  );
  return id;
}

/** Waits for the one notification with `body`, within one cron tick plus slack. */
async function arrives(page: Page, body: string) {
  await expect
    .poll(async () => (await shown(page)).map((n) => n.body), {
      timeout: TICK_WAIT_MS,
      message: "a push reaches the browser's service worker (cron tick)",
    })
    .toContain(body);
  const n = (await shown(page)).find((x) => x.body === body);
  if (!n) throw new Error("the notification was replaced after it arrived");
  return n;
}

test("push: an ask put to A reaches A's Chrome", async ({ browser }) => {
  test.setTimeout(TICK_WAIT_MS + 90_000);
  await needs("browser push (#3024)", MIN);
  const a = await person(browser, "push-a-ask", "member", [
    { spaceId: eng.id, role: "viewer" },
  ]);
  const id = await pageForB("T19 push ask");
  const chrome = await chromeAs(a);
  const agent = await oauthAgent("t19-push-agent");
  try {
    await enrol(a, chrome.page, true);
    const question = "Push this one?";
    const asked = await agent.call("add_comment", {
      id,
      body: question,
      ask: {
        question,
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        to: [{ key: a.id }],
      },
    });
    expect(asked.ok, asked.text).toBe(true);
    const n = await arrives(chrome.page, DEFAULT_BODY);
    expect(n.tag).toBe("needs-you");
    expect(n.title).not.toBe("");
    expect(n.title).not.toMatch(/things need you/);
    expect(n.href).toContain(viewerPath(id));
    await remove(a, chrome.page);
  } finally {
    await agent.close();
    await chrome.done();
    for (const d of await devices(a)) {
      await api(a, R.mePushSubscription(d.id), { method: "DELETE" });
    }
  }
});

test("push: B's @-mention of A reaches A's Chrome", async ({ browser }) => {
  test.setTimeout(TICK_WAIT_MS + 90_000);
  await needs("browser push (#3024)", MIN);
  const a = await person(browser, "push-a-mention", "member", [
    { spaceId: eng.id, role: "viewer" },
  ]);
  const id = await pageForB("T19 push mention");
  const chrome = await chromeAs(a);
  try {
    await enrol(a, chrome.page, false);
    await json(
      await api(b, R.comments(id), {
        method: "POST",
        body: JSON.stringify({
          anchor: { kind: "note" },
          body: `Hello @${a.name}`,
          people: [a.id],
        }),
      }),
    );
    const n = await arrives(chrome.page, MENTION_BODY);
    expect(n.tag).toBe("needs-you");
    expect(n.title).not.toBe("");
    expect(n.title).not.toMatch(/things need you/);
    expect(n.href).toContain(viewerPath(id));
    await remove(a, chrome.page);
  } finally {
    await chrome.done();
    for (const d of await devices(a)) {
      await api(a, R.mePushSubscription(d.id), { method: "DELETE" });
    }
  }
});
