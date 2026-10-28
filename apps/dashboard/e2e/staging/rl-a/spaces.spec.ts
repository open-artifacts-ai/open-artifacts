import {
  type ArtifactSummary,
  type Page as ListPage,
  R,
  type Space,
} from "@oa/shared";
import type { Page } from "@playwright/test";
import {
  A,
  api,
  cleanup,
  expect,
  get,
  json,
  type Person,
  person,
  publish,
  RUN,
  refusal,
  remember,
  SPACES,
  t19Spaces,
  test,
} from "./fixtures";

// T19 step 3: spaces on rl-a. People and roles come from the session hook
// (setup); what the plan names as UI runs in the UI. The spaces are the fixed
// t19-eng and t19-exec, made once and reused (a space with trashed artifacts
// can't be deleted); each run deletes the artifacts it made. In a shared
// space an editor publishes and edits; moving, sharing, visibility and
// delete are a manager's (artifactCan).

const { eng, exec } = SPACES;

/** Manages both spaces: deletes the run's shared-space artifacts. */
let keeper: Person;

test.beforeAll(async ({ browser }) => {
  const admin = await person(browser, "admin", "admin");
  await t19Spaces(admin);
  keeper = await person(browser, "keeper", "member", [
    { spaceId: eng.id, role: "manager" },
    { spaceId: exec.id, role: "manager" },
  ]);
  // Public links off in t19-exec: idempotent, whatever an earlier run left.
  await json(
    await api(admin, R.space(exec.id), {
      method: "PATCH",
      body: JSON.stringify({ publicLinks: false }),
    }),
  );
});
test.afterAll(cleanup);

const page1 = (title: string, spaceId?: string) => ({
  title,
  format: "html" as const,
  content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  ...(spaceId ? { spaceId } : {}),
});

/** The side panel on one tab (desktop width). */
async function panel(page: Page, tab: "Details" | "Share") {
  await page.getByRole("button", { name: /^Version: / }).click();
  await page.getByRole("tab", { name: tab }).click();
}

test("a member sees their spaces in the sidebar", async ({ browser }) => {
  const m = await person(browser, "sidebar", "member", [
    { spaceId: eng.id, role: "viewer" },
    { spaceId: exec.id, role: "editor" },
  ]);
  await m.page.goto("/");
  const nav = m.page.getByRole("navigation", { name: "Spaces" });
  for (const name of ["Personal", eng.name, exec.name])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await nav.getByRole("link", { name: exec.name, exact: true }).click();
  await expect(
    m.page.getByRole("heading", { level: 1, name: exec.name }),
  ).toBeVisible();
  await expect(m.page.getByText("You're an editor")).toBeVisible();
});

