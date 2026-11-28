// Red-line port (later.spec.ts "#766: Delete an artifact, find it in Trash,
// and restore it"): the same flow against the real server, so the staging
// copy can go. Delete from the viewer menu (the API then answers 404), find
// it in Trash, Restore, and it is no longer deleted. Tagged @smoke so it
// runs on every pull request, not only in the merge queue.
import { type ArtifactSummary, R } from "@oa/shared";
import { APP, expect, publishViaApi, test, uniq } from "./fixtures";

test("#766: delete from the viewer, find it in Trash, Restore", {
  tag: "@smoke",
}, async ({ page, member }) => {
  const title = `Trash ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "html",
    content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  });
  const get = () =>
    fetch(`${APP}${R.artifact(id)}`, {
      headers: { authorization: `Bearer ${member.pat}` },
    });

  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete artifact?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect.poll(async () => (await get()).status).toBe(404);

  await page.goto("/");
  const trash = page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Trash" });
  await expect(trash).toBeVisible();
  await trash.click();
  const list = page.getByRole("list", { name: "Deleted artifacts" });
  await expect(
    list.getByRole("listitem").filter({ hasText: title }),
  ).toBeVisible();
  await list.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText(/^Restored/).first()).toBeVisible();
  await expect(list.getByText(title)).toHaveCount(0);

  const back = await get();
  expect(back.status).toBe(200);
  expect(((await back.json()) as ArtifactSummary).deletedAt).toBeNull();
});

test("bulk Delete identifies public links and moves both selections to Trash", async ({
  page,
  member,
}) => {
  const titles = [`Private ${uniq()}`, `Public ${uniq()}`];
  const pages = await Promise.all(
    titles.map((title, i) =>
      publishViaApi(member.pat, {
        title,
        format: "markdown",
        content: "# Test",
        visibility: i === 0 ? "private" : "public",
      }),
    ),
  );
  await page.goto("/mine?view=list");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const title of titles)
    await page
      .getByRole("checkbox", { name: `Select ${title}`, exact: true })
      .check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete 2 artifacts?" });
  await expect(dialog).toContainText("1 public link stops working");
  await expect(dialog).toContainText(`/a/${pages[1]?.id}`);
  await dialog.getByRole("button", { name: "Delete 2" }).click();
  await expect(
    page.getByText("2 artifacts moved to Trash.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Trash" })
    .click();
  const trash = page.getByRole("list", { name: "Deleted artifacts" });
  for (const title of titles)
    await expect(
      trash.getByRole("button", { name: `Restore ${title}`, exact: true }),
    ).toBeVisible();
});
