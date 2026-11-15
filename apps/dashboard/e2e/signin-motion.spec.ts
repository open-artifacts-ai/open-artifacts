import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const masters = [
  "mark.svg",
  "mark-light.svg",
  "mark-dark.svg",
  "mark-on-accent.svg",
  "logo.svg",
  "logo-dark.svg",
].map((name) => ({
  name,
  source: readFileSync(
    new URL(`../../../packages/ui/src/brand/${name}`, import.meta.url),
    "utf8",
  ),
}));

test("standard brand masters have a centered core and four equal gaps", async ({
  page,
}) => {
  await page.goto("/sign-in");
  const boxes = await page.evaluate(
    (assets) =>
      assets.map(({ name, source }) => {
        const doc = new DOMParser().parseFromString(source, "image/svg+xml");
        const accent = doc.querySelectorAll("path")[1]?.getAttribute("d");
        if (!accent) throw new Error(`${name}: missing accent path`);
        const corePath = accent.slice(accent.lastIndexOf("M"));
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        const path = document.createElementNS(
          svg.namespaceURI,
          "path",
        ) as SVGPathElement;
        path.setAttribute("d", corePath);
        svg.style.position = "absolute";
        svg.style.left = "-10000px";
        svg.append(path);
        document.body.append(svg);
        const { x, y, width, height } = path.getBBox();
        svg.remove();
        return {
          name,
          center: [x + width / 2, y + height / 2],
          gaps: [x - 6, y - 6, 26 - x - width, 26 - y - height],
        };
      }),
    masters,
  );
  for (const { name, center, gaps } of boxes) {
    expect(center, name).toEqual([16, 16]);
    expect(gaps, name).toEqual([4, 4, 4, 4]);
  }
});

test("sign-in stays available while formation plays once, then holds", async ({
  page,
}) => {
  await page.route("**/auth/providers", (route) =>
    route.fulfill({
      json: {
        mode: "access",
        hosted: false,
        providers: [{ id: "access", start: "/auth/login" }],
      },
    }),
  );
  await page.clock.install();
  await page.goto("/sign-in");
  const canvas = page.locator(".oa-formation canvas");
  await expect(canvas).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Cloudflare Access" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Cloudflare Access" }),
  ).toHaveAttribute("href", "/auth/login");
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 10);
  await page.clock.runFor(2300);
  await expect(canvas).toBeHidden();
  await expect(page.locator(".oa-formation svg")).toBeVisible();
  await page.clock.runFor(5000);
  await expect(canvas).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Replay logo animation" }),
  ).toHaveCount(0);
});

test("reduced motion stops an active formation on the final mark", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await expect(page.locator(".oa-formation canvas")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".oa-formation canvas")).toBeHidden();
  await expect(page.locator(".oa-formation svg")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Cloudflare Access" }),
  ).toBeVisible();
});

test("provider loading does not move the animation", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/auth/providers")) {
        await new Promise<void>((resolve) => {
          (
            window as Window & { releaseProviders?: () => void }
          ).releaseProviders = resolve;
        });
        return new Response(
          JSON.stringify({
            mode: "access",
            hosted: false,
            providers: [{ id: "access", start: "/auth/login" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(...args);
    };
  });
  await page.goto("/sign-in");
  await page.locator(".oa-formation").waitFor();
  await page.waitForFunction(() => "releaseProviders" in window);
  await page.evaluate(() => document.fonts.ready);
  const loading = await page.locator(".oa-formation").boundingBox();
  await expect(page.getByText("Self-hosted on Cloudflare")).toHaveCount(0);
  await page.evaluate(() => {
    const release = (window as Window & { releaseProviders?: () => void })
      .releaseProviders;
    if (!release) throw new Error("Provider request did not start");
    release();
  });
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const ready = await page.locator(".oa-formation").boundingBox();
  expect(ready).toEqual(loading);
});
