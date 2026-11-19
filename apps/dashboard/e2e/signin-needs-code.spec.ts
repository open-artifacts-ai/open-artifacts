// #2590 G2: after Google turns a guest away, /sign-in?error=needs_code&link=1
// shows the masked address the server holds (GET /auth/code/link) and asks for
// a code with { link: true }, same-origin; no address ever in the URL.
import { expect, type Request, test } from "@playwright/test";

test("needs_code with link=1: the masked address in the note, and a code on request", async ({
  page,
}) => {
  // glink=1 is the mock's stand-in for the oa_glink cookie.
  await page.goto("/sign-in?hosted=1&error=needs_code&link=1&glink=1&next=%2F");
  await expect(
    page.getByText(
      "Google couldn't confirm s***@partner.org. We'll email a code to that address. After that, Google works.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveCount(0);
  expect(page.url()).not.toContain("partner");
  const sent = page.waitForRequest(
    (r: Request) =>
      r.method() === "POST" && r.url().endsWith("/auth/code/request"),
  );
  await page.getByRole("button", { name: "Email me a code" }).click();
  const req = await sent;
  // Same-origin, so the cookie goes along; no address in the body.
  expect(new URL(req.url()).origin).toBe(new URL(page.url()).origin);
  expect(req.postDataJSON()).toEqual({ link: true, next: "/" });
  await expect(page.getByRole("textbox", { name: "Code" })).toBeVisible();
});
