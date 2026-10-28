import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

// The image format against the real server: the entry decodes as one <img>
// in the content frame, and an SVG is never inlined (so its script never runs).

// A 2x2 red PNG, valid to the byte (CRCs and zlib checksum): WebKit on Linux
// refuses a corrupt one where Chromium is lenient.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>parent.postMessage("svg-ran","*")</script><rect width="40" height="20" fill="#2350d0"/></svg>`;

const decoded = (page: import("@playwright/test").Page) =>
  artifactFrame(page)
    .locator(".oa-image img")
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });

test("a PNG opens as an image", async ({ page, member }) => {
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

test("an SVG opens through <img> only: never inlined, its script never runs", async ({
  page,
  member,
}) => {
  const ran: unknown[] = [];
  await page.exposeFunction("seen", (d: unknown) => ran.push(d));
  await page.addInitScript(() =>
    addEventListener("message", (e) =>
      (window as unknown as { seen: (d: unknown) => void }).seen(e.data),
    ),
  );
  const { id } = await publishViaApi(member.pat, {
    title: `Svg ${uniq()}`,
    format: "image",
    files: { "logo.svg": SVG },
    entry: "logo.svg",
  });
  await page.goto(`/a/${id}`);
  expect(await decoded(page)).toEqual([40, 20]);
  await expect(artifactFrame(page).locator("svg, object, embed")).toHaveCount(
    0,
  );
  expect(ran).not.toContain("svg-ran");
});
