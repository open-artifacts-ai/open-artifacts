import { createHash } from "node:crypto";
import {
  type AuthProviders,
  type Me,
  type Member,
  R,
  TEST_HOOKS,
  type TestOtpOutcome,
} from "@oa/shared";
import type { Browser, Page } from "@playwright/test";
import {
  A,
  api,
  expect,
  hook,
  hookRes,
  json,
  needs,
  person,
  test,
} from "./fixtures";

// #1085: the held-change snooze in Settings > Directory, as the org owner.
// The directory-held hook (#1082) puts a held sweep (one removal waiting) on
// a suite group; the owner snoozes it with a reason, unsnoozes it, then opens
// Apply and cancels. A live Apply re-reads the group from Google, where a
// test- group doesn't exist, so it would come back held (needs a real Google
// test group; Post-M1). Hooks never mint the owner, so the owner signs in by
// code (otp/latest), which needs (identity.ts codeRule): TEST_DOMAIN among the
// install's domains, domain codes on, and an owner never linked to Google.
// The hold is taken off in afterAll whatever happens.

// Literal until #1082 lands TEST_HOOKS.directoryHeld in @oa/shared.
const HELD_HOOK = "/__test/directory-held";

/** The fixed suite group (the hooks' `test-` rule), distinct from red-line's. */
const GROUP = (() => {
  const tag = createHash("sha256")
    .update(A.testDomain)
    .digest("hex")
    .slice(0, 8);
  const groupId = `test-t19-snooze-${tag}`;
  return { groupId, email: `${groupId}@${A.testDomain}` };
})();
/** The held row's name: the hook shows the group by its email. */
const NAME = GROUP.email;
const REASON = "T19 snooze check";

/** How long an emailed code may take to land (as joins.spec.ts). */
const OTP_MS = 20_000;
/** How long rl-a's always-pass Turnstile widget may take to give a token. */
const TURNSTILE_MS = 30_000;

/** Set once the hold is seeded: afterAll takes it off only then. */
let seeded = false;

test.beforeAll(async () => {
  // Earlier runs from this IP count against the per-IP code caps.
  await hook(TEST_HOOKS.codeCapsReset, {});
});
test.afterAll(async () => {
  if (!seeded) return;
  const off = await hook<{ held: boolean }>(HELD_HOOK, {
    ...GROUP,
    held: false,
  });
  expect(off.held).toBe(false);
});

/** The otp/latest hook for `address`, polled while it says "pending". */
async function otp(address: string): Promise<string> {
  let code = "";
  let outcome: TestOtpOutcome = "pending";
  await expect
    .poll(
      async () => {
        const res = await hookRes(TEST_HOOKS.otpLatest, { email: address });
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          error?: { details?: { reason?: string; outcome?: TestOtpOutcome } };
        };
        const d = body.error?.details;
        if (res.ok && body.code) code = body.code;
        else if (res.status === 404 && d?.reason === "no_code" && d.outcome)
          outcome = d.outcome;
        else throw new Error(`rl-a otp hook: ${res.status}`);
        return code ? "code" : outcome;
      },
      { timeout: OTP_MS, intervals: [1000] },
    )
    .not.toBe("pending");
  // Ineligible: the owner is Google-linked (or the domain rule moved); as
  // red-line, this install can't prove the flow live.
  if (!code)
    throw new Error(`NO_OWNER: the owner gets no sign-in code (${outcome})`);
  return code;
}