test("a viewer sees no edit controls, and the API refuses their publish", async ({
  browser,
}) => {
  const editor = await person(browser, "v-editor", "member", [
    { spaceId: eng.id, role: "editor" },
  ]);
  const viewer = await person(browser, "viewer", "member", [
    { spaceId: eng.id, role: "viewer" },
  ]);
  const title = `T19 ${RUN} viewer page`;
  const { id } = await publish(editor, page1(title, eng.id), keeper);

  const page = viewer.page;
  await page.goto(`/?space=${eng.id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: eng.name }),
  ).toBeVisible();
  await expect(page.getByText("You're a viewer")).toBeVisible();
  await expect(page.getByTestId("upload-files")).toHaveCount(0);

  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(new RegExp(`/a/${id}`));
  // A plain heading, not the editable title; no Share; no Delete or Move.
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await panel(page, "Details");
  await expect(page.getByRole("button", { name: "Move" })).toHaveCount(0);

  // The API: no new artifact in the space, no new version of this one.
  const create = await api(viewer, R.artifacts, {
    method: "POST",
    body: JSON.stringify(page1(`T19 ${RUN} refused`, eng.id)),
  });
  expect(await refusal(create, 403)).toBe("space_forbidden");
  const version = await api(viewer, R.versions(id), {
    method: "POST",
    body: JSON.stringify({ format: "html", content: "<p>no</p>" }),
  });
  expect([403, 404]).toContain(version.status);
});

test("an editor publishes into t19-eng; a manager moves it to t19-exec", async ({
  browser,
}) => {
  const editor = await person(browser, "editor", "member", [
    { spaceId: eng.id, role: "editor" },
  ]);
  const mover = await person(browser, "mover", "member", [
    { spaceId: eng.id, role: "manager" },
    { spaceId: exec.id, role: "editor" },
  ]);
  const page = editor.page;
  await page.goto(`/?space=${eng.id}`);
  await page.getByTestId("upload-files").setInputFiles({
    name: `t19-${RUN}-plan.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(`# T19 ${RUN} plan\n`),
  });
  const d = page.getByRole("dialog", { name: "Create artifact" });
  await expect(d.getByRole("combobox", { name: "Space" })).toHaveText(
    new RegExp(eng.name),
  );
  const title = `T19 ${RUN} plan`;
  await d.getByRole("textbox", { name: "Title" }).fill(title);
  await d.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/a\/[^/]+/);
  const id = new URL(page.url()).pathname.split("/")[2] ?? "";
  remember(keeper, id);
  const made = await json<ArtifactSummary>(await api(editor, R.artifact(id)));
  expect(made).toMatchObject({ title, space: { id: eng.id } });
  // The editor can't move it: Details has no Move.
  await panel(page, "Details");
  await expect(page.getByText(eng.name).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Move" })).toHaveCount(0);

  const m = mover.page;
  await m.goto(`/a/${id}`);
  await panel(m, "Details");
  const button = m.getByRole("button", { name: "Move" });
  await expect(button).toBeVisible();
  await button.click();
  const move = m.getByRole("dialog", { name: `Move "${title}" to` });
  await move.getByRole("radio", { name: new RegExp(`^${exec.name}`) }).check();
  await move.getByRole("button", { name: "Move" }).click();
  await expect(m.getByText(`Moved to ${exec.name}.`)).toBeVisible();
  const moved = await json<ArtifactSummary>(await api(mover, R.artifact(id)));
  expect(moved.space?.id).toBe(exec.id);
});

test("public links off in t19-exec: Public is disabled, and anonymous /full gets nothing", async ({
  browser,
}) => {
  const mgr = await person(browser, "exec-mgr", "member", [
    { spaceId: exec.id, role: "manager" },
  ]);
  const title = `T19 ${RUN} exec page`;
  const { id } = await publish(mgr, page1(title, exec.id));

  const page = mgr.page;
  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("radio", { name: "Public" })).toBeDisabled();
  await expect(
    page.getByText(`Public links are off for ${exec.name}.`),
  ).toBeVisible();
  const pub = await api(mgr, R.artifact(id), {
    method: "PATCH",
    body: JSON.stringify({ visibility: "public" }),
  });
  expect(await refusal(pub, 403)).toBe("public_links_off");

  // Nobody signed in: the API has nothing, and /full shows nothing of it.
  const anon = await fetch(`${A.app}${R.artifact(id)}`, {
    headers: { "x-oa-request": "1" },
    signal: AbortSignal.timeout(30_000),
  });
  expect(anon.status).toBe(404);
  const stranger = await (
    await browser.newContext({ baseURL: A.app })
  ).newPage();
  await stranger.goto(`/a/${id}/full`);
  // Sent to sign in, with the way back kept.
  await expect(stranger).toHaveURL(
    new RegExp(`/sign-in\\?next=${encodeURIComponent(`/a/${id}/full`)}$`),
  );
  await expect(
    stranger.getByRole("heading", { level: 1, name: /^Sign in to / }),
  ).toBeVisible();
  await expect(stranger.getByText(title)).toHaveCount(0);
  await expect(stranger.locator("iframe.oa-vframe")).toHaveCount(0);
});

