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

test("code shows line numbers", async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Code ${uniq()}`,
    format: "code",
    language: "python",
    content: "a = 1\nb = 2\nprint(a + b)\n",
  });
  await page.goto(`/a/${id}`);
  const lines = artifactFrame(page).locator(".oa-code .line");
  await expect(lines).toHaveCount(3);
  // The gutter is a CSS counter on each line's ::before, invisible to the DOM.
  // Check it is wired per line, then that the painted gutters differ (1, 2, 3).
  const gutters = await lines.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el, "::before");
      return {
        content: cs.content,
        increment: cs.counterIncrement,
        width: Number.parseFloat(cs.width),
      };
    }),
  );
  for (const g of gutters) {
    expect(g.content).toBe("counter(oa-line)");
    expect(g.increment).toMatch(/^oa-line( 1)?$/);
    expect(g.width).toBeGreaterThan(0);
  }
  const shots: string[] = [];
  for (const [i, g] of gutters.entries()) {
    const box = await lines.nth(i).boundingBox();
    if (!box) throw new Error(`line ${i + 1} has no box`);
    const clip = { x: box.x, y: box.y, width: g.width, height: box.height };
    shots.push((await page.screenshot({ clip })).toString("base64"));
  }
  expect(new Set(shots).size).toBe(3);
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
