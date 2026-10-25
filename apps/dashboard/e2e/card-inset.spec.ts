// Settings → Agents cards own their inset: every child starts at the card's
// content edge (Design: --oa-space-5, --oa-space-4 at <= 600px), nothing
// pokes past it, and the page never scrolls sideways.
import { expect, type Page, test } from "@playwright/test";

const inset = (width: number) =>
  width <= 600 ? "--oa-space-4" : "--oa-space-5";

/** Inset children whose left edge isn't the card's content edge, or that
    overflow the card. */
const misaligned = (page: Page, token: string) =>
  page.evaluate((token) => {
    const bad: string[] = [];
    const want = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(token),
    );
    const inset = [
      "[data-slot=card-header] > :first-child",
      "[data-slot=card-content] > *",
      "[data-slot=tabs-list]",
      "[data-slot=tabs-content]:not([hidden]) > *",
      "li > b",
    ].join(",");
    for (const card of document.querySelectorAll<HTMLElement>(
      "#oa-main [data-slot=card]",
    )) {
      const r = card.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(card).borderLeftWidth);
      const left = r.left + border + want;
      const right = r.right - border - want;
      for (const el of card.querySelectorAll(inset)) {
        const b = el.getBoundingClientRect();
        if (!b.width) continue;
        const name = `${card.textContent?.slice(0, 20)} ${el.tagName}.${el.getAttribute("data-slot") ?? el.className}`;
        if (Math.abs(b.left - left) > 0.5)
          bad.push(`${name} left ${b.left} != ${left}`);
        if (b.right > right + 0.5)
          bad.push(`${name} right ${b.right} > ${right}`);
      }
      // Header and content own the padding, so only what they hold counts.
      for (const el of card.querySelectorAll(
        "[data-slot=card-header] *, [data-slot=card-content] *",
      )) {
        // Content of a scroller (tab strip, code block) is clipped, not overflowing.
        let scrolled = false;
        for (let p = el.parentElement; p && p !== card; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== "visible") scrolled = true;
        const b = el.getBoundingClientRect();
        if (!scrolled && b.width && b.right > right + 0.5)
          bad.push(`${el.tagName} past the card's content edge`);
      }
    }
    return bad;
  }, token);

const sideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

