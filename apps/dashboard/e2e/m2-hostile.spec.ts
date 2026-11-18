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

test("hostile markup in names, labels and URLs stays inert on every surface", async ({
  page,
}) => {
  await hostile(page, X);
  for (const path of [
    "/",
    "/settings/connections",
    "/settings/members",
    "/settings/instance",
    "/sign-in",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    if (path === "/settings/connections")
      await page.getByRole("radio", { name: "Token" }).click();
    expect(
      await page.evaluate(() => (window as { __xss?: number }).__xss),
      path,
    ).toBeUndefined();
    expect(await page.locator("img[src=x], svg[onload]").count(), path).toBe(0);
  }
});
