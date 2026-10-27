import { type Me, R, type Space } from "@oa/shared";
import type { Browser, Page } from "@playwright/test";
import {
  APP,
  createToken,
  expect,
  freshEmail,
  loginAs,
  publishViaApi,
  test,
  uniq,
} from "../real/fixtures";

// Hosted screens against the real server with FEATURES=spaces (review item
// 27): until now they were only ever tested against the mocks. Three people
// per test: an org admin, a member who manages one shared space, and a
// member who can only view it.

type Person = { page: Page; email: string; id: string; name: string };

const H = { "X-OA-Request": "1" };

async function person(
  browser: Browser,
  tag: string,
  role: "admin" | "member",
): Promise<Person> {
  const page = await (await browser.newContext({ baseURL: APP })).newPage();
  const email = freshEmail(tag);
  await loginAs(page, email, role);
  const me = (await (await page.request.get(`${APP}${R.me}`)).json()) as Me;
  return { page, email, id: me.user.id, name: `E2E ${email.split("@")[0]}` };
}

async function api<T>(
  p: Person,
  method: "POST" | "PUT",
  path: string,
  data: unknown,
): Promise<T> {
  const res = await p.page.request.fetch(`${APP}${path}`, {
    method,
    headers: H,
    data,
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

type World = { admin: Person; mgr: Person; viewer: Person; space: Space };

/** A shared space with a manager and a viewer, made by an admin through the API. */
async function world(browser: Browser): Promise<World> {
  const [admin, mgr, viewer] = await Promise.all([
    person(browser, "admin", "admin"),
    person(browser, "mgr", "member"),
    person(browser, "viewer", "member"),
  ]);
  const space = await api<Space>(admin, "POST", R.spaces, {
    name: `Eng ${uniq()}`,
  });
  await api(admin, "PUT", R.spaceMember(space.id, mgr.id), { role: "manager" });
  await api(admin, "PUT", R.spaceMember(space.id, viewer.id), {
    role: "viewer",
  });
  return { admin, mgr, viewer, space };
}

/** The side panel on Details (desktop width). */
async function openDetails(page: Page) {
  await page.getByRole("button", { name: /^Version: / }).click();
  await page.getByRole("tab", { name: "Details" }).click();
}

// Review item 2: GET /me never returns `spaces` or `personalSpaceId`, so a
// member never sees the spaces they manage or belong to. Backend owns the fix;
// these flip to passing then (and test.fail turns that into a failure, so
// whoever lands it drops the marker).
const ME_SPACES = "review item 2: GET /me has no spaces or personalSpaceId";

const page1 = (title: string) => ({
  title,
  format: "html" as const,
  content: `<!doctype html><p>${title}</p>`,
});

test("admin: removing someone with personal artifacts lists them under Departed, and Transfer moves them", async ({
  browser,
}) => {
  const { admin, mgr } = await world(browser);
  const gone = await person(browser, "gone", "member");
  const pat = await createToken(gone.page);
  await publishViaApi(pat, page1(`Gone one ${uniq()}`));
  await publishViaApi(pat, page1(`Gone two ${uniq()}`));

  const page = admin.page;
  await page.goto("/settings/members");
  const members = page.getByRole("region", { name: "Members" });
  await expect(members.getByText(mgr.name)).toBeVisible();
  // Active people are never departed, whatever the server's list holds.
  await expect(page.getByRole("region", { name: "Departed" })).toHaveCount(0);

  await page.getByRole("button", { name: `More for ${gone.name}` }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("button", { name: "Remove member" }).click();

  const departed = page.getByRole("region", { name: "Departed" });
  const row = departed.getByRole("listitem").filter({ hasText: gone.name });
  await expect(row).toContainText("Removed");
  await expect(row).toContainText("2 personal artifacts");
  await expect(departed.getByText(mgr.name)).toHaveCount(0);

  await row
    .getByRole("button", { name: `Transfer ${gone.name}'s artifacts` })
    .click();
  const d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Give them to" }).click();
  await page.getByRole("option", { name: mgr.name }).click();
  await d.getByRole("button", { name: "Transfer 2" }).click();
  await expect(
    page.getByText(`Moved 2 artifacts to ${mgr.name}.`).first(),
  ).toBeVisible();
  await expect(departed).toHaveCount(0);
});

test("admin: Spaces settings shows the space with its manager and viewer", async ({
  browser,
}) => {
  const { admin, mgr, viewer, space } = await world(browser);
  const page = admin.page;
  await page.goto(`/settings/spaces?space=${space.id}`);
  await expect(
    page.getByRole("heading", { level: 2, name: space.name }),
  ).toBeVisible();
  const people = page.getByRole("region", { name: "People" });
  await expect(people.getByText(mgr.name)).toBeVisible();
  await expect(people.getByText(viewer.name)).toBeVisible();
});

test("space manager: manages their space, but Members and Directory stay closed", async ({
  browser,
}) => {
  test.fail(true, ME_SPACES);
  const { mgr, viewer, space } = await world(browser);
  const page = mgr.page;
  await page.goto(`/settings/spaces?space=${space.id}`);
  await expect(
    page.getByRole("heading", { level: 2, name: space.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "People" }).getByText(viewer.name),
  ).toBeVisible();
  // Org settings redirect a member away.
  await page.goto("/settings/members");
  await expect(page).not.toHaveURL(/\/settings\/members/);
  await page.goto("/settings/directory");
  await expect(page).not.toHaveURL(/\/settings\/directory/);
});

test("Move: the manager moves a personal artifact into the space; the viewer can open it but not move it", async ({
  browser,
}) => {
  test.fail(true, ME_SPACES);
  const { mgr, viewer, space } = await world(browser);
  const title = `Plan ${uniq()}`;
  const { id } = await publishViaApi(await createToken(mgr.page), page1(title));

  const page = mgr.page;
  await page.goto(`/a/${id}`);
  await openDetails(page);
  // An expect, not a bare click: a missing button fails here, not at the test timeout.
  const move = page.getByRole("button", { name: "Move" });
  await expect(move).toBeVisible();
  await move.click();
  const d = page.getByRole("dialog", { name: `Move "${title}" to` });
  await d.getByRole("radio", { name: new RegExp(`^${space.name}`) }).check();
  await expect(d).toContainText("You can't move it back to Personal.");
  await d.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText(`Moved to ${space.name}.`)).toBeVisible();

  const v = viewer.page;
  await v.goto(`/?space=${space.id}`);
  await v.getByRole("link", { name: title }).first().click();
  await v.waitForURL(new RegExp(`/a/${id}`));
  await openDetails(v);
  await expect(v.getByRole("button", { name: "Move" })).toHaveCount(0);
});

test("Directory: an admin sees it isn't connected, and that only the owner can connect", async ({
  browser,
}) => {
  const { admin } = await world(browser);
  const page = admin.page;
  await page.goto("/settings/directory");
  await expect(page.getByText("Not connected")).toBeVisible();
  await expect(
    page.getByText(/Only the owner.* can connect Google Workspace\./),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Google Workspace" }),
  ).toHaveCount(0);
});
