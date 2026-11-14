// #2486: the comments panel between phones and wide windows. One row in the
// top bar, "Comments" and the asks pill once, one box around an ask, a
// one-line new-comment box, and a 720px thread column. 390 and 1280 keep
// their own layouts.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const ID = "Cd5fGhJkLm6nPqRs"; // Landing page, with asks under ?mock=asks

async function open(page: Page, w: number, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: w, height: 800 });
  await page.goto(`/a/${ID}?mock=asks`);
  await expect(page.locator("[data-asks-for-you]")).toHaveCount(1);
}

const commentsButton = (page: Page) =>
  page.getByRole("button", { name: /^Comments/ });
const field = (page: Page) =>
  page.getByRole("textbox", { name: "Comment on the whole page" });
/** The ask Sam Rivera put to the viewer. */
const askCard = (page: Page) =>
  page.locator("[data-thread]", { hasText: "Which layout do we ship?" });

/**
 * Serious and critical axe findings, once nothing is animating. Two
 * label-content-name findings are older than #2486 and show at 1280 too (each
 * card's "Show in page" button and the participants button): skipped here.
 * So are the ask's options: in dark at 760 their muted line reads 4.06:1 on
 * main as well, now and then.
 */
async function axeFindings(page: Page): Promise<string[]> {
  // Off the cards: a hovered option's muted line is a separate, older finding.
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (): Promise<string[]> => {
    const old = (t: string) =>
      /aria-label="Show in page|button\[aria-controls=/.test(t);
    // @ts-expect-error injected
    const res = await axe.run(
      { exclude: [["[data-option]"]] },
      { resultTypes: ["violations"] },
    );
    return (
      res.violations as {
        id: string;
        impact: string;
        nodes: { target: string[] }[];
      }[]
    )
      .filter((x) => x.impact === "serious" || x.impact === "critical")
      .map((x) => ({
        id: x.id,
        nodes: x.nodes
          .map((n) => n.target.join(" "))
          .filter((t) => !(x.id === "label-content-name-mismatch" && old(t))),
      }))
      .filter((x) => x.nodes.length > 0)
      .map((x) => `${x.id}: ${x.nodes.join(" | ")}`);
  });
}

/** Elements with a visible border or ring inside `root` (itself included). */
const boxes = (page: Page, root: string) =>
  page.locator(root).evaluate((el) => {
    const out: string[] = [];
    for (const n of [el, ...el.querySelectorAll<HTMLElement>("*")]) {
      if (n.closest("[data-comment]:not(:first-child)")) continue;
      if (
        n.matches("button, [data-ask-decider], [data-agent-tag], [data-avatar]")
      )
        continue;
      if (n.closest("button")) continue;
      const s = getComputedStyle(n);
      const border =
        parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
      const ring = /\b0px 0px 0px [1-9]/.test(s.boxShadow);
      if (border || ring)
        out.push(n.tagName + (n.dataset.ask !== undefined ? "[data-ask]" : ""));
    }
    return out;
  });

