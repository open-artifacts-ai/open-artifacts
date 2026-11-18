import { expect, publishViaApi, test, uniq } from "./fixtures";

test("published artifacts appear; format filter and search narrow them", {
  tag: "@smoke",
}, async ({ page, member }) => {
  const tag = uniq();
  const notes = `Notes ${tag}`;
  const script = `Script ${tag}`;
  const site = `Site ${tag}`;
  await publishViaApi(member.pat, {
    title: notes,
    format: "markdown",
    content: `# Notes\n\nkumquat${tag} lives only here.`,
  });
  await publishViaApi(member.pat, {
    title: script,
    format: "code",
    language: "python",
    content: "print('hello')\n",
  });
  await publishViaApi(member.pat, {
    title: site,
    format: "html",
    content: "<h1>Site</h1>",
  });
  const link = (name: string) => page.getByRole("link", { name, exact: true });

  await page.goto("/");
  for (const t of [notes, script, site]) await expect(link(t)).toBeVisible();

  await page
    .getByRole("radiogroup", { name: "Format" })
    .getByRole("radio", { name: "Markdown" })
    .click();
  await expect(page).toHaveURL(/format=markdown/);
  await expect(link(notes)).toBeVisible();
  await expect(link(script)).toHaveCount(0);
  await expect(link(site)).toHaveCount(0);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(link(script)).toBeVisible();

  // Indexing is async (contract C3): reload the results page until the hit lands.
  await page
    .getByRole("searchbox", { name: "Search artifacts" })
    .fill(`kumquat${tag}`);
  await expect(page).toHaveURL(/\/search\?q=kumquat/);
  await expect(async () => {
    await page.reload();
    await expect(link(notes)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(link(script)).toHaveCount(0);
  await expect(link(site)).toHaveCount(0);
});
