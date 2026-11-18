import type { BrowserContext, Page } from "@playwright/test";
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

/** Serves the outside site so nothing leaves the machine. */
const _serveOutside = (ctx: BrowserContext) =>
  ctx.route(`${OUTSIDE}/**`, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Outside</title><h1 id="out">outside ${new URL(r.request().url()).pathname}</h1>`,
    }),
  );

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

test("http asks with a not-secure warning; the port shows when not the default", async ({
  page,
  member,
}, info) => {
  test.slow();
  const a = await publishLinks(member.pat, {
    content: `${LINKS}<script>setTimeout(() => parent.postMessage({ oa: 1, type: "open", url: "http://plain.example:8080/x", nonce: window.__oaShellNonce.n }, "*"), 12000)</script>`,
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/a/${a.id}`);
  await expect(artifactFrame(page).locator("#who")).toHaveText("links");
  await page.waitForTimeout(13_000);
  await expect(
    page.getByText("Open link to plain.example:8080?"),
  ).toBeVisible();
  await expect(
    page.getByText("Not secure: this site doesn't use HTTPS."),
  ).toBeVisible();
  if (info.project.name === "chromium")
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // Let the theme's colour transitions finish.
      await page.waitForTimeout(400);
      await page.screenshot({
        path: info.outputPath(`open-link-http-390-${scheme}.png`),
      });
    }
});
