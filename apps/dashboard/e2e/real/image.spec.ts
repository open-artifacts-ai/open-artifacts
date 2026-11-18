import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

// The image format against the real server: the entry decodes as one <img>
// in the content frame, and an SVG is never inlined (so its script never runs).

// A 2x2 red PNG, valid to the byte (CRCs and zlib checksum): WebKit on Linux
// refuses a corrupt one where Chromium is lenient.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";
const decoded = (page: import("@playwright/test").Page) =>
  artifactFrame(page)
    .locator(".oa-image img")
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });

test("a PNG opens as an image", { tag: "@smoke" }, async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Image ${uniq()}`,
    format: "image",
    files: { "dot.png": { base64: PNG } },
    entry: "dot.png",
  });
  await page.goto(`/a/${id}`);
  expect(await decoded(page)).toEqual([2, 2]);
  await expect(artifactFrame(page).locator(".oa-code")).toHaveCount(0);
});
