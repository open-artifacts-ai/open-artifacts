import type { Page } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// Any other plain link (#P0): the runtime asks the shell to "open" it, and the
// shell moves the top window, in the same tab, only on a real click (transient
// user activation); otherwise a toast asks first. javascript: and friends are
// refused; target=_blank and embed mode keep a new tab.
const OUTSIDE = "https://outside.example";

/** Waits for the welcome; retried, since a frame may still be (re)loading. */
const ready = (page: Page) =>
  expect(async () => {
    await artifactFrame(page)
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as { openArtifacts: { ready: Promise<unknown> } })
            .openArtifacts.ready,
      );
  }).toPass();

/** The per-load nonce, from the frame's #oa= hash. */
const nonceOf = async (page: Page) => {
  // The bridge sets the src property (no attribute).
  const src = await page
    .locator("iframe.oa-vframe")
    .evaluate((f) => (f as HTMLIFrameElement).src);
  return new URL(src).hash.replace(/^#oa=/, "");
};

const LINKS = `<!doctype html><p id="who">links</p>
<a id="ext" href="${OUTSIDE}/landing">Outside</a>
<a id="blank" href="${OUTSIDE}/tab" target="_blank">Outside, new tab</a>
<button id="post" type="button" onclick="parent.postMessage(JSON.parse(this.dataset.msg), '*')">Post</button>`;

const publishLinks = (pat: string, extra: Record<string, unknown> = {}) =>
  publishViaApi(pat, {
    title: `Links ${uniq()}`,
    format: "html",
    content: LINKS,
    ...extra,
  });

test("javascript:, data:, app pages and the content host are refused on a real click", async ({
  page,
  member,
}) => {
  const a = await publishLinks(member.pat);
  page.on("dialog", (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`);
  });
  await page.goto(`/a/${a.id}`);
  await ready(page);
  const nonce = await nonceOf(page);
  const content = new URL(
    await page
      .locator("iframe.oa-vframe")
      .evaluate((f) => (f as HTMLIFrameElement).src),
  ).origin;
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    // The app outside viewer paths (consent phishing, invites, actions).
    `${APP}/oauth/authorize?client_id=evil`,
    `${APP}/settings`,
    // The content host.
    `${content}/p/${a.id}/v1/index.html`,
  ]) {
    await artifactFrame(page)
      .locator("#post")
      .evaluate(
        (b, msg) => {
          (b as HTMLElement).dataset.msg = JSON.stringify(msg);
        },
        { oa: 1, type: "open", url, nonce },
      );
    // A real click: the shell has user activation, and still refuses.
    await artifactFrame(page).locator("#post").click();
    await page.waitForTimeout(1_100); // past the 1/s limit
  }
  expect(page.url()).toBe(`${APP}/a/${a.id}`);
  await expect(page.getByText(/^Open link to/)).toHaveCount(0);
});
