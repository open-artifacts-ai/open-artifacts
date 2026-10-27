// Hosted P4 Task 14: the SPA's sign-in page at 1280 and 375, light and dark:
// the trial's code-first page, the Google page with its guest link, the guest
// code page (`?method=code`) and its code step, a refused Google sign-in, and
// `next` on the Google and guest links.
import { expect, type Page, test } from "@playwright/test";

/** The hosted mocks' instance name (`/api/v1/me`). */
const NAME = "Acme Artifacts";

const signIn = async (
  page: Page,
  query: string,
  heading = `Sign in to ${NAME}`,
) => {
  await page.goto(`/sign-in?${query}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: heading }).waitFor();
};

const GUEST = "Get a sign-in code";

const noOverflow = async (page: Page) => {
  const over = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
  );
  expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
};

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 375]) {
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme });

      test("trial: codes are the main way in", async ({ page }, info) => {
        await page.setViewportSize({ width, height: 860 });
        await signIn(page, "hosted=email-only");
        await expect(
          page.getByText("We'll email you an 8-digit sign-in code."),
        ).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: "Work email" }),
        ).toBeVisible();
        await expect(
          page.getByText("Or the email you were invited with."),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Email me a code" }),
        ).toBeVisible();
        // No Google, and the trial footnote names the instance, not Design's example tenant.
        await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0);
        await expect(
          page.getByText(
            `${NAME} is trying Open Artifacts. Codes go to work addresses and invited guests.`,
          ),
        ).toBeVisible();
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`signin-trial-${scheme}-${width}.png`),
          fullPage: true,
        });
      });

      test("Google: one button, and a guest link", async ({ page }, info) => {
        await page.setViewportSize({ width, height: 860 });
        await signIn(page, "hosted=1");
        await expect(
          page.getByText("Use your example.com Google account."),
        ).toBeVisible();
        const google = page.getByRole("link", { name: "Continue with Google" });
        await expect(google).toBeVisible();
        await expect(google).toHaveAttribute(
          "href",
          "/auth/login/google?next=%2F",
        );
        await expect(
          page.getByText(
            "If someone shared an artifact with your email, use a code.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Get a sign-in code", exact: true }),
        ).toHaveAttribute("href", "/sign-in?method=code&next=%2F");
        await expect(page.getByRole("textbox")).toHaveCount(0);
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`signin-google-${scheme}-${width}.png`),
          fullPage: true,
        });
      });

      test("guest code page: the email step", async ({ page }, info) => {
        await page.setViewportSize({ width, height: 860 });
        await signIn(page, "hosted=1&method=code", GUEST);
        await expect(
          page.getByText("Use the email address the link was shared with."),
        ).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: "Email" }),
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "Back" })).toHaveAttribute(
          "href",
          "/sign-in?next=%2F",
        );
        await expect(
          page.getByRole("link", { name: "Continue with Google" }),
        ).toHaveAttribute("href", "/auth/login/google?next=%2F");
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`signin-guest-${scheme}-${width}.png`),
          fullPage: true,
        });
      });

      test("code step after a request", async ({ page }, info) => {
        await page.setViewportSize({ width, height: 860 });
        await signIn(page, "hosted=1&method=code", GUEST);
        await page
          .getByRole("textbox", { name: "Email" })
          .fill("bob@example.com");
        await page.getByRole("button", { name: "Send code" }).click();
        await expect(
          page.getByRole("heading", { name: "Check your email" }),
        ).toBeVisible();
        await expect(
          page.getByText(
            "If b***@example.com can sign in here, we sent it a code.",
          ),
        ).toBeVisible();
        await expect(
          page.getByText("The code works for 10 minutes."),
        ).toBeVisible();
        const code = page.getByRole("textbox", { name: "Code", exact: true });
        await expect(code).toHaveAttribute("inputmode", "numeric");
        await expect(code).toHaveAttribute("autocomplete", "one-time-code");
        await expect(code).toHaveAttribute("placeholder", "1234 5678");
        await expect(page.getByText(/^Resend in \d+s$/)).toBeVisible();
        await expect(page.getByRole("button", { name: /Resend/ })).toHaveCount(
          0,
        );
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`signin-code-${scheme}-${width}.png`),
          fullPage: true,
        });
      });

      test("a refused Google sign-in shows the mapped copy", async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 860 });
        await signIn(page, "hosted=1&error=tenant");
        await expect(page.getByRole("alert")).toContainText(
          `That Google account isn't part of ${NAME}. Use your example.com account.`,
        );
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`signin-error-${scheme}-${width}.png`),
          fullPage: true,
        });
      });
    });
  }

test("Google keeps a safe next and never takes a hostile one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "hosted=1&next=%2Fa%2FDe6gHjKmNp7qRsTu");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fa%2FDe6gHjKmNp7qRsTu");
  await signIn(page, "hosted=1&next=%2F%2Fevil.example");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2F");
});

test("an unknown ?error= is never echoed", async ({ page }) => {
  await page.goto("/sign-in?hosted=1&error=javascript%3Aalert(1)");
  await expect(page.getByRole("alert")).toContainText(
    "Sign-in didn't work. Try again.",
  );
  expect(await page.content()).not.toContain("javascript:alert(1)");
});

test("guest link to code page; a typed code opens the server's next", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "hosted=1&next=%2Fshared");
  await page
    .getByRole("link", { name: "Get a sign-in code", exact: true })
    .click();
  await page.getByRole("heading", { name: GUEST }).waitFor();
  await page.getByRole("textbox", { name: "Email" }).fill("guest@outside.org");
  await page.getByRole("button", { name: "Send code" }).click();
  await page
    .getByRole("textbox", { name: "Code", exact: true })
    .fill("2468 1357");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/shared$/);
});
