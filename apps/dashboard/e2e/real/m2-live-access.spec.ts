// M2 review: 4403 on the viewer with the side panel open (now the gone
// state: the copy stays), and db.resync on reconnect.
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

const LIVE_PAGE = `<!doctype html>
<p id="out">waiting</p><p id="resync">0</p>
<script>
let n = 0;
window.openArtifacts.ready.then(() => {
  window.openArtifacts.db.collection("notes").subscribe((e) => {
    if (e.resync) document.getElementById("resync").textContent = String(++n);
    document.getElementById("out").textContent = "subscribed";
  });
});
</script>`;

const api = (pat: string, method: string, path: string, body?: unknown) =>
  fetch(`${APP}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${pat}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/** `api`, failing with the status and the server's error body (its code) unless 2xx. */
const apiOk = async (...args: Parameters<typeof api>) => {
  const res = await api(...args);
  expect(
    res.ok,
    `${args[1]} ${args[2]}: ${res.status} ${res.ok ? "" : await res.text()}`,
  ).toBe(true);
  return res;
};

test("a revoked share keeps the open copy, says so, and stops live data", async ({
  member,
  browser,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: LIVE_PAGE,
    capabilities: { db: true },
  });
  const bobEmail = freshEmail("bob");
  await apiOk(member.pat, "PUT", R.shares(id), {
    email: bobEmail,
    role: "editor",
  });
  const ctx = await browser.newContext({ baseURL: APP });
  const bob = await ctx.newPage();
  await loginAs(bob, bobEmail, "guest");
  await bob.goto(`/a/${id}?panel=open&tab=versions`);
  await expect(artifactFrame(bob).locator("#out")).toHaveText("subscribed");
  await expect(
    bob.getByRole("complementary").or(bob.getByRole("tabpanel")).first(),
  ).toBeVisible();

  await apiOk(member.pat, "DELETE", R.share(id, bobEmail));
  // Design's gone state (live versions): the frame stays, with a banner.
  await expect(
    bob
      .locator(".oa-lgone")
      .getByText("This artifact is no longer available to you."),
  ).toBeVisible();
  await expect(bob.locator("iframe.oa-vframe")).toHaveCount(1);
  // Stopped: no more calls for this artifact (data, content URL, events).
  const after: string[] = [];
  bob.on("request", (r) => {
    if (r.url().includes(`/artifacts/${id}`)) after.push(r.url());
  });
  bob.on("websocket", (w) => {
    if (w.url().includes(`/artifacts/${id}`)) after.push(w.url());
  });
  await bob.waitForTimeout(2_000);
  expect(after).toEqual([]);
  await expect(
    bob.getByRole("heading", { name: "Page not found" }),
  ).toHaveCount(0);
  await ctx.close();
});

test("an access change (4403) reconnects and delivers db.resync", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Resync ${uniq()}`,
    format: "html",
    content: LIVE_PAGE,
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}?panel=open&tab=share`);
  const frame = artifactFrame(page);
  await expect(frame.locator("#out")).toHaveText("subscribed");
  const before = Number(await frame.locator("#resync").textContent());
  await apiOk(member.pat, "PATCH", R.artifact(id), { visibility: "team" });
  await expect
    .poll(async () => Number(await frame.locator("#resync").textContent()), {
      timeout: 15_000,
    })
    .toBeGreaterThan(before);
  // Still the viewer, not a 404.
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toHaveCount(0);
});
