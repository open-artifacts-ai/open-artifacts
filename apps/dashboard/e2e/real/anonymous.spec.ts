import {
  ACCESS_TEAM_DOMAIN,
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

test("a public artifact opens logged out", async ({ browser, member }) => {
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

test("a private artifact sends a logged-out visitor to log in", async ({
  browser,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Closed ${uniq()}`,
    format: "markdown",
    content: "# Members only",
  });
  const anon = await browser.newContext({ baseURL: APP });
  const page = await anon.newPage();
  // The SPA sends the visitor to AUTH.login...
  const login = page.waitForRequest((r) => r.url().includes("/auth/login?"));
  // The SPA leaves before "load" can settle in WebKit: wait for the commit only.
  await page.goto(`/a/${id}`, { waitUntil: "commit" });
  const url = (await login).url();
  expect(new URL(url).searchParams.get("next")).toBe(`/a/${id}`);
  // ...which redirects to the IdP. (Browsers report that hop inconsistently,
  // and the IdP host never resolves, so check the redirect directly.)
  const res = await page.request.get(url, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const authorize = new URL(res.headers().location ?? "");
  expect(authorize.host).toBe(ACCESS_TEAM_DOMAIN);
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${APP}/auth/callback`,
  );
  await anon.close();
});
