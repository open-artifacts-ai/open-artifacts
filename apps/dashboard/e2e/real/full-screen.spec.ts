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

const DB_PAGE = `<!doctype html>
<p id="out">loading</p><button id="save">Save</button>
<script>
const out = document.getElementById("out");
const notes = () => window.openArtifacts.db.collection("notes");
window.openArtifacts.ready
  .then(() => notes().get("n1"))
  .then((d) => { out.textContent = d ? "loaded:" + d.data.text : "empty"; })
  .catch((e) => { out.textContent = "error:" + e.message; });
document.getElementById("save").onclick = () =>
  notes().set("n1", { text: "hello" })
    .then(() => { out.textContent = "saved"; })
    .catch((e) => { out.textContent = "error:" + e.message; });
</script>`;

const full = (id: string) => `/a/${id}/full`;

test("a live-data artifact reads and writes chromeless", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Full notes ${uniq()}`,
    format: "html",
    content: DB_PAGE,
    capabilities: { db: true },
  });
  await page.goto(full(id));
  // No chrome: the title bar and crumbs aren't there.
  await expect(page.locator("iframe.oa-vframe")).toBeVisible();
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(0);
  const out = artifactFrame(page).locator("#out");
  await expect(out).toHaveText("empty");
  await artifactFrame(page).getByRole("button", { name: "Save" }).click();
  await expect(out).toHaveText("saved");
  await page.reload();
  await expect(out).toHaveText("loaded:hello");
});

test("private: logged out goes to login back to /full; a share grants access", async ({
  browser,
  member,
}) => {
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

test("a public artifact works logged out", async ({ browser, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Full open ${uniq()}`,
    format: "markdown",
    content: "# Open to all",
    visibility: "public",
  });
  const anon = await browser.newContext({ baseURL: APP });
  const page = await anon.newPage();
  await page.goto(full(id));
  await expect(
    artifactFrame(page).getByRole("heading", { name: "Open to all" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${APP}${full(id)}`);
  await expect(page.getByRole("link", { name: "Log in" })).toHaveCount(0);
  await anon.close();
});
