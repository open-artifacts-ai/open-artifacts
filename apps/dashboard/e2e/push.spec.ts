// #2512 slice 3: browser notifications on the mocks (?mock=foryou), at 1280 light (#2711).
// The browser's Notification and our service worker registration are stubbed in
// the page (the mock API's own worker stays real). Blocked, unsupported, no push key,
// the 30-day Not now and /sw.js live in test/for-you-settings.test.tsx and test/push-sw.test.ts.
// FOR_YOU_SHOTS_DIR picks where PNGs go.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.FOR_YOU_SHOTS_DIR;

type Stub = {
  /** The permission at load, and what the browser's prompt answers. */
  start?: NotificationPermission;
  answer?: NotificationPermission;
  /** A browser with no push at all. */
  unsupported?: boolean;
};
async function stub(page: Page, s: Stub = {}) {
  await page.addInitScript((s: Stub) => {
    const w = window as unknown as Record<string, unknown>;
    if (s.unsupported) {
      delete w.PushManager;
      Object.defineProperty(window, "PushManager", { value: undefined });
      return;
    }
    const n = {
      permission: s.start ?? "default",
      asked: 0,
      requestPermission: async () => {
        n.asked++;
        n.permission = s.answer ?? "granted";
        return n.permission;
      },
    };
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: n,
    });
    w.PushManager = function PushManager() {};
    let sub: object | null = null;
    // Like a real PushSubscription: it keeps the key it was made with (#3024).
    const asBuffer = (k: unknown): ArrayBuffer | null => {
      if (k instanceof ArrayBuffer) return k.slice(0);
      if (ArrayBuffer.isView(k))
        return new Uint8Array(k.buffer, k.byteOffset, k.byteLength).slice()
          .buffer;
      if (typeof k === "string") {
        const b = atob(k.replace(/-/g, "+").replace(/_/g, "/"));
        return Uint8Array.from(b, (ch) => ch.charCodeAt(0)).buffer;
      }
      return null;
    };
    const subscription = {
      options: { applicationServerKey: null as ArrayBuffer | null },
      endpoint: "https://push.example.com/abc",
      toJSON: () => ({
        endpoint: "https://push.example.com/abc",
        keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez" },
      }),
      unsubscribe: async () => {
        sub = null;
        return true;
      },
    };
    const reg = {
      scope: `${location.origin}/notifications/sw/`,
      active: {},
      installing: null,
      waiting: null,
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async (o?: PushSubscriptionOptionsInit) => {
          subscription.options.applicationServerKey = asBuffer(
            o?.applicationServerKey,
          );
          sub = subscription;
          return subscription;
        },
      },
    };
    // Only our worker is faked: the mock API's worker registers for real.
    const c = navigator.serviceWorker;
    const register = c.register.bind(c);
    const get = c.getRegistration.bind(c);
    w.__oaSwRegistered = [];
    c.register = ((url: string, o?: RegistrationOptions) => {
      if (String(url).endsWith("/sw.js")) {
        (w.__oaSwRegistered as unknown[]).push([String(url), o?.scope]);
        return Promise.resolve(reg as unknown as ServiceWorkerRegistration);
      }
      return register(url, o);
    }) as typeof c.register;
    c.getRegistration = ((scope?: string) =>
      scope && String(scope).includes("/notifications/sw/")
        ? Promise.resolve(
            (sub ? reg : undefined) as unknown as ServiceWorkerRegistration,
          )
        : get(scope)) as typeof c.getRegistration;
  }, s);
}

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
async function axe(page: Page) {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async () => {
    // @ts-expect-error injected
    const res = await axe.run(document, { resultTypes: ["violations"] });
    return res.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map((x: { id: string }) => x.id);
  });
  expect(v).toEqual([]);
}
const sideways = (page: Page) =>
  page.evaluate(
    () =>
      (document.scrollingElement as Element).scrollWidth > window.innerWidth,
  );

const width = 1280;
const theme = "light";
test.use({ colorScheme: theme, viewport: { width, height: 1000 } });
const shot = async (page: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await settled(page);
  await page.screenshot({
    path: `${OUT}/${name}-${width}-${theme}.png`,
    fullPage: true,
  });
};
const needs = (page: Page) =>
  page.getByRole("switch", { name: "Needs you in this browser" });

test("off, then on from the click; the prompt waits for it", async ({
  page,
}) => {
  await stub(page, { answer: "granted" });
  await page.goto("/settings/notifications?mock=foryou");
  await expect(needs(page)).toHaveAttribute("aria-checked", "false");
  // Nothing was asked on load.
  expect(
    await page.evaluate(
      () => (Notification as unknown as { asked: number }).asked,
    ),
  ).toBe(0);
  await shot(page, "p1-settings-off");
  await axe(page);
  expect(await sideways(page)).toBe(false);
  const sub = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/me/push/subscriptions"),
  );
  await needs(page).click();
  expect((await sub).postDataJSON()).toMatchObject({
    endpoint: "https://push.example.com/abc",
  });
  await expect(needs(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/^On for /)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __oaSwRegistered: unknown[] }).__oaSwRegistered,
    ),
  ).toEqual([["/sw.js", "/notifications/sw/"]]);
  await expect(
    page.getByRole("switch", { name: "Updates in this browser" }),
  ).toHaveCount(0);
  await shot(page, "p2-settings-on");
  await axe(page);
});

test("the nudge in For you, asked once", async ({ page }) => {
  await stub(page, { answer: "granted" });
  await page.goto("/?mock=foryou");
  await page.getByRole("button", { name: /^For you/ }).click();
  const nudge = page.locator("[data-push-nudge]");
  await expect(nudge).toContainText(
    /An agent waited \d+ minutes? for you today\. Get told the moment one is waiting\?/,
  );
  await shot(page, "p6-nudge");
  await axe(page);
  const put = page.waitForRequest(
    (r) => r.method() === "PUT" && r.url().endsWith("/me/notification-prefs"),
  );
  await nudge.getByRole("button", { name: "Turn on" }).click();
  expect((await put).postDataJSON().needsYou.browser).toBe(true);
  await expect(nudge).toHaveCount(0);
});