test("an admin never sees another person's personal space", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const m = await person(browser, "private", "member");
  const title = `T19 ${RUN} private page`;
  await publish(m, page1(title));

  const personal = await json<ListPage<Space>>(
    await get(admin, `${R.spaces}?kind=personal&limit=200`),
  );
  expect(personal.items.map((s) => s.id)).not.toContain(m.id);
  expect(personal.items.every((s) => s.id === admin.id)).toBe(true);
  const list = await api(
    admin,
    `${R.artifacts}?scope=space&spaceId=${encodeURIComponent(m.id)}`,
  );
  expect(await refusal(list, 400)).toBe("space_personal");
  expect([400, 404]).toContain((await api(admin, R.space(m.id))).status);
  const search = await json<ListPage<ArtifactSummary>>(
    await get(admin, `${R.artifacts}?scope=all&q=${encodeURIComponent(title)}`),
  );
  expect(search.items.map((a) => a.title)).not.toContain(title);

  // The UI: one Personal (their own), and the member's page nowhere.
  await admin.page.goto("/");
  const nav = admin.page.getByRole("navigation", { name: "Spaces" });
  await expect(nav.getByRole("link", { name: "Personal" })).toHaveCount(1);
  // Their personal space by id: back to the admin's own Library.
  await admin.page.goto(`/?space=${m.id}`);
  await expect(admin.page).toHaveURL(`${A.app}/`);
  await expect(
    admin.page.getByRole("heading", { level: 1, name: "Library" }),
  ).toBeVisible();
  await expect(admin.page.getByText(title)).toHaveCount(0);
});

test('a space named "Personal" is refused inline', async ({ browser }) => {
  const admin = await person(browser, "admin", "admin");
  const page = admin.page;
  await page.goto("/settings/spaces");
  await page.getByRole("button", { name: "New space" }).click();
  const d = page.getByRole("dialog", { name: "New space" });
  await d.getByRole("textbox", { name: "Name" }).fill("Personal");
  await d.getByRole("button", { name: "Create space" }).click();
  // The dashboard's own words for it (settings/spaces/name.ts NAME_RESERVED).
  await expect(d.getByRole("alert")).toHaveText(
    "Everyone already has a space called Personal. Use another name.",
  );
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "Cancel" }).click();

  const res = await api(admin, R.spaces, {
    method: "POST",
    body: JSON.stringify({ name: "personal ", addMe: false }),
  });
  expect(await refusal(res, 400)).toBe("space_name_reserved");
});

test("Remove someone with personal artifacts: Departed lists them, and Transfer gives them to a successor", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const heir = await person(browser, "heir", "member");
  const gone = await person(browser, "gone", "member");
  const titles = [`T19 ${RUN} gone one`, `T19 ${RUN} gone two`];
  const ids: string[] = [];
  // After the transfer they're the heir's: the heir deletes them.
  for (const t of titles) ids.push((await publish(gone, page1(t), heir)).id);

  const page = admin.page;
  await page.goto("/settings/members");
  await expect(
    page.getByRole("region", { name: "Members" }).getByText(gone.name),
  ).toBeVisible();
  await page.getByRole("button", { name: `More for ${gone.name}` }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("button", { name: "Remove member" }).click();

  const departed = page.getByRole("region", { name: "Departed" });
  const row = departed.getByRole("listitem").filter({ hasText: gone.name });
  await expect(row).toContainText("Removed");
  await expect(row).toContainText("2 personal artifacts");
  await row
    .getByRole("button", { name: `Transfer ${gone.name}'s artifacts` })
    .click();
  const d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Give them to" }).click();
  await page.getByRole("option", { name: heir.name }).click();
  await d.getByRole("button", { name: "Transfer 2" }).click();
  await expect(
    page.getByText(`Moved 2 artifacts to ${heir.name}.`).first(),
  ).toBeVisible();
  await expect(row).toHaveCount(0);

  for (const id of ids) {
    const a = await json<ArtifactSummary>(await api(heir, R.artifact(id)));
    expect(a.owner.email).toBe(heir.email);
  }
  // Removed means signed out: the old session no longer works.
  expect((await api(gone, R.me)).status).toBe(401);
});
