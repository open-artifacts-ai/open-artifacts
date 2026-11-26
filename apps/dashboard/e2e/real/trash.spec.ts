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
    .getByRole("navigation", { name: "Trash" })
    .getByRole("link");
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
