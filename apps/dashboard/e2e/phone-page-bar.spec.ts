// #2622: the viewer page bar on a 360px phone is two rows in every state, and
// nothing wraps: row one is the back arrow and title, row two the buttons.
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

test.use({ viewport: { width: 360, height: 740 } });

const STATES: [string, string][] = [
  ["owner", `/a/${ID}?mock=asks&asks=0`],
  ["asks waiting", `/a/${ID}?mock=asks`],
  ["older version", `/a/${ID}/v/1`],
  ["member", `/a/${ID}?role=member`],
  ["guest", `/a/${ID}?role=guest`],
  ["signed out", `/a/${ID}?mock=signed-out`],
];

for (const [name, url] of STATES) {
  test(`${name}: two rows, nothing wraps at 360px`, async ({ page }) => {
    await page.goto(url);
    const bar = page.locator(".oa-vt").first();
    await expect(bar.locator("h1, button").first()).toBeVisible();
    // The path row is gone on a phone.
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toBeHidden();
    const m = await bar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const rows = new Set<number>();
      for (const b of el.querySelectorAll("button, a")) {
        const t = b.getBoundingClientRect();
        if (t.width === 0 || t.height === 0) continue;
        rows.add(Math.round(t.top / 10));
      }
      return {
        height: r.height,
        overflow: el.scrollWidth - el.clientWidth,
        rows: rows.size,
        vw: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    // Two rows of 32px controls plus padding: well under three rows.
    expect(m.height).toBeLessThan(100);
    expect(m.overflow).toBeLessThanOrEqual(0);
    expect(m.vw).toBeLessThanOrEqual(0);
    expect(m.rows).toBeLessThanOrEqual(2);
  });
}

test("asks waiting: the Comments button is gold and counts the asks", async ({
  page,
}) => {
  await page.goto(`/a/${ID}?mock=asks`);
  const b = page.getByRole("button", { name: /^\d+ asks? for you$/ });
  await expect(b).toBeVisible();
  await expect(b).toHaveText(/^\d+ asks?\s*$/);
  await expect(page.getByText("No asks for you")).toHaveCount(0);
});

// The widest case: a long title, 12 asks waiting, v115 of 200, a Manager's
// access label (a guest: "Can comment"), Share, the menu and the bell. Nothing
// may clip: every button's right edge stays inside the viewport.
for (const [name, role] of [
  ["member (Manager, Share, bell)", "member"],
  ["guest (Can comment, bell)", "guest"],
] as const) {
  test(`widest case, ${name}: two rows, nothing clipped at 360px`, async ({
    page,
  }) => {
    // The For you mock turns the bell on; asks=1 keeps the page's asks.
    await page.goto(`/a/${ID}/v/115?mock=foryou&asks=1&widest=1&role=${role}`);
    const b = page.getByRole("button", { name: "12 asks for you" });
    await expect(b).toBeVisible();
    await expect(b).toHaveText(/^12 asks\s*$/);
    await expect(
      page.getByRole("button", { name: /^v115, not the latest version$/ }),
    ).toBeVisible();
    const bar = page.locator(".oa-vt").first();
    // The bell is in the bar, and measured with the rest.
    await expect(bar.locator("[data-for-you-bell]")).toBeVisible();
    const m = await bar.evaluate((el) => {
      const rows = new Set<number>();
      let maxRight = 0;
      let minLeft = 9999;
      for (const x of el.querySelectorAll("button, a")) {
        const t = x.getBoundingClientRect();
        if (t.width === 0 || t.height === 0) continue;
        rows.add(Math.round(t.top / 10));
        maxRight = Math.max(maxRight, t.right);
        minLeft = Math.min(minLeft, t.left);
      }
      return {
        height: el.getBoundingClientRect().height,
        rows: rows.size,
        maxRight,
        minLeft,
        vw: window.innerWidth,
        scroll: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(m.height).toBeLessThan(100);
    expect(m.rows).toBeLessThanOrEqual(2);
    expect(m.maxRight).toBeLessThanOrEqual(m.vw);
    expect(m.minLeft).toBeGreaterThanOrEqual(0);
    expect(m.scroll).toBeLessThanOrEqual(0);
    // The title row's own buttons (the back arrow) are inside too.
    for (const btn of await bar.getByRole("button").all()) {
      const box = await btn.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(m.vw);
    }
  });
}
