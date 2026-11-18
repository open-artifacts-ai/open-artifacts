import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";
import { minimalPdf } from "./pdf";

test("markdown renders a heading", { tag: "@smoke" }, async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Report ${uniq()}`,
    format: "markdown",
    content: "# Quarterly report\n\nAll good.",
  });
  await page.goto(`/a/${id}`);
  await expect(
    artifactFrame(page).getByRole("heading", {
      level: 1,
      name: "Quarterly report",
    }),
  ).toBeVisible();
});

test("a PDF shows page 1", async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Paper ${uniq()}`,
    format: "pdf",
    files: { "paper.pdf": { base64: minimalPdf("Hello PDF") } },
    entry: "paper.pdf",
  });
  await page.goto(`/a/${id}`);
  const frame = artifactFrame(page);
  const first = frame.locator('.page[data-page-number="1"]');
  await expect(first.locator("canvas")).toBeVisible();
  await expect(first.locator(".textLayer")).toContainText("Hello PDF");
  await expect(frame.locator(".oa-pdf-count")).toHaveText("1");
});

test("HTML runs its script", { tag: "@smoke" }, async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Page ${uniq()}`,
    format: "html",
    content:
      '<!doctype html><p id="out">waiting</p><script>document.getElementById("out").textContent = "script ran";</script>',
  });
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#out")).toHaveText("script ran");
});
