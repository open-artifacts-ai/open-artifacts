import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { crossSite, type Harness, startWorker } from "./worker.js";

// Design v7 9A.3.2 step 3 and 14.4: `__Host-oa-admin` is SameSite=Strict, so
// a cross-site arrival at /oauth/authorize carries no cookie. The bounce
// page's same-origin navigation must carry it to the consent page, both
// from a link and from the 303 at the end of the sign-in chain.

let w: Harness;
let other: Awaited<ReturnType<typeof crossSite>>;
let browser: Browser;

test.beforeAll(async () => {
  w = await startWorker();
  other = await crossSite(`${w.admin}${w.authorizePath}`);
  browser = await chromium.launch({
    args: [`--host-resolver-rules=${w.hostResolverRules}`],
  });
});
test.afterAll(async () => {
  await browser?.close();
  await other?.close();
  await w?.close();
});

/** A fresh browser with the admin's session cookie, as sign-in sets it. */
async function session(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "__Host-oa-admin",
      value: w.sid,
      domain: "admin.localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  return { context, page: await context.newPage() };
}

/**
 * Every /oauth/authorize response, in arrival order: status, whether the
 * cookie went, the bounce marker. `entries()` waits for the header reads.
 */
function authorizeLog(page: Page) {
  const log: Promise<{ status: number; cookie: boolean; bounced: boolean }>[] =
    [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.pathname !== "/oauth/authorize") return;
    log.push(
      res
        .request()
        .allHeaders()
        .then((h) => ({
          status: res.status(),
          cookie: (h.cookie ?? "").includes("__Host-oa-admin="),
          bounced: u.searchParams.get("b") === "1",
        })),
    );
  });
  return { entries: () => Promise.all(log) };
}

async function expectConsent(page: Page) {
  await expect(page.getByRole("heading")).toHaveText(
    "Connect any AI agent to Open Artifacts admin",
  );
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("b")).toBe("1");
}

test("the Strict cookie reaches consent through the bounce page, from a link", async () => {
  const { page } = await session();
  const log = authorizeLog(page);
  await page.goto(`${other.origin}/link`);
  await page.click("#go");
  await expectConsent(page);
  // First arrival: cross-site, no cookie, the bounce page. Then the
  // same-origin navigation with the cookie: the consent page.
  expect(await log.entries()).toEqual([
    { status: 200, cookie: false, bounced: false },
    { status: 200, cookie: true, bounced: true },
  ]);
});

test("the Strict cookie reaches consent through the bounce page, back from sign-in", async () => {
  const { page } = await session();
  const log = authorizeLog(page);
  await page.goto(`${other.origin}/signin`);
  await page.click("#go");
  await expectConsent(page);
  expect(await log.entries()).toEqual([
    { status: 200, cookie: false, bounced: false },
    { status: 200, cookie: true, bounced: true },
  ]);
});

test("same-origin arrival with the cookie renders consent at once", async () => {
  const { page } = await session();
  const log = authorizeLog(page);
  await page.goto(`${w.admin}${w.authorizePath}`);
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  expect(await log.entries()).toEqual([
    { status: 200, cookie: true, bounced: false },
  ]);
});