for (const w of [760, 620])
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: one row, Comments and the asks pill once`, async ({
      page,
    }) => {
      await open(page, w, theme);
      // The title and the buttons share one line.
      const title = await page.locator(".oa-vt h1").boundingBox();
      const share = await page
        .getByRole("button", { name: "Share", exact: true })
        .boundingBox();
      expect(title && share).toBeTruthy();
      expect(
        Math.abs(
          (title?.y ?? 0) +
            (title?.height ?? 0) / 2 -
            ((share?.y ?? 0) + (share?.height ?? 0) / 2),
        ),
      ).toBeLessThan(6);
      // "v2", not "v2 · Current"; Full screen is its icon, still named.
      expect(
        await page
          .locator("[data-versions-chip]")
          .evaluate((e) => (e as HTMLElement).innerText.trim()),
      ).toBe("v2");
      await expect(
        page.getByRole("link", { name: "Full screen" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("link", { name: "Full screen" })
          .getByText("Full screen"),
      ).toHaveClass(/sr-only/);
      const label = page
        .locator(".oa-vt")
        .getByText("Comments", { exact: true });
      // #2503: a tight bar gives way (at 620 every step is taken); the name is unchanged.
      if (w < 640) await expect(label).toHaveClass(/sr-only/);
      else await expect(label).toBeVisible();
      await expect(commentsButton(page)).toHaveAccessibleName(
        "Comments, 3 open",
      );

      await commentsButton(page).click();
      await expect(commentsButton(page)).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(askCard(page)).toBeVisible();
      // "Comments" once on screen: the tab with its count, no band.
      await expect(
        page.locator("aside").getByRole("heading", { name: "Comments" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("tab", { name: "Comments, 3 open" }),
      ).toBeVisible();
      await expect(page.locator("[data-tab-count]")).toHaveText("3");
      // The asks pill once: inside the panel, not in the bar.
      await expect(page.locator("[data-asks-for-you]")).toHaveCount(1);
      await expect(page.locator("aside [data-asks-for-you]")).toBeVisible();
      // The Comments button looks pressed.
      const bg = (sel: string) =>
        page.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor);
      await page.mouse.move(0, 0);
      const chip = await bg("[data-versions-chip]");
      await expect
        .poll(() => bg(".oa-vt button[aria-expanded=true]"))
        .not.toBe(chip);
      // One box around the ask: the card, in gold; the ask itself has none.
      expect(
        await boxes(page, `[data-thread]:has-text("Which layout do we ship?")`),
      ).toEqual(["LI"]);
      const card = askCard(page);
      const warn = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--oa-warning")
          .trim(),
      );
      expect(warn).not.toBe("");
      const border = await card.evaluate(
        (e) => getComputedStyle(e).borderTopColor,
      );
      const probe = await page.evaluate((c) => {
        const d = document.createElement("div");
        d.style.color = c;
        document.body.append(d);
        const v = getComputedStyle(d).color;
        d.remove();
        return v;
      }, warn);
      expect(border).toBe(probe);
      // The author line once, with the date; the text starts at the card's edge.
      await expect(card.locator("[data-ask-from]")).toHaveCount(1);
      await expect(card.locator("[data-ask-from]")).toContainText(
        "Sam Rivera asks you · ",
      );
      await expect(card.locator("[data-author-name]")).toHaveCount(0);
      const edge = await card.evaluate((li) => {
        const body = li.querySelector<HTMLElement>("[data-ask-body]");
        return (
          (body?.getBoundingClientRect().left ?? 0) -
          li.getBoundingClientRect().left
        );
      });
      expect(edge).toBeLessThan(20);
      // A reply keeps its face and its indent.
      const reply = page
        .locator("[data-thread]", { hasText: "Agreed, shorter is better." })
        .locator("[data-comment]")
        .nth(1);
      await expect(reply.locator("[data-author-name]")).toHaveText(
        "Ada Lovelace",
      );
      await expect(reply.locator("[data-comment-body]")).toHaveClass(/pl-8/);

      // A one-line box that grows on focus and shrinks back when left empty.
      const box = page.locator("[data-collapsed]");
      await expect(box).toHaveCount(1);
      await expect(page.locator("[data-send-hint]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Comment", exact: true }),
      ).toHaveCount(0);
      await field(page).click();
      await expect(page.locator("[data-collapsed]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Comment", exact: true }),
      ).toBeVisible();
      await expect(page.locator("[data-send-hint]")).toBeVisible();
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("[data-collapsed]")).toHaveCount(1);
      // With words in it, it stays grown when focus leaves.
      await field(page).click();
      await field(page).fill("Looks good");
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("[data-collapsed]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Comment", exact: true }),
      ).toBeEnabled();

      // The asks row sticks: scrolled to the end, the pill is still in view.
      await page
        .locator("aside [data-slot=scroll-area-viewport]")
        .evaluate((e) => {
          e.scrollTop = e.scrollHeight;
        });
      await expect(page.locator("aside [data-asks-for-you]")).toBeInViewport();
      // The thread column stops at 720px and centres.
      const col = await page
        .locator("[data-compact]")
        .evaluate((e) => e.getBoundingClientRect().width);
      expect(col).toBeLessThanOrEqual(720);

      // No sideways scroll, and no serious axe findings.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      const v = await axeFindings(page);
      expect(v, v.join("\n")).toEqual([]);

      // Closed again: the pill is back in the bar.
      await commentsButton(page).click();
      await expect(page.locator(".oa-vt [data-asks-for-you]")).toBeVisible();
    });
  }

test("900: the thread column stops at 720px and centres", async ({ page }) => {
  await open(page, 900, "light");
  await commentsButton(page).click();
  const r = await page.locator("[data-compact]").evaluate((e) => {
    const b = e.getBoundingClientRect();
    const p = (e.closest("aside") as HTMLElement).getBoundingClientRect();
    return { w: b.width, l: b.left - p.left, r: p.right - b.right };
  });
  expect(r.w).toBe(720);
  expect(Math.abs(r.l - r.r)).toBeLessThan(16);
});

for (const w of [390, 1280])
  test(`${w}: unchanged`, async ({ page }) => {
    await open(page, w, "light");
    await commentsButton(page).click();
    await expect(askCard(page)).toBeVisible();
    await expect(page.locator("[data-compact]")).toHaveCount(0);
    await expect(page.locator("[data-collapsed]")).toHaveCount(0);
    // The band (sheet header or column heading) and the ask's own ring stay.
    await expect(page.locator("[data-comments-header]")).toHaveCount(1);
    await expect(askCard(page).locator("[data-ask]")).toHaveClass(/ring-1/);
    await expect(askCard(page).locator("[data-author-name]")).toHaveCount(1);
    if (w === 1280) {
      await expect(page.locator("[data-versions-chip]")).toHaveText(
        "v2 · Current",
      );
      await expect(page.locator(".oa-vt [data-asks-for-you]")).toBeVisible();
    }
  });

// #2503: as the one-row bar runs out of room it gives way in order (Comments
// to its icon, the visibility chip to its lock, the pill to "1 ask"), and the
// title keeps about 10 characters.
async function barState(page: Page) {
  // Two frames: the resize observer, then the layout effects it starts.
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".oa-vt");
    const h1 = bar?.querySelector<HTMLElement>("h1");
    const text = h1?.querySelector("button")?.firstChild ?? h1?.firstChild;
    const r = document.createRange();
    if (text) {
      r.setStart(text, 0);
      r.setEnd(text, Math.min(10, text.textContent?.length ?? 0));
    }
    const sr = (el: Element | null | undefined) =>
      !!el && getComputedStyle(el).position === "absolute";
    const badge = [...(bar?.querySelectorAll("[data-slot=badge]") ?? [])].find(
      (b) => b.textContent?.includes("Restricted"),
    );
    const comments = [...(bar?.querySelectorAll("button span") ?? [])].find(
      (s) => s.textContent === "Comments",
    );
    const pill = bar?.querySelector<HTMLElement>("[data-asks-for-you]");
    return {
      stage: Number(bar?.dataset.barStage),
      over: (bar?.scrollWidth ?? 0) - (bar?.clientWidth ?? 0),
      title: h1?.clientWidth ?? 0,
      ten: r.getBoundingClientRect().width,
      commentsIcon: sr(comments),
      lockIcon: sr(badge?.querySelector("span.sr-only")),
      pill: pill?.innerText.trim(),
      pillName: pill?.getAttribute("aria-label"),
    };
  });
}

for (const theme of ["light", "dark"] as const)
  test(`${theme}: the bar gives way in order and the title keeps ~10 characters`, async ({
    page,
  }) => {
    await open(page, 959, theme);
    const seen = new Map<number, number>();
    const widths = [
      959, 900, 840, 800, 760, 740, 720, 700, 680, 660, 640, 630, 620, 610, 601,
    ];
    for (const w of [...widths, ...[...widths].reverse()]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForFunction((w) => window.innerWidth === w, w);
      const s = await barState(page);
      const at = `${w}px ${JSON.stringify(s)}`;
      // The same width always lands on the same stage, shrinking or growing.
      if (seen.has(w)) expect(s.stage, at).toBe(seen.get(w));
      seen.set(w, s.stage);
      expect(s.over, at).toBeLessThanOrEqual(0);
      expect(s.title, at).toBeGreaterThanOrEqual(Math.floor(s.ten));
      expect(s.commentsIcon, at).toBe(s.stage >= 1);
      expect(s.lockIcon, at).toBe(s.stage >= 2);
      expect(s.pill, at).toBe(s.stage >= 3 ? "1 ask" : "1 ask for you");
      expect(s.pillName, at).toBe("1 ask for you");
    }
    // Narrower never means an earlier stage, and every step is taken somewhere.
    const stages = widths.map((w) => seen.get(w) ?? -1);
    for (let i = 1; i < stages.length; i++)
      expect(stages[i], `${widths[i]}px`).toBeGreaterThanOrEqual(
        stages[i - 1] ?? 0,
      );
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3]));
    // The chip's name stays "Restricted".
    await expect(page.locator(".oa-vt").getByText("Restricted")).toBeAttached();
    // Opening the panel takes the pill out of the bar: Comments has room again.
    await page.setViewportSize({ width: 700, height: 800 });
    await commentsButton(page).click();
    const s = await barState(page);
    expect(s.stage).toBeLessThan(1);
  });
