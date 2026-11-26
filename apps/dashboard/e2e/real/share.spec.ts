import { AUTH, R } from "@oa/shared";
import type { Page } from "@playwright/test";
import {
  ACCESS_TEAM_DOMAIN,
  APP,
  artifactFrame,
  expect,
  loginAs,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

const BOB = "bob@x.com";

/** Shares `id` with `email` through the API, as the owner. */
async function shareViaApi(pat: string, id: string, email: string) {
  const res = await fetch(`${APP}${R.shares(id)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, role: "viewer" }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

async function revokeViaMenu(page: Page, id: string, email: string) {
  const picker = page.getByRole("combobox", { name: `Role for ${email}` });
  await picker.click();
  const deleted = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" &&
      r.url() === `${APP}${R.share(id, email)}`,
  );
  await page.getByRole("option", { name: "Remove access" }).click();
  expect((await deleted).ok()).toBe(true);
  await expect(picker).toHaveCount(0);
}

test("owner shares with Bob as viewer; Bob sees it in Shared; revoked, Bob gets a 404", {
  tag: "@smoke",
}, async ({ page, member, browser }) => {
  const title = `Plan ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "markdown",
    content: "# The plan",
  });
  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("textbox", { name: "Email" }).fill(BOB);
  await expect(page.getByRole("combobox", { name: "Invite role" })).toHaveText(
    "Editor",
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const remove = page.getByRole("combobox", { name: `Role for ${BOB}` });
  await expect(remove).toBeVisible();
  // #167: no email is sent, so the owner gets the link to pass on.
  await expect(page.getByText(`Shared with ${BOB}`)).toBeVisible();
  const link = await page
    .getByRole("textbox", { name: "Artifact link" })
    .inputValue();
  expect(link).toBe(`${new URL(page.url()).origin}/a/${id}`);

  const bobCtx = await browser.newContext({ baseURL: APP });
  const bob = await bobCtx.newPage();
  await loginAs(bob, BOB, "guest");
  await bob.goto("/shared");
  await expect(
    bob.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();

  // Bob can open it while shared, so the 404 below is the revocation's doing.
  await bob.goto(link);
  await expect(
    artifactFrame(bob).getByRole("heading", { name: "The plan" }),
  ).toBeVisible();

  // A second share keeps Bob an active guest: only a last revoke signs a guest out.
  const other = await publishViaApi(member.pat, {
    title: `Other ${uniq()}`,
    format: "markdown",
    content: "# Still shared",
  });
  await shareViaApi(member.pat, other.id, BOB);

  await revokeViaMenu(page, id, BOB);

  // Bob is shared across projects, so the list may hold others' artifacts:
  // wait for it to load, then check this one is gone.
  const listed = bob.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/artifacts?") &&
      r.url().includes("scope=shared"),
  );
  await bob.goto("/shared");
  expect((await listed).ok()).toBe(true);
  await expect(
    bob.getByRole("status", { name: "Loading artifacts" }),
  ).toHaveCount(0);
  await expect(bob.getByRole("link", { name: title, exact: true })).toHaveCount(
    0,
  );

  await bob.goto(`/a/${id}`);
  await expect(
    bob.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(bob.locator("iframe")).toHaveCount(0);
  await bobCtx.close();
});

test("revoking a guest's last share signs them out", async ({
  page,
  member,
  browser,
}) => {
  const guest = `guest-${uniq()}@e2e.test`;
  const title = `Only ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "markdown",
    content: "# The only one",
  });
  await shareViaApi(member.pat, id, guest);

  const ctx = await browser.newContext({ baseURL: APP });
  const g = await ctx.newPage();
  await loginAs(g, guest, "guest");
  await g.goto("/shared");
  await expect(g.getByRole("link", { name: title, exact: true })).toBeVisible();

  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await revokeViaMenu(page, id, guest);

  // The guest is deactivated with their last share: the session is gone.
  const shared = await g.request.get(`${APP}${R.artifacts}?scope=shared`, {
    headers: { "X-OA-Request": "1" },
  });
  expect(shared.status()).toBe(401);

  // The SPA sends a signed-out visitor to sign in (a full-page redirect to the
  // IdP via AUTH.login), coming back to the same page afterwards.
  // Each on its own page: the IdP host is unreachable here, so a page ends on
  // the browser's error page and a later goto on it would race that.
  for (const path of ["/shared", `/a/${id}`]) {
    const p = await ctx.newPage();
    const login = p.waitForRequest((r) =>
      r.url().startsWith(`${APP}${AUTH.login}?`),
    );
    const idp = p.waitForRequest(
      (r) => new URL(r.url()).host === ACCESS_TEAM_DOMAIN,
    );
    await p.goto(path, { waitUntil: "commit" });
    expect(new URL((await login).url()).searchParams.get("next")).toBe(path);
    expect(new URL((await idp).url()).pathname).toMatch(/\/authorization$/);
    await expect(p.locator("iframe")).toHaveCount(0);
    await p.close();
  }
  await ctx.close();
});
