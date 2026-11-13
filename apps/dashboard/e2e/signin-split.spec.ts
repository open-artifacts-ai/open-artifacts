import { expect, test } from "@playwright/test";

const SUNKEN = { light: "rgb(236, 238, 241)", dark: "rgb(24, 26, 30)" };
const DIVIDER = { light: "rgb(224, 227, 232)", dark: "rgb(44, 48, 55)" };

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test("split at 1280", async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/sign-in");
      const q = (sel: string, ...props: string[]) =>
        page.locator(sel).evaluate((el, ps) => {
          const cs = getComputedStyle(el);
          return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
        }, props);
      const brand = (await page.locator(".oa-split-brand").boundingBox())!;
      const form = (await page.locator(".oa-split-form").boundingBox())!;
      expect(brand).toMatchObject({ x: 0, y: 0, width: 640, height: 800 });
      expect(form).toMatchObject({ x: 640, y: 0, width: 640, height: 800 });

      expect(await q(".oa-split", "font-size")).toEqual({
        "font-size": "15px",
      });
      expect(
        await q(
          ".oa-split-brand",
          "background-color",
          "border-right-width",
          "border-right-color",
          "padding-top",
          "padding-left",
          "overflow",
        ),
      ).toEqual({
        "background-color": SUNKEN[scheme],
        "border-right-width": "1px",
        "border-right-color": DIVIDER[scheme],
        "padding-top": "40px",
        "padding-left": "56px",
        overflow: "hidden",
      });
      const logo = page.locator(".oa-split-logo img:visible");
      await expect(logo).toHaveCount(1);
      expect((await logo.boundingBox())!.height).toBe(26);

      expect(
        await q(
          ".oa-split-pitch h2",
          "font-size",
          "line-height",
          "font-weight",
          "letter-spacing",
          "margin-bottom",
        ),
      ).toEqual({
        "font-size": "32px",
        "line-height": "36.8px",
        "font-weight": "600",
        "letter-spacing": "-0.8px",
        "margin-bottom": "12px",
      });
      expect(await q(".oa-split-pitch p", "font-size")).toEqual({
        "font-size": "16px",
      });
      expect(
        (await page.locator(".oa-split-pitch").boundingBox())!.width,
      ).toBeLessThanOrEqual(400);
      expect(await q(".oa-split-foot", "font-size")).toEqual({
        "font-size": "13px",
      });

      // Watermark: bare mark, 360px, offset -90px, faint, decorative.
      const mark = page.locator(".oa-split-mark");
      await expect(mark).toHaveAttribute("aria-hidden", "true");
      expect(
        await q(".oa-split-mark", "opacity", "right", "bottom", "position"),
      ).toEqual({
        opacity: "0.08",
        right: "-90px",
        bottom: "-90px",
        position: "absolute",
      });
      expect(await mark.boundingBox()).toMatchObject({
        width: 360,
        height: 360,
      });

      // Form.
      const fm = (await page.locator(".oa-split-formmark").boundingBox())!;
      expect(fm.width).toBe(40);
      expect(fm.height).toBe(40);
      const h1 = (await page.locator(".oa-split-formbox h1").boundingBox())!;
      expect(h1.y - (fm.y + fm.height)).toBe(20);
      expect(
        await q(".oa-split-formbox h1", "font-size", "font-weight"),
      ).toEqual({ "font-size": "24px", "font-weight": "600" });
      expect(
        await q(".oa-split-sub", "font-size", "margin-top", "margin-bottom"),
      ).toEqual({
        "font-size": "15px",
        "margin-top": "8px",
        "margin-bottom": "28px",
      });
      const btn = (await page.locator(".oa-split-btn").boundingBox())!;
      expect(btn.height).toBe(46);
      expect(btn.width).toBe(360);
      expect(await q(".oa-split-btn", "border-top-left-radius")).toEqual({
        "border-top-left-radius": "8px",
      });
      expect(
        (await page.locator(".oa-split-btn svg").boundingBox())!,
      ).toMatchObject({ width: 18, height: 18 });
      expect(
        await q(
          ".oa-split-formbox .oa-note",
          "font-size",
          "margin-top",
          "padding-top",
          "border-top-width",
        ),
      ).toEqual({
        "font-size": "13px",
        "margin-top": "28px",
        "padding-top": "16px",
        "border-top-width": "1px",
      });
      // Content is vertically centred in the right column.
      const box = (await page.locator(".oa-split-formbox").boundingBox())!;
      expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThan(8);
      await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`signin-${scheme}-1280.png`),
      });
    });

    test("header strip at 390", async ({ page }, info) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/sign-in");
      const brand = (await page.locator(".oa-split-brand").boundingBox())!;
      const form = (await page.locator(".oa-split-form").boundingBox())!;
      expect(brand.width).toBe(390);
      expect(brand.height).toBeGreaterThan(130);
      expect(brand.height).toBeLessThan(200);
      expect(form.y).toBeGreaterThanOrEqual(brand.y + brand.height - 1);
      await expect(page.locator(".oa-split-mark")).toBeHidden();
      await expect(page.locator(".oa-split-formmark")).toBeHidden();
      await expect(page.locator(".oa-split-foot")).toBeHidden();
      const cs = (sel: string, p: string) =>
        page
          .locator(sel)
          .evaluate((el, k) => getComputedStyle(el)[k as never], p);
      expect(await cs(".oa-split-pitch h2", "fontSize")).toBe("22px");
      expect(await cs(".oa-split-pitch p", "fontSize")).toBe("14px");
      expect(await cs(".oa-split-brand", "paddingTop")).toBe("20px");
      expect(await cs(".oa-split-brand", "paddingBottom")).toBe("24px");
      expect(await cs(".oa-split-brand", "borderBottomWidth")).toBe("1px");
      expect(await cs(".oa-split-brand", "borderRightWidth")).toBe("0px");
      expect(await cs(".oa-split-form", "alignItems")).toBe("flex-start");
      expect(await cs(".oa-split-form", "paddingTop")).toBe("32px");
      const sw = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(sw).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: info.outputPath(`signin-${scheme}-390.png`),
      });
    });
  });
}
