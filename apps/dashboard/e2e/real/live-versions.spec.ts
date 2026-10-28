import { R } from "@oa/shared";
import type { Page, WebSocket } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// Live version updates against the real server: the R.events socket tells
// an open viewer about a new version in about 2 s. Untouched, it swaps in
// (option B); touched, the chip.
const page1 = (n: number) =>
  `<!doctype html><h1 id="v">version ${n}</h1><input id="note" aria-label="Note">`;

/**
 * Resolves on the R.events hello for `id`: from then on the viewer hears about
 * new versions. Call it before the goto, so the socket can't open unseen.
 */
const helloOn = (page: Page, id: string) =>
  new Promise<void>((resolve) => {
    const onSocket = (ws: WebSocket) => {
      if (!ws.url().includes(R.events(id))) return;
      ws.on("framereceived", ({ payload }) => {
        try {
          if (JSON.parse(String(payload)).type !== "hello") return;
        } catch {
          return;
        }
        page.off("websocket", onSocket);
        resolve();
      });
    };
    page.on("websocket", onSocket);
  });

/**
 * The cross-fade has finished: one frame left. artifactFrame() is strict, so
 * reading it while the old frame fades out fails on two elements.
 */
const swapped = (page: Page) =>
  expect(page.locator("iframe.oa-vframe")).toHaveCount(1, { timeout: 15_000 });

const publishVersion = (pat: string, id: string, n: number) =>
  fetch(`${APP}${R.versions(id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, format: "html", content: page1(n) }),
  }).then((r) => {
    expect(r.ok).toBe(true);
  });

test("publish v2 while v1 is open: it swaps in within about 2 s", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: page1(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  await publishVersion(member.pat, id, 2);
  // A generous deadline, not the 2 s target: CI runners are slower.
  await expect(page.getByText("Updated to v2")).toBeVisible({
    timeout: 15_000,
  });
  await swapped(page);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 2");
  await expect(
    page.getByRole("button", { name: "Version: v2 · Current" }),
  ).toBeVisible();
});

test("touched (typed in the frame): the chip, and the typing survives", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: page1(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}/full`);
  const frame = artifactFrame(page);
  await expect(frame.locator("#v")).toHaveText("version 1");
  await frame.locator("#note").fill("half typed");
  await hello;
  await publishVersion(member.pat, id, 2);
  await expect(
    page.getByRole("button", { name: "View version 2" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator("#note")).toHaveValue("half typed");
  await page.getByRole("button", { name: "View version 2" }).click();
  // The chip stays until the preloaded frame has swapped in.
  await expect(
    page.getByRole("button", { name: "View version 2" }),
  ).toHaveCount(0);
  await swapped(page);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 2");
});

// Option C: scrolling and the side panel no longer hold a live version back,
// and the swap keeps the reader's place. A click still shows the chip.
const LONG = (n: number) =>
  `<!doctype html><h1 id="v">version ${n}</h1>${Array.from(
    { length: 200 },
    (_, i) => `<p id="p${i}">paragraph ${i} of version ${n}</p>`,
  ).join("")}`;
const publishLong = (pat: string, id: string, n: number) =>
  fetch(`${APP}${R.versions(id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, format: "html", content: LONG(n) }),
  }).then((r) => {
    expect(r.ok).toBe(true);
  });
const frameScroll = (page: import("@playwright/test").Page) =>
  artifactFrame(page)
    .locator("body")
    .evaluate(() => Math.round(window.scrollY));
/**
 * The frame's scroll offset once it has stopped moving: WebKit on Linux (CI)
 * animates a wheel scroll, so a read right after it can land mid-animation.
 */
const settledScroll = async (page: import("@playwright/test").Page) => {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 50 && same < 3; i++) {
    const y = await frameScroll(page);
    same = y === last ? same + 1 : 0;
    last = y;
    await page.waitForTimeout(100);
  }
  return last;
};

test("scrolled, then a new version: it swaps and keeps the place", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: LONG(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  const box = await page.locator("iframe.oa-vframe").boundingBox();
  if (!box) throw new Error("no frame");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => frameScroll(page)).toBeGreaterThan(1000);
  // Where the wheel scroll ended, not a frame of its animation.
  const before = await settledScroll(page);
  await page.waitForTimeout(400); // the throttled report reaches the shell
  await publishLong(member.pat, id, 2);
  await expect(page.getByText("Updated to v2")).toBeVisible({
    timeout: 15_000,
  });
  await swapped(page);
  await expect(artifactFrame(page).locator("#p0")).toHaveText(
    "paragraph 0 of version 2",
  );
  // The restore may retry while the page lays out: wait until it lands.
  await expect
    .poll(async () => Math.abs((await settledScroll(page)) - before))
    .toBeLessThanOrEqual(2);
  await expect(page.locator(".oa-lchip")).toHaveCount(0);
});

test("the side panel open: a new version still swaps", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: LONG(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}?panel=open&tab=versions`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  await publishLong(member.pat, id, 2);
  await expect(page.getByText("Updated to v2")).toBeVisible({
    timeout: 15_000,
  });
  await swapped(page);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 2");
  await expect(
    page.getByRole("complementary", { name: "Side panel" }),
  ).toBeVisible();
  // Design: a brief note, no Undo; about 3 s later the chip is back to normal.
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
  await expect(page.getByText("Updated to v2")).toHaveCount(0, {
    timeout: 5_000,
  });
  await expect(
    page.getByRole("button", { name: "Version: v2 · Current" }),
  ).toBeVisible();
});

