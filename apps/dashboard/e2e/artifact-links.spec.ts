// In-artifact links to this app (mock): the runtime turns a click on a plain
// link to <app>/a/<id> into a nonce'd navigate request once the welcome gave it
// appOrigin. The shell routes there client-side, ignores anything that isn't
// an artifact view path, and in embed mode opens a new tab instead.
import {
  type BrowserContext,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";

const APP = "http://localhost:5199";
const ATTACKER = "http://127.0.0.1:5199/__attacker";
const LANDING = "Cd5fGhJkLm6nPqRs"; // "Landing page"
const POLL = "Gh9kLmNpQrAsTuVx"; // "Team poll", public

/** Stands in for the runtime's link interception; the page links to POLL. */
const artifact = (id: string) => `<!doctype html><script>
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  let appOrigin = null;
  const nav = (url) =>
    parent.postMessage({ oa: 1, type: "navigate", url, nonce }, "*");
  window.__forge = nav;
  addEventListener("message", (e) => {
    if (e.data && e.data.type === "welcome") appOrigin = e.data.appOrigin;
  });
  addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || !appOrigin || new URL(a.href).origin !== appOrigin) return;
    e.preventDefault();
    nav(a.href);
  }, true);
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
</script><p id="who">artifact ${id}</p>
<a id="go" href="${APP}/a/${POLL}?x=1#y">Open the poll</a>`;

const serve = (context: BrowserContext) =>
  context.route("https://content.example.com/**", (r) => {
    const id = /\/c\/([^/]+)\//.exec(r.request().url())?.[1] ?? "?";
    return r.fulfill({ contentType: "text/html", body: artifact(id) });
  });

const contentFrame = async (page: Page, id: string): Promise<Frame> => {
  const find = () =>
    page.frames().find((f) => f.url().includes(`content.example.com/c/${id}/`));
  await expect.poll(() => !!find()).toBe(true);
  const f = find() as Frame;
  await expect(f.locator("#who")).toHaveText(`artifact ${id}`);
  return f;
};

// The attacker page is fulfilled by a route, so Chrome counts it as public and
// would block it from framing a loopback address.
test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

test.beforeEach(({ context }) => serve(context));

test("a plain link to /a/B lands the top window on B without a reload", async ({
  page,
}) => {
  await page.goto(`/a/${LANDING}`);
  const a = await contentFrame(page, LANDING);
  await page.evaluate(() => {
    (window as unknown as { __same: boolean }).__same = true;
  });
  // Clicking before the welcome arrived would navigate the frame itself.
  await expect
    .poll(() => a.evaluate(() => typeof window.__forge))
    .toBe("function");
  await a.locator("#go").click();
  await expect(page).toHaveURL(`${APP}/a/${POLL}`);
  await contentFrame(page, POLL);
  await expect(page.getByRole("heading", { name: "Team poll" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __same?: boolean }).__same,
    ),
  ).toBe(true);
});

test("a forged navigate to anything but an artifact view is ignored", async ({
  page,
}) => {
  await page.goto(`/a/${LANDING}`);
  const a = await contentFrame(page, LANDING);
  for (const url of [
    `${APP}/settings`,
    `${APP}/a/${POLL}/diff`,
    `https://evil.example/a/${POLL}`,
    `javascript:alert(1)`,
  ])
    await a.evaluate((u) => window.__forge(u), url);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(`${APP}/a/${LANDING}`);
  // The channel itself works: a valid request still goes through.
  await a.evaluate((u) => window.__forge(u), `${APP}/a/${POLL}/v/1`);
  await expect(page).toHaveURL(`${APP}/a/${POLL}/v/1`);
});

test.describe("embed mode", () => {
  test("the link opens a new tab; the framed shell stays", async ({
    page,
    context,
  }) => {
    await context.route(
      (u) => u.href.startsWith(ATTACKER),
      (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><iframe src="${APP}/a/${POLL}/full" style="width:800px;height:600px;border:0"></iframe>`,
        }),
    );
    await page.goto(ATTACKER);
    const a = await contentFrame(page, POLL);
    await expect
      .poll(() => a.evaluate(() => typeof window.__forge))
      .toBe("function");
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      a.locator("#go").click(),
    ]);
    await expect.poll(() => tab.url()).toBe(`${APP}/a/${POLL}`);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    const shell = page.frames().find((f) => f.url().startsWith(`${APP}/a/`));
    expect(shell?.url()).toBe(`${APP}/a/${POLL}/full`);
  });
});

declare global {
  interface Window {
    __forge: (url: string) => void;
  }
}
