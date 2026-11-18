// #290: the chromeless full-screen view on the app host keeps the shell,
// bridge and session, so live data works; access matches /a/<id>.
import { R } from "@oa/shared";
import {
  APP,
  artifactFrame,
  expect,
  freshEmail,
  loginAs,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

const full = (id: string) => `/a/${id}/full`;

test("private: logged out goes to login back to /full; a share grants access", {
  tag: "@smoke",
}, async ({ browser, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Full closed ${uniq()}`,
    format: "markdown",
    content: "# Members only",
  });
  const anon = await browser.newContext({ baseURL: APP });
  const visitor = await anon.newPage();
  const login = visitor.waitForRequest((r) => r.url().includes("/auth/login?"));
  await visitor.goto(full(id), { waitUntil: "commit" });
  expect(new URL((await login).url()).searchParams.get("next")).toBe(full(id));
  await anon.close();

  // A guest without a share gets not found; with one, the artifact.
  const bobEmail = freshEmail("bob");
  const ctx = await browser.newContext({ baseURL: APP });
  const bob = await ctx.newPage();
  await loginAs(bob, bobEmail, "guest");
  await bob.goto(full(id));
  await expect(
    bob.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  const share = await fetch(`${APP}${R.shares(id)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${member.pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: bobEmail, role: "viewer" }),
  });
  expect(share.ok).toBe(true);
  await bob.goto(full(id));
  await expect(
    artifactFrame(bob).getByRole("heading", { name: "Members only" }),
  ).toBeVisible();
  await ctx.close();
});