test("text selected in the frame: the chip, not a swap", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: LONG(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  // A selection made without a click or key (the runtime reports it).
  await artifactFrame(page)
    .locator("#p2")
    .evaluate((p) => {
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection()?.addRange(r);
    });
  await page.waitForTimeout(300);
  await publishLong(member.pat, id, 2);
  await expect(page.locator(".oa-lchip")).toContainText("v2 available", {
    timeout: 5_000,
  });
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
});

test("clicked inside: still the chip", async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: LONG(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  await artifactFrame(page).locator("#p3").click();
  await publishLong(member.pat, id, 2);
  await expect(page.locator(".oa-lchip")).toContainText("v2 available", {
    timeout: 5_000,
  });
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
});

// #542 follow-ups (prod 0.43.0): 80 rows of 60px, as the manager's repro.
const ROWS = (n: number, rows = 80) =>
  `<!doctype html><style>body{margin:0}.r{height:60px;box-sizing:border-box;border-bottom:1px solid #ccc}</style><h1 id="v" style="height:60px;margin:0">version ${n}</h1>${Array.from(
    { length: rows },
    (_, i) => `<div class="r" id="r${i}">row ${i} · v${n}</div>`,
  ).join("")}`;
const publishRows = (pat: string, id: string, n: number, rows = 80) =>
  fetch(`${APP}${R.versions(id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, format: "html", content: ROWS(n, rows) }),
  }).then((r) => {
    expect(r.ok).toBe(true);
  });
/** The swap to v<n> has settled: announced, and the old frame faded out. */
const settled = async (page: import("@playwright/test").Page, n: number) => {
  await expect(page.getByText(`Updated to v${n}`)).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.locator("iframe.oa-vframe")).toHaveCount(1, {
    timeout: 5_000,
  });
};

test("row 52, v2 swaps in, then the panel opens and v3 lands on row 52 too", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Rows ${uniq()}`,
    format: "html",
    content: ROWS(1),
  });
  const hello = helloOn(page, id);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  // Row 52 (60px rows under a 60px heading).
  await artifactFrame(page)
    .locator("body")
    .evaluate(() => window.scrollTo(0, 60 + 52 * 60));
  await page.waitForTimeout(400);
  await publishRows(member.pat, id, 2);
  await settled(page, 2);
  await expect.poll(() => frameScroll(page)).toBe(60 + 52 * 60);
  await page.getByRole("button", { name: /^Version: v2/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Side panel" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await publishRows(member.pat, id, 3);
  await settled(page, 3);
  await expect.poll(() => frameScroll(page)).toBe(60 + 52 * 60);
});

test("a new artifact's first load starts at the top", async ({
  page,
  member,
}) => {
  // Another artifact scrolled to the bottom and live-swapped first, in this tab.
  const { id: a } = await publishViaApi(member.pat, {
    title: `Rows A ${uniq()}`,
    format: "html",
    content: ROWS(1),
  });
  const hello = helloOn(page, a);
  await page.goto(`/a/${a}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  await artifactFrame(page)
    .locator("body")
    .evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await publishRows(member.pat, a, 2);
  await settled(page, 2);
  const { id: b } = await publishViaApi(member.pat, {
    title: `Rows B ${uniq()}`,
    format: "html",
    content: ROWS(1),
  });
  await page.goto(`/a/${b}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await page.waitForTimeout(1_500);
  expect(await frameScroll(page)).toBe(0);
});
