import {
  type ArtifactSummary,
  type AuthProviders,
  R,
  type SpaceMembersPage,
} from "@oa/shared";
import {
  A,
  api,
  cleanup,
  expect,
  json,
  liveHtml,
  needs,
  type Person,
  person,
  publish,
  RUN,
  SPACES,
  t19Spaces,
  test,
} from "./fixtures";

// T19 step 4: flows that landed after M1's first RC. Each test names the
// release that ships it and skips until rl-a's /healthz reports that release
// or later, so they run as soon as rl-a is upgraded (CI pins the RC with
// T19_EXPECT_VERSION, which turns a gated skip into a failure). Releases:
// CHANGELOG.md and the v* tags. #800 missed 0.73.0, so it gates on 0.74.0.

const { eng } = SPACES;

/** Manages t19-eng: deletes the run's artifacts there. */
let keeper: Person;

test.beforeAll(async ({ browser }) => {
  const admin = await person(browser, "admin", "admin");
  await t19Spaces(admin);
  keeper = await person(browser, "keeper", "member", [
    { spaceId: eng.id, role: "manager" },
  ]);
});
test.afterAll(cleanup);

const page1 = (title: string, spaceId?: string) => ({
  title,
  format: "html" as const,
  content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  ...(spaceId ? { spaceId } : {}),
});

// A 2x2 red PNG, valid to the byte (as e2e/real/image.spec.ts).
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=";

test("#764: a space manager who isn't an admin adds people", async ({
  browser,
}) => {
  await needs("#764", "0.69.0");
  const mgr = await person(browser, "people-mgr", "member", [
    { spaceId: eng.id, role: "manager" },
  ]);
  const newbie = await person(browser, "newbie", "member");
  const page = mgr.page;
  await page.goto(`/settings/spaces?space=${eng.id}`);
  await expect(
    page.getByRole("heading", { level: 2, name: eng.name }),
  ).toBeVisible();
  const people = page.getByRole("region", { name: "People" });
  await people.getByRole("button", { name: "Add people" }).click();
  const d = page.getByRole("dialog", { name: `Add people to ${eng.name}` });
  await d.getByRole("combobox", { name: "People" }).fill(newbie.email);
  await page.getByRole("option", { name: new RegExp(newbie.name) }).click();
  await d.getByRole("button", { name: "Add 1 person" }).click();
  await expect(d).toHaveCount(0);
  // Search: earlier runs' people can push this one past the first page.
  await people
    .getByRole("searchbox", { name: `Search people in ${eng.name}` })
    .fill(newbie.email);
  await expect(people.getByText(newbie.name)).toBeVisible();

  const q = new URLSearchParams({ q: newbie.email });
  const rows = await json<SpaceMembersPage>(
    await api(keeper, `${R.spaceMembers(eng.id)}?${q}`),
  );
  expect(rows.items).toEqual([
    expect.objectContaining({ userId: newbie.id, manualRole: "viewer" }),
  ]);
  // Leave the fixed space as found, so its People list doesn't grow per run.
  const out = await api(keeper, R.spaceMember(eng.id, newbie.id), {
    method: "DELETE",
  });
  expect([200, 204]).toContain(out.status);
});

test("#765: Mine inside a shared space lists only the caller's artifacts", async ({
  browser,
}) => {
  await needs("#765", "0.72.0");
  const me = await person(browser, "mine", "member", [
    { spaceId: eng.id, role: "editor" },
  ]);
  const other = await person(browser, "theirs", "member", [
    { spaceId: eng.id, role: "editor" },
  ]);
  const mine = `T19 ${RUN} mine`;
  const theirs = `T19 ${RUN} theirs`;
  await publish(me, page1(mine, eng.id), keeper);
  await publish(other, page1(theirs, eng.id), keeper);

  const page = me.page;
  await page.goto(`/?space=${eng.id}`);
  await expect(page.getByRole("link", { name: mine }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: theirs }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Mine" }).click();
  await expect(page.getByRole("link", { name: mine }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: theirs })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: eng.name }),
  ).toBeVisible();
});