for (const width of [1280, 390]) {
  test(`Agents cards inset every child at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/agents");
    await expect(page.getByRole("radio", { name: "OAuth" })).toBeVisible();
    expect(await misaligned(page, inset(width))).toEqual([]);
    expect(await sideScroll(page)).toBe(0);

    // Copy URL shares the input's row.
    const input = await page
      .getByRole("textbox", { name: "MCP server URL" })
      .boundingBox();
    const copy = await page
      .getByRole("button", { name: "Copy URL" })
      .boundingBox();
    expect(input && copy).toBeTruthy();
    if (input && copy) {
      expect(
        Math.abs(copy.y + copy.height / 2 - (input.y + input.height / 2)),
      ).toBeLessThan(1);
      expect(copy.x).toBeGreaterThan(input.x + input.width);
    }

    // The snippet's Copy button sits beside the code, not over it.
    const pre = await page.locator("pre").first().boundingBox();
    const btn = await page
      .getByRole("button", { name: "Copy command" })
      .boundingBox();
    expect((btn?.x ?? 0) >= (pre?.x ?? 0) + (pre?.width ?? 0)).toBe(true);

    // The token variant and the empty states line up too.
    await page.getByRole("radio", { name: "Token" }).click();
    expect(await misaligned(page, inset(width))).toEqual([]);
    // Cursor keeps its tab there, with an OAuth note in place of code.
    await page.getByRole("tab", { name: "Cursor" }).click();
    await expect(
      page.getByText("Cursor signs in with OAuth, so it doesn't need a token."),
    ).toBeVisible();
    expect(await misaligned(page, inset(width))).toEqual([]);
    // The agent's Revoke… is in its ••• menu; the token's is a button.
    await page
      .getByRole("button", { name: "More for Example MCP client" })
      .click();
    await page.getByRole("menuitem", { name: "Revoke…" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();
    await page.getByRole("button", { name: "Revoke laptop" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(page.getByText(/No agents connected yet/)).toBeVisible();
    await expect(page.getByText(/^No tokens/)).toBeVisible();
    expect(await misaligned(page, inset(width))).toEqual([]);
  });

  test(`token-created dialog keeps code and Copy inside at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/agents");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByRole("textbox", { name: "Label" }).fill("ci");
    await page.getByRole("button", { name: "Create" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Copy token" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy save command" }),
    ).toBeVisible();
    const out = await dialog.evaluate((d) => {
      const r = d.getBoundingClientRect();
      return [
        ...d.querySelectorAll('pre, code.block, button[aria-label^="Copy"]'),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter(
          (b) => b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5),
        ).length;
    });
    expect(out).toBe(0);
    expect(await sideScroll(page)).toBe(0);
  });

  test(`other settings pages don't scroll sideways at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/settings/profile",
      "/settings/members",
      "/settings/instance",
      "/settings/usage",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await sideScroll(page), path).toBe(0);
    }
  });
}

test("stacked rows at 390px: name on its own line, meta left, action right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/settings/agents");
  const row = await page.locator("li", { hasText: "laptop" }).evaluate((li) => {
    const box = (el: Element | null) => el?.getBoundingClientRect();
    const name = li.querySelector("b");
    const n = box(name);
    const meta = box(li.querySelector("span"));
    const btn = box(li.querySelector("button"));
    return {
      nowrap: name ? getComputedStyle(name).whiteSpace : "",
      ellipsis: name ? getComputedStyle(name).textOverflow : "",
      gap: Math.round((meta?.top ?? 0) - (n?.bottom ?? 0)),
      sameLine:
        Math.abs(
          (btn?.top ?? 0) +
            (btn?.height ?? 0) / 2 -
            ((meta?.top ?? 0) + (meta?.height ?? 0) / 2),
        ) < 1,
      flushRight:
        Math.abs((btn?.right ?? 0) - li.getBoundingClientRect().right) < 0.5,
    };
  });
  expect(row).toMatchObject({
    nowrap: "nowrap",
    ellipsis: "ellipsis",
    sameLine: true,
    flushRight: true,
  });
  expect(row.gap).toBeGreaterThanOrEqual(8);
});

/** The client tab strip: the active underline drawn and unclipped, and
    whether each tab sits inside the strip's visible box. */
const strip = (page: Page) =>
  page
    .getByRole("tablist")
    .first()
    .evaluate((list) => {
      const l = list.getBoundingClientRect();
      const tabs = [...list.querySelectorAll<HTMLElement>("[role=tab]")];
      const active = tabs.find((t) => t.dataset.state === "active");
      const after = active ? getComputedStyle(active, "::after") : null;
      const a = active?.getBoundingClientRect();
      return {
        active: active?.textContent,
        underline: {
          opacity: after?.opacity,
          bottom: after?.bottom,
          height: after?.height,
          painted: after?.backgroundColor !== "rgba(0, 0, 0, 0)",
          inside: !!a && a.bottom <= l.bottom + 0.5 && a.top >= l.top - 0.5,
        },
        inView: Object.fromEntries(
          tabs.map((t) => {
            const b = t.getBoundingClientRect();
            return [
              t.textContent,
              b.left >= l.left - 0.5 && b.right <= l.right + 0.5,
            ];
          }),
        ),
      };
    });

for (const width of [1280, 390])
  for (const theme of ["light", "dark"])
    test(`client tabs at ${width}px ${theme}: underline, focus ring, scroll into view`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/agents");
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      const tabs = page.getByRole("tablist").first().getByRole("tab");
      await expect(tabs.first()).toHaveAttribute("data-state", "active");

      // (a) The active underline is drawn, at the strip's bottom edge.
      const s = await strip(page);
      expect(s.underline).toEqual({
        opacity: "1",
        bottom: "0px",
        height: "2px",
        painted: true,
        inside: true,
      });

      // (b) The keyboard focus ring is inset, so the scrolling strip can't
      // clip it. Polled: the trigger transitions its outline.
      await tabs.first().focus();
      await page.keyboard.press("ArrowRight");
      const second = tabs.nth(1);
      await expect(second).toBeFocused();
      await expect
        .poll(() =>
          second.evaluate((t) => {
            const c = getComputedStyle(t);
            const w = parseFloat(c.outlineWidth);
            return (
              t.matches(":focus-visible") &&
              c.outlineStyle === "solid" &&
              w > 0 &&
              parseFloat(c.outlineOffset) <= -w
            );
          }),
        )
        .toBe(true);

      // (c) A picked tab scrolls into view, by keyboard and by click.
      const inView = async (tab: typeof tabs) => {
        await expect(tab).toHaveAttribute("data-state", "active");
        await expect(tab).toBeFocused();
        await expect
          .poll(async () => {
            const st = await strip(page);
            return st.inView[st.active ?? ""];
          })
          .toBe(true);
      };
      await page.keyboard.press("End");
      await inView(tabs.last());
      await page.keyboard.press("Home");
      await inView(tabs.first());
      await tabs.last().click();
      await inView(tabs.last());
      await expect
        .poll(async () => (await strip(page)).underline.opacity)
        .toBe("1");
    });

test("settings keep a 24px gutter at 800px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/settings/agents");
  await expect(page.locator("[data-slot=card]").first()).toBeVisible();
  const g = await page.evaluate(() => {
    const main = document.getElementById("oa-main")?.getBoundingClientRect();
    const card = document
      .querySelector("[data-slot=card]")
      ?.getBoundingClientRect();
    return {
      left: (card?.left ?? 0) - (main?.left ?? 0),
      right: (main?.right ?? 0) - (card?.right ?? 0),
    };
  });
  expect(g.left).toBeGreaterThanOrEqual(24);
  expect(g.right).toBeGreaterThanOrEqual(24);
});
