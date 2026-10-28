import {
  type Me,
  type Member,
  type MemberInviteResult,
  R,
  type ShareResult,
  TEST_HOOKS,
  type TestOtpOutcome,
} from "@oa/shared";
import type { Browser, Page } from "@playwright/test";
import {
  A,
  api,
  cleanup,
  email,
  expect,
  hook,
  hookRes,
  json,
  liveHtml,
  type Person,
  person,
  publish,
  RUN,
  test,
} from "./fixtures";

// T19 step 2: how people join rl-a. rl-a signs its domain in with Google
// (domainCodes off) and admits guests by emailed code. TEST_DOMAIN is outside
// that domain, so a TEST_DOMAIN address can be an invited member (Google
// only), a guest someone shared with (codes), or nobody (no code, no account).
// Every code request goes through the real sign-in UI; the code comes from
// the otp/latest hook. Each address asks once a run: a second request inside
// the 60 s resend window would null the first code.

test.beforeAll(async () => {
  // Earlier runs from this IP count against the per-IP code caps.
  await hook(TEST_HOOKS.codeCapsReset, {});
});
test.afterAll(cleanup);

/** How long an emailed code may take to land (the send runs after the 202). */
const OTP_MS = 20_000;

/**
 * The otp/latest hook for `address`, polled while it says "pending": the code,
 * or the final no_code outcome (TestOtpOutcome).
 */
async function otp(
  address: string,
): Promise<{ code: string } | { outcome: TestOtpOutcome }> {
  let last: { code: string } | { outcome: TestOtpOutcome } = {
    outcome: "pending",
  };
  await expect
    .poll(
      async () => {
        last = await readOtp(address);
        return "code" in last ? "code" : last.outcome;
      },
      { timeout: OTP_MS, intervals: [1000] },
    )
    .not.toBe("pending");
  return last;
}

/** One otp/latest answer: the code, or the no_code 404's outcome. */
async function readOtp(
  address: string,
): Promise<{ code: string } | { outcome: TestOtpOutcome }> {
  const res = await hookRes(TEST_HOOKS.otpLatest, { email: address });
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    error?: { details?: { reason?: string; outcome?: TestOtpOutcome } };
  };
  if (res.ok && body.code) return { code: body.code };
  const d = body.error?.details;
  // Anything else (hooks off, a wrong key, the rate limit) is the bare 404.
  if (res.status !== 404 || d?.reason !== "no_code" || !d.outcome)
    throw new Error(`rl-a otp hook: ${res.status}`);
  return { outcome: d.outcome };
}

/** An anonymous browser on the guest code page, asking for a code for `address`. */
async function askForCode(browser: Browser, address: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: A.app })).newPage();
  await page.goto("/sign-in?method=code");
  await expect(
    page.getByRole("heading", { level: 1, name: "Get a sign-in code" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(address);
  // rl-a's widget runs on Cloudflare's always-pass test key: wait for its
  // token, as the red-line suite sends the dummy token with each request.
  await expect
    .poll(
      () =>
        page
          .locator("[data-testid=turnstile] input[name=cf-turnstile-response]")
          .inputValue()
          .catch(() => ""),
      { timeout: 30_000 },
    )
    .not.toBe("");
  const sent = page.waitForResponse(
    (r) =>
      r.url().endsWith("/auth/code/request") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send code" }).click();
  // The same 202 for every address: the page never says who can sign in.
  expect((await sent).status()).toBe(202);
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  await expect(
    page.getByText(/can sign in here, we sent it a code\./),
  ).toBeVisible();
  return page;
}

/** Every member row for `address`, whatever its status. */
async function rowsFor(admin: Person, address: string): Promise<Member[]> {
  const all = await json<Member[]>(
    await api(admin, `${R.members}?status=active,suspended,removed`),
  );
  return all.filter((m) => m.email === address);
}

test("an uninvited TEST_DOMAIN address gets no code and no account", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const stranger = email("stranger");
  await askForCode(browser, stranger);
  // Outside the Google domain, with no invite and no share: nothing is sent.
  expect(await otp(stranger)).toEqual({ outcome: "ineligible" });
  expect(await rowsFor(admin, stranger)).toEqual([]);
});

test("an invited member: Google is their way in, never a code; their session lands in the library", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const invited = email("invited");
  const r = await json<MemberInviteResult>(
    await api(admin, R.members, {
      method: "POST",
      body: JSON.stringify({ email: invited, role: "member" }),
    }),
  );
  expect(r).toMatchObject({ email: invited, role: "member" });
  // TEST_DOMAIN is outside rl-a's Google domain: the invite stands, flagged.
  expect(r.signIn).toEqual({ status: "uncertain", reason: "outside_domains" });
  expect(r.signInMethods).toEqual(["google"]);

  await askForCode(browser, invited);
  expect(await otp(invited)).toEqual({ outcome: "ineligible" });

  // Signed in (the session hook stands in for Google): the invited row, a member.
  const p = await person(browser, "invited", "member");
  expect(p.id).toBe(r.id);
  await p.page.goto("/");
  await expect(
    p.page.getByRole("heading", { level: 1, name: "Library" }),
  ).toBeVisible();
  const me = await json<Me>(await api(p, R.me));
  expect(me.user.role).toBe("member");
});

test("an outside guest signs in by code, sees only Shared with me, and is read-only", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const guest = email("guest");
  const title = `T19 ${RUN} guest page`;
  const { id } = await publish(admin, liveHtml(title));
  const share = await json<ShareResult>(
    await api(admin, R.shares(id), {
      method: "PUT",
      body: JSON.stringify({ email: guest, role: "viewer" }),
    }),
  );
  expect(share.recipient).toBeUndefined();
  expect(share.signInMethods).toEqual(["email"]);

  const page = await askForCode(browser, guest);
  const got = await otp(guest);
  if (!("code" in got))
    throw new Error(`no code for the guest (${got.outcome})`);
  await page.getByRole("textbox", { name: "Code" }).fill(got.code);
  await page.getByRole("button", { name: "Verify" }).click();

  // A guest's home is Shared with me, and it's the only place they can go.
  await expect(page).toHaveURL(/\/shared$/);
  // A new code account has no name yet: the first page asks for one.
  const ask = page.getByRole("dialog", {
    name: "What do you like to be called?",
  });
  await ask
    .getByRole("textbox", { name: "Your name" })
    .fill(`T19 ${RUN} guest`);
  await ask.getByRole("button", { name: "Save" }).click();
  await expect(ask).toHaveCount(0);
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(
    primary.getByRole("link", { name: "Shared with me" }),
  ).toBeVisible();
  await expect(primary.getByRole("link", { name: "Library" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Spaces" })).toHaveCount(0);

  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(new RegExp(`/a/${id}`));
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);

  // The API agrees: a guest role, and no data writes.
  const req = page.request;
  const me = (await (
    await req.get(`${A.app}${R.me}`, { headers: { "x-oa-request": "1" } })
  ).json()) as Me;
  expect(me.user).toMatchObject({ email: guest, role: "guest" });
  const write = await req.put(`${A.app}${R.dataDoc(id, "t19", "x")}`, {
    headers: { "x-oa-request": "1" },
    data: { v: 1 },
  });
  expect([403, 404]).toContain(write.status());
});