test("#766: Trash: delete, find it in Trash, Restore", async ({ browser }) => {
  await needs("#766", "0.73.0");
  const owner = await person(browser, "trash", "member");
  const title = `T19 ${RUN} trash`;
  const { id } = await publish(owner, page1(title));
  const page = owner.page;
  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete artifact?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect
    .poll(async () => (await api(owner, R.artifact(id))).status)
    .toBe(404);

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
  const back = await json<ArtifactSummary>(await api(owner, R.artifact(id)));
  expect(back.deletedAt).toBeNull();
});

test("#783: an image artifact opens as an image", async ({ browser }) => {
  await needs("#783", "0.73.0");
  const owner = await person(browser, "image", "member");
  const { id } = await publish(owner, {
    title: `T19 ${RUN} image`,
    format: "image",
    files: { "dot.png": { base64: PNG } },
    entry: "dot.png",
  });
  const page = owner.page;
  await page.goto(`/a/${id}`);
  const frame = page.frameLocator("iframe.oa-vframe");
  const size = await frame
    .locator(".oa-image img")
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });
  expect(size).toEqual([2, 2]);
  await expect(frame.locator(".oa-code")).toHaveCount(0);
});

// #794 brought the chip to self-hosted installs; on a hosted install it
// already followed can.dataWrite, so this runs on 0.72.0 too.
test("#794: a member who views editors-only live data sees View only", async ({
  browser,
}) => {
  await needs("#794", "0.72.0");
  const owner = await person(browser, "live-owner", "member");
  const viewer = await person(browser, "live-viewer", "member");
  const title = `T19 ${RUN} live`;
  const { id } = await publish(owner, liveHtml(title));
  await json(
    await api(owner, R.shares(id), {
      method: "PUT",
      body: JSON.stringify({ email: viewer.email, role: "viewer" }),
    }),
  );
  const page = viewer.page;
  await page.goto(`/a/${id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  // The owner can write, so no chip for them.
  await owner.page.goto(`/a/${id}`);
  await expect(owner.page.getByText(title).first()).toBeVisible();
  await expect(owner.page.getByText("View only", { exact: true })).toHaveCount(
    0,
  );
});

test("#800: inviting outside the sign-in domain warns that they may not sign in", async ({
  browser,
}) => {
  await needs("#800", "0.74.0");
  const admin = await person(browser, "admin", "admin");
  const providers = await json<AuthProviders>(
    await fetch(`${A.app}/auth/providers`, {
      signal: AbortSignal.timeout(30_000),
    }),
  );
  const google = providers.providers.find((p) => p.id === "google");
  const domains = google && "domains" in google ? google.domains : [];
  expect(domains.length).toBeGreaterThan(0);
  const maybe = `t19-${RUN}-maybe@${A.testDomain}`;

  const page = admin.page;
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Add member" }).click();
  const d = page.getByRole("dialog", { name: "Add a member" });
  await d.getByRole("textbox", { name: "Email" }).fill(maybe);
  await d.getByRole("button", { name: "Add member" }).click();
  const sent = page.getByRole("dialog", { name: `Invite sent to ${maybe}` });
  await expect(sent).toBeVisible();
  await expect(sent).toContainText(
    `${maybe} is outside ${domains.join(" or ")}, so they may not be able to sign in.`,
  );
});

test('#807: New space has "Add me as a manager", on by default', async ({
  browser,
}) => {
  await needs("#807", "0.73.0");
  const admin = await person(browser, "admin", "admin");
  const page = admin.page;
  await page.goto("/settings/spaces");
  await page.getByRole("button", { name: "New space" }).click();
  const d = page.getByRole("dialog", { name: "New space" });
  await expect(
    d.getByRole("checkbox", { name: "Add me as a manager" }),
  ).toBeChecked();
  // Nothing is created: T19 makes no spaces but its own two.
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toHaveCount(0);
});