/** The owner, signed in through the real code sign-in UI. */
async function ownerPage(browser: Browser, address: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: A.app })).newPage();
  await page.goto("/sign-in?method=code");
  await expect(
    page.getByRole("heading", { level: 1, name: "Get a sign-in code" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(address);
  await expect
    .poll(
      () =>
        page
          .locator("[data-testid=turnstile] input[name=cf-turnstile-response]")
          .inputValue()
          .catch(() => ""),
      { timeout: TURNSTILE_MS },
    )
    .not.toBe("");
  const sent = page.waitForResponse(
    (r) =>
      r.url().endsWith("/auth/code/request") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send code" }).click();
  expect((await sent).status()).toBe(202);
  await page.getByRole("textbox", { name: "Code" }).fill(await otp(address));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  return page;
}

/** A response to `method` on `path` (a pathname, exactly). */
const answer = (page: Page, method: string, path: string) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === path && r.request().method() === method,
  );

test("#1085: the owner snoozes a held change with a reason, unsnoozes it, and opens Apply", async ({
  browser,
}) => {
  await needs("#1085", "0.94.0");
  test.setTimeout(TURNSTILE_MS + OTP_MS + 60_000);

  const admin = await person(browser, "admin", "admin");
  const me = await json<Me>(await api(admin, R.me));
  test.skip(
    me.instance.directory?.mode !== "google",
    "rl-a's directory is not on Google sync, so a snooze is refused",
  );
  const owner = (await json<Member[]>(await api(admin, R.members))).find(
    (m) => m.role === "owner",
  );
  const ownerEmail = owner?.email.toLowerCase() ?? "";
  test.skip(
    !ownerEmail.endsWith(`@${A.testDomain}`),
    "rl-a's org owner is outside TEST_DOMAIN, so no owner session can be made",
  );
  const providers = await json<AuthProviders>(
    await fetch(`${A.app}/auth/providers`, {
      signal: AbortSignal.timeout(30_000),
    }),
  );
  const google = providers.providers.find((p) => p.id === "google");
  const email = providers.providers.find((p) => p.id === "email");
  test.skip(
    !(google && "domains" in google && google.domains.includes(A.testDomain)) ||
      !(email && "domainCodes" in email && email.domainCodes),
    "NO_OWNER: TEST_DOMAIN isn't an rl-a domain with domain codes on, so the owner gets no code",
  );

  await hook(TEST_HOOKS.directoryGroups, { groups: [GROUP] });
  seeded = true;
  // A hold left by an earlier run that stopped partway goes first.
  await hook(HELD_HOOK, { ...GROUP, held: false });
  const on = await hook<{ held: boolean }>(HELD_HOOK, {
    ...GROUP,
    held: true,
  });
  expect(on.held).toBe(true);

  const page = await ownerPage(browser, ownerEmail);
  await page.goto("/settings/directory");
  const card = page.getByRole("region", {
    name: "Waiting for your confirmation",
  });
  const apply = card.getByRole("button", { name: `Apply ${NAME}` });
  const row = card.getByRole("listitem").filter({ has: apply });
  const tint = /bg-\[var\(--oa-warning-soft\)\]/;

  // Held: tinted, Snooze and a primary Apply.
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(tint);
  await expect(
    row.getByRole("button", { name: `Snooze ${NAME}` }),
  ).toBeVisible();
  await expect(apply).toHaveAttribute("data-variant", "default");

  // Snooze with a reason.
  await row.getByRole("button", { name: `Snooze ${NAME}` }).click();
  const snoozeAsk = page.getByRole("alertdialog", {
    name: `Snooze changes to ${NAME}?`,
  });
  await snoozeAsk
    .getByRole("textbox", { name: "Reason (optional)" })
    .fill(REASON);
  const snoozed = answer(page, "POST", R.directoryHeldSnooze(GROUP.groupId));
  await snoozeAsk.getByRole("button", { name: "Snooze", exact: true }).click();
  expect((await snoozed).status()).toBe(200);
  await expect(snoozeAsk).toHaveCount(0);

  // Snoozed: the until line and the quoted reason, no tint, a quiet Apply.
  await expect(
    row.getByText(/^Snoozed until .+ or the group changes$/),
  ).toBeVisible();
  await expect(row.getByText(`“${REASON}”`)).toBeVisible();
  await expect(row).not.toHaveClass(tint);
  await expect(apply).toHaveAttribute("data-variant", "outline");

  // Unsnooze: the tint and the primary Apply come back.
  const unsnoozed = answer(
    page,
    "DELETE",
    R.directoryHeldSnooze(GROUP.groupId),
  );
  await row.getByRole("button", { name: `Unsnooze ${NAME}` }).click();
  expect((await unsnoozed).status()).toBe(200);
  await expect(row.getByText(/^Snoozed until/)).toHaveCount(0);
  await expect(row).toHaveClass(tint);
  await expect(apply).toHaveAttribute("data-variant", "default");

  // Apply opens its confirm; cancel (a live confirm needs a real Google
  // group: the sweep would re-read this test- group and hold it again).
  await apply.click();
  const applyAsk = page.getByRole("alertdialog", {
    name: `Remove 1 person from ${NAME}?`,
  });
  await expect(applyAsk).toBeVisible();
  await expect(applyAsk).toContainText(
    "If this looks wrong, fix the group in Google Admin and leave it waiting.",
  );
  await expect(
    applyAsk.getByRole("button", { name: "Remove 1 person" }),
  ).toBeVisible();
  await applyAsk.getByRole("button", { name: "Cancel" }).click();
  await expect(applyAsk).toHaveCount(0);
  await expect(row).toHaveClass(tint);
  await expect(apply).toHaveAttribute("data-variant", "default");
});
