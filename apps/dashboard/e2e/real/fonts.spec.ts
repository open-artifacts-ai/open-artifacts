// Geist is self-hosted: the dashboard and a Markdown artifact load their
// fonts from our own hosts (the app host and the content host), never from
// Google, and the faces really load.
import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;

test("the dashboard and a Markdown artifact serve Geist from our hosts only", async ({
  page,
  member,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const { id } = await publishViaApi(member.pat, {
    title: `Fonts ${uniq()}`,
    format: "markdown",
    content: "# Fonts\n\nBody text and `mono`.",
  });
  await page.goto(`/a/${id}`);
  await expect(
    artifactFrame(page).getByRole("heading", { level: 1, name: "Fonts" }),
  ).toBeVisible();

  // The shell's font loads (Geist is the UI face), from the app host.
  await page.evaluate(() => document.fonts.load('500 14px "Geist"'));
  expect(
    await page.evaluate(() => document.fonts.check('500 14px "Geist"')),
  ).toBe(true);
  // The Markdown renderer's, inside the sandboxed frame, from the content host.
  const frame = artifactFrame(page);
  await frame.locator("body").evaluate(() => document.fonts.ready);
  await frame
    .locator("body")
    .evaluate(() => document.fonts.load('400 16px "Geist"'));
  expect(
    await frame
      .locator("body")
      .evaluate(() => document.fonts.check('400 16px "Geist"')),
  ).toBe(true);

  const fonts = requests.filter((u) => /\.woff2(\?|$)/.test(u));
  expect(fonts.length).toBeGreaterThan(0);
  expect(requests.filter((u) => GOOGLE.test(u))).toEqual([]);
  // Every font request is to an origin we serve: the app or the content host.
  const hosts = new Set(fonts.map((u) => new URL(u).hostname));
  for (const h of hosts) expect(h).toMatch(/(^|\.)localhost$/);
});
