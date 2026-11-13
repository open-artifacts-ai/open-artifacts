// #2317: @-mentions that notify show as pills behind the comment box text.
// COMPOSER_PILLS_SHOTS_DIR saves the PNGs.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.COMPOSER_PILLS_SHOTS_DIR;

async function open(page: Page, width: number, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/a/${ID}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const box = page.getByRole("textbox", { name: /Comment on/ }).first();
  await box.click();
  return box;
}

// Mirror and textarea agree on size and wrapping; each pill sits where the
// same text sits in the textarea (measured with a Range on a clone).
async function aligned(page: Page) {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(
      "textarea[data-oa-field]",
    ) as HTMLTextAreaElement;
    const mirror = ta.parentElement?.querySelector<HTMLElement>(
      "[data-oa-mirror]",
    ) as HTMLElement;
    const inner = mirror.firstElementChild as HTMLElement;
    const m = mirror.getBoundingClientRect();
    const t = ta.getBoundingClientRect();
    // A probe div styled like the textarea, to find where text really lands.
    const cs = getComputedStyle(ta);
    const probe = document.createElement("div");
    for (const k of [
      "fontFamily",
      "fontSize",
      "lineHeight",
      "letterSpacing",
      "paddingTop",
      "paddingLeft",
      "borderTopWidth",
      "borderLeftWidth",
    ] as const)
      probe.style[k] = cs[k];
    probe.style.cssText += `;position:absolute;left:${t.left}px;top:${t.top}px;width:${t.width}px;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;padding-right:${cs.paddingRight};visibility:hidden`;
    probe.textContent = `${ta.value}​`;
    document.body.append(probe);
    const bar = ta.offsetWidth - ta.clientWidth - 2;
    const pills = [...mirror.querySelectorAll("[data-oa-pill]")].map((p) => {
      const r = p.getBoundingClientRect();
      return { top: r.top + ta.scrollTop, left: r.left, h: r.height };
    });
    probe.remove();
    return {
      mw: Math.round(m.width),
      tw: Math.round(t.width),
      mh: mirror.scrollHeight,
      th: ta.scrollHeight,
      shift: Math.round(
        new DOMMatrix(getComputedStyle(inner).transform).m42 + ta.scrollTop,
      ),
      bar,
      pills,
    };
  });
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`composer pills at ${width}px ${theme}`, async ({ page }) => {
      const box = await open(page, width, theme);
      await box.pressSequentially("@Claude Code hello @nobody");
      await expect(page.locator("[data-oa-pill]")).toHaveCount(1);
      await expect(page.locator("[data-oa-pill]")).toHaveText("@Claude Code");
      const a = await aligned(page);
      expect(a.mw).toBe(a.tw);
      expect(a.mh).toBe(a.th);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await box.screenshot({
          path: `${OUT}/pills-${width}-${theme}.png`,
        });
      }

      // Long, wrapped, scrolled to the bottom: still aligned.
      await box.fill("");
      await box.pressSequentially(
        "@Claude Code ".concat("lorem ipsum dolor sit amet ".repeat(30)),
        { delay: 0 },
      );
      await box.pressSequentially(" and @OA Manager-2 end");
      await box.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const b = await aligned(page);
      expect(b.mw).toBe(b.tw);
      expect(b.mh).toBe(b.th);
      const ta = await box.evaluate((el: HTMLTextAreaElement) => ({
        top: el.scrollTop,
        scrolls: el.scrollHeight > el.clientHeight,
      }));
      expect(ta.scrolls).toBe(true);
      // The mirror's inner layer follows the field's scroll.
      await expect.poll(async () => (await aligned(page)).shift).toBe(0);
      if (OUT)
        await box.screenshot({
          path: `${OUT}/pills-wrapped-scrolled-${width}-${theme}.png`,
        });

      // Atomic backspace: caret right after the pill, then Backspace; undo restores it.
      await box.fill("");
      await box.pressSequentially("hi @Claude Code");
      await expect(page.locator("[data-oa-pill]")).toHaveCount(1);
      await page.keyboard.press("Backspace");
      await expect(box).toHaveValue("hi ");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(box).toHaveValue("hi @Claude Code");
    });
