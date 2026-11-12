// A phone comments sheet has no gray band under its last card (user report on
// iPhone Safari): the scroller reaches the sheet's bottom with and without
// the keyboard, a composer opened and closed, or a keyboard opened and closed.
import { mkdirSync } from "node:fs";
import { devices, expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const OUT = process.env.SHEET_BAND_SHOTS_DIR;
const { defaultBrowserType: _d, ...phone } = devices["iPhone 14"];

test.use({
  ...phone,
  colorScheme: process.env.SHEET_BAND_DARK ? "dark" : "light",
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

test.beforeEach(({ page }) =>
  page.addInitScript(() => {
    (window as unknown as { __siv: number }).__siv = 0;
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) {
      (window as unknown as { __siv: number }).__siv++;
      return was.apply(this, a as []);
    };
  }),
);

const keyboard = (page: Page, px: number) =>
  page.evaluate((px) => {
    const vv = window.visualViewport as VisualViewport;
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    vv.dispatchEvent(new Event("resize"));
  }, px);

/** Gap in px between the sheet's bottom and the scroller's bottom. */
const gap = (page: Page) =>
  page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>("[data-sheet-height]");
    if (!sheet) return { err: "no sheet" };
    let sc: HTMLElement | null = null;
    for (const el of sheet.querySelectorAll<HTMLElement>("*")) {
      const o = getComputedStyle(el).overflowY;
      if (o === "auto" || o === "scroll") {
        sc = el;
        break;
      }
    }
    const s = sheet.getBoundingClientRect();
    const b = sc?.getBoundingClientRect();
    return {
      sheetBottom: s.bottom,
      scrollerBottom: b?.bottom,
      gap: b ? s.bottom - b.bottom : null,
      kb: document.documentElement.style.getPropertyValue("--oa-kb"),
      inner: window.innerHeight,
      vv: window.visualViewport?.height,
      sheetH: s.height,
    };
  });

const shot = async (page: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function open(page: Page) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.locator("[data-sheet-height]")).toBeVisible();
}

const field = (page: Page) =>
  page.getByRole("textbox", { name: "Comment on the whole page" });

/** The sheet ends at the screen's bottom and its scroller at the sheet's. */
async function expectFlush(page: Page, name: string) {
  await page.waitForTimeout(150);
  const g = await gap(page);
  const inner = await page.evaluate(() => window.innerHeight);
  // The sheet's border is 1px; the safe-area inset is inside the scroller.
  expect(g.scrollerBottom, `${name} ${JSON.stringify(g)}`).toBeGreaterThan(
    inner - 3,
  );
  expect(g.sheetBottom, name).toBeGreaterThan(inner - 1);
  // The header (handle, title, close) is in view, not shifted off the top.
  const head = await page
    .locator("[data-comments-header]")
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(head, `${name} header top`).toBeGreaterThanOrEqual(0);
  await expect(
    page.getByRole("button", { name: "Close comments" }),
  ).toBeInViewport();
  await expect(page.locator("[data-sheet-handle]")).toBeInViewport();
}

test("390: no band under the sheet with no keyboard", async ({ page }) => {
  await open(page);
  await expectFlush(page, "open");
  await shot(page, "open");
});

test("390: browser chrome (a viewport gap, no field focused) is not a keyboard", async ({
  page,
}) => {
  await open(page);
  // iOS toolbars can leave the visual viewport ~190px shorter than the layout one.
  await keyboard(page, 190);
  await shot(page, `toolbar-gap${process.env.SHEET_BAND_DARK ? "-dark" : ""}`);
  await expectFlush(page, "toolbar gap");
  await keyboard(page, 0);
  await expectFlush(page, "toolbar gap closed");
});

test("390: after a composer opens and closes", async ({ page }) => {
  await open(page);
  await field(page).focus();
  await field(page).blur();
  await expectFlush(page, "composer closed");
});

test("390: after the keyboard opens and closes", async ({ page }) => {
  await open(page);
  await field(page).focus();
  await keyboard(page, 320);
  await page.waitForTimeout(150);
  const up = await gap(page);
  expect(up.kb).toBe("320px");
  await field(page).blur();
  await keyboard(page, 0);
  await expectFlush(page, "keyboard closed");
  await shot(page, "keyboard-closed");
});

