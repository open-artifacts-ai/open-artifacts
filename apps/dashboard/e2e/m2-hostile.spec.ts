// M2 review: hostile and long strings through every new surface (names, labels, mcpUrl).
import { expect, type Page, test } from "@playwright/test";

const X = `"><img src=x onerror="window.__xss=1"><svg/onload=window.__xss=1>`;
const LONG = "W".repeat(80);

const hostile = (page: Page, name: string) =>
  page.addInitScript(
    ({ X, name }) => {
      const f = window.fetch.bind(window);
      const json = (v: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(v), {
            headers: { "content-type": "application/json" },
          }),
        );
      window.fetch = async (input, init) => {
        const u = new URL(new Request(input, init).url).pathname;
        const res = await f(input, init);
        if (
          !/\/api\/v1\/(me|tokens|oauth-clients|members|settings)$/.test(u) ||
          !res.ok
        )
          return res;
        const body = await res.json();
        if (u.endsWith("/me")) {
          body.instance.name = name;
          body.instance.mcpUrl = `https://x.example/mcp?a='$(touch /tmp/pwn)'&b=${X}\n[evil]\nurl="y"`;
          body.user.name = X;
        }
        if (u.endsWith("/settings")) body.name = name;
        if (u.endsWith("/tokens"))
          for (const t of body as { label: string }[]) t.label = X + LONG;
        if (u.endsWith("/oauth-clients"))
          for (const c of body as { clientName: string }[])
            c.clientName = X + LONG;
        if (u.endsWith("/members"))
          body.forEach((m: { name: string | null; email: string }) => {
            m.name = X;
            m.email = `${LONG}@${LONG}.example`;
          });
        return json(body);
      };
    },
    { X, name },
  );

for (const path of [
  "/",
  "/settings/agents",
  "/settings/members",
  "/settings/instance",
  "/sign-in",
])
  for (const name of [X, LONG])
    test(`hostile ${name === X ? "markup" : "long"} strings on ${path}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await hostile(page, name);
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      if (path === "/settings/agents")
        await page.getByRole("radio", { name: "Token" }).click();
      expect(
        await page.evaluate(() => (window as { __xss?: number }).__xss),
      ).toBeUndefined();
      expect(await page.locator("img[src=x], svg[onload]").count()).toBe(0);
      const sw = await page.evaluate(
        () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
      );
      expect(sw, "horizontal overflow px").toBeLessThanOrEqual(0);
    });

// Hosted sign-in (P4 Task 14): a hostile address stops at the field, and a
// hostile `next` never leaves the app.
const BIDI_EMAIL = "\u202eadmin\u202c@example.com";
const LONG_EMAIL = `${"a".repeat(300)}@example.com`;
const MARKUP_EMAIL = `<script>alert(1)</script>@example.com`;

for (const [kind, email] of [
  ["bidi", BIDI_EMAIL],
  ["long", LONG_EMAIL],
  ["markup", MARKUP_EMAIL],
] as const)
  test(`hostile ${kind} email on /sign-in`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sign-in?hosted=1&method=code");
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Enter a valid email address.",
    );
    // Still the address step: no request went out and nothing rendered as markup.
    await expect(
      page.getByRole("textbox", { name: "Code", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(await page.locator("img[src=x], svg[onload]").count()).toBe(0);
    const sw = await page.evaluate(
      () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
    );
    expect(sw, "horizontal overflow px").toBeLessThanOrEqual(0);
  });

test("a hostile next never leaves the app", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in?hosted=1&next=%2F%2Fevil.example");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2F");
  // The guest link drops it too; the code request carries the safe next and
  // sign-in lands on "/".
  const guest = page.getByRole("link", {
    name: "Get a sign-in code",
    exact: true,
  });
  await expect(guest).toHaveAttribute("href", "/sign-in?method=code&next=%2F");
  await guest.click();
  await page.getByRole("textbox", { name: "Email" }).fill("guest@outside.org");
  await page.getByRole("button", { name: "Send code" }).click();
  await page
    .getByRole("textbox", { name: "Code", exact: true })
    .fill("24681357");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  expect(page.url()).not.toContain("evil.example");
});
