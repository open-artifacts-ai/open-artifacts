import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

test("a public artifact opens logged out", { tag: "@smoke" }, async ({
  browser,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Open ${uniq()}`,
    format: "markdown",
    content: "# Open to all",
    visibility: "public",
  });
  const anon = await browser.newContext({ baseURL: APP });
  const page = await anon.newPage();
  await page.goto(`/a/${id}`);
  await expect(
    artifactFrame(page).getByRole("heading", { name: "Open to all" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${APP}/a/${id}`);
  await anon.close();
});