test("390: a keyboard that closes without a viewport resize leaves no band", async ({
  page,
}) => {
  await open(page);
  await field(page).focus();
  await keyboard(page, 320);
  // iOS can drop focus and leave the viewport event unsent: stale 320px.
  await field(page).blur();
  await expectFlush(page, "stale keyboard");
});

test("390: a field focused with a toolbar gap and no keyboard does not lift", async ({
  page,
}) => {
  // The page already has the toolbar gap when the sheet (and a draft's
  // autofocused field) opens: iOS focuses it with no keyboard.
  await page.goto(`/a/${ID}?mock=agents`);
  await keyboard(page, 190);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.locator("[data-sheet-height]")).toBeVisible();
  await field(page).focus();
  await page.waitForTimeout(400);
  expect((await gap(page)).kb).toBe("0px");
  await expectFlush(page, "focused, toolbar gap");
  await shot(page, "focused-toolbar-gap");
  // A real keyboard on top of the chrome still lifts.
  await keyboard(page, 190 + 320);
  await expect.poll(async () => (await gap(page)).kb).toBe("320px");
});

const sheets = (page: Page) => page.locator("[data-sheet-height]");

test("390: × closes the sheet with a field focused and the keyboard up", async ({
  page,
}) => {
  await open(page);
  await field(page).focus();
  await keyboard(page, 320);
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Close comments" }).click();
  await expect(sheets(page)).toHaveCount(0);
});

test("390: a backdrop tap closes the sheet with an empty field focused", async ({
  page,
}) => {
  await open(page);
  await field(page).focus();
  await keyboard(page, 320);
  await page.waitForTimeout(300);
  await page.mouse.click(20, 6);
  await expect(sheets(page)).toHaveCount(0);
});

test("390: Esc closes the sheet with an empty field, and keeps a draft with text", async ({
  page,
}) => {
  await open(page);
  await field(page).focus();
  await page.keyboard.press("Escape");
  await expect(sheets(page)).toHaveCount(0);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await field(page).fill("half a thought");
  await page.keyboard.press("Escape");
  await expect(sheets(page)).toHaveCount(1);
  // × still closes it.
  await page.getByRole("button", { name: "Close comments" }).click();
  await expect(sheets(page)).toHaveCount(0);
});

/** Nothing panned: the document and the visual viewport are at the origin. */
async function expectNoPan(page: Page, name: string) {
  const p = await page.evaluate(() => ({
    y: window.scrollY,
    x: window.scrollX,
    top: window.visualViewport?.offsetTop ?? 0,
  }));
  expect(p, name).toEqual({ y: 0, x: 0, top: 0 });
  // scrollIntoView pans the document and, on iOS, the visual viewport (which
  // Chromium does not): the sheet moves only its own scroller.
  expect(
    await page.evaluate(() => (window as unknown as { __siv: number }).__siv),
    `${name}: scrollIntoView calls`,
  ).toBe(0);
  await expectFlush(page, name);
}

const reply = (page: Page, body: string, last: boolean) =>
  page.evaluate(
    async ({ id, body, last }) => {
      const list = (await (
        await fetch(`/api/v1/artifacts/${id}/comments`)
      ).json()) as { threads: { id: string; status: string }[] };
      const open = list.threads.filter((t) => t.status === "open");
      const t = last ? open.at(-1) : open[0];
      await fetch(`/api/v1/artifacts/${id}/comments/${t?.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mock-as": "agent" },
        body: JSON.stringify({ body }),
      });
    },
    { id: ID, body, last },
  );

for (const last of [false, true]) {
  test(`390: a live reply ${last ? "below" : "above"} pans nothing`, async ({
    page,
  }) => {
    await open(page);
    await reply(page, "Arrived live", last);
    await expect(page.getByText("Arrived live")).toHaveCount(1);
    await page.waitForTimeout(500);
    await expectNoPan(page, `live reply ${last ? "below" : "above"}`);
  });
}

test("390: tapping '1 ask for you' with the sheet open pans nothing", async ({
  page,
}) => {
  await page.goto(`/a/${ID}?mock=asks`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(sheets(page)).toBeVisible();
  const ask = page.getByRole("button", { name: /asks? for you$/ }).first();
  await ask.evaluate((el) => (el as HTMLElement).click());
  await page.waitForTimeout(600);
  await expectNoPan(page, "ask jump");
});
