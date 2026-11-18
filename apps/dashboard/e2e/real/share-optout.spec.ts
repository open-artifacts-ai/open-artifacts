// #2590 / PR #2649: the "Don't email me again" page against the real server.
// The confirm page's form POST carries no X-OA-Request header, so it must get
// past the server's CSRF middleware in a real browser (Chromium and WebKit),
// even with a signed-in session cookie. Also writes the pages and the share
// email as 390 px shots, light and dark, to SHOTS_DIR when it is set.
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Request, TestInfo } from "@playwright/test";
import { APP, expect, freshEmail, loginAs, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 } });

const PATH = "/auth/unsubscribe/shares";
const SCHEMES = ["light", "dark"] as const;

/**
 * A link the way the server mints it (apps/server/src/email/share-optout.ts):
 * `v1.<sha256 of the address>.<hmac>`, HMAC keyed by HKDF(SESSION_SECRET).
 * The secret is the throwaway one global-setup gave this run's dev server.
 */
function mint(email: string): string {
  const secret = process.env.OA_E2E_SESSION_SECRET;
  if (!secret) throw new Error("OA_E2E_SESSION_SECRET: set by global-setup");
  const hash = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  const key = Buffer.from(
    hkdfSync("sha256", secret, "open-artifacts/hkdf/v1", "oa:share-optout", 32),
  ).toString("base64url");
  const sig = createHmac("sha256", key)
    .update(`v1:share-email-off:${hash}`)
    .digest("base64url");
  return `v1.${hash}.${sig}`;
}

const link = (t: string) => `${APP}${PATH}?t=${encodeURIComponent(t)}`;

/** Saves a 390 px shot as <page>-390-<theme>-<browser>.png under SHOTS_DIR, when set. */
async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: join(dir, `${name}-390-${scheme}-${info.project.name}.png`),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("share opt-out page (#2590)", () => {
  test("the confirm page changes nothing, its button POST passes CSRF with a session cookie, and a repeat is fine", async ({
    page,
  }, info) => {
    const email = freshEmail("optout");
    // A signed-in browser: the case the CSRF middleware guards.
    await loginAs(page, email, "member");
    const t = mint(email);
    const posts: Request[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes(PATH)) posts.push(r);
    });

    // GET: a button, and nothing happens. Twice, so a scanner prefetch is harmless.
    for (let i = 0; i < 2; i++) {
      const res = await page.goto(link(t));
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Stop emails from",
      );
      await expect(page.getByRole("button")).toBeVisible();
    }
    expect(posts).toHaveLength(0);
    expect(res_csp(await page.request.get(link(t)))).toContain(
      "form-action 'self'",
    );
    await shot(page, info, "optout-confirm");

    // The button: a real form POST with no X-OA-Request header.
    const [post] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().includes(PATH),
      ),
      page.getByRole("button").click(),
    ]);
    expect(post.status(), await post.text()).toBe(200);
    expect(post.request().headers()["x-oa-request"]).toBeUndefined();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "again.",
    );
    await expect(page.getByRole("button")).toHaveCount(0);
    await shot(page, info, "optout-done");

    // A second POST (the session cookie rides along, still no header): still the done page.
    const again = await page.request.post(`${APP}${PATH}`, { form: { t } });
    expect(again.status()).toBe(200);
    expect(await again.text()).toContain("again.");
    // One-click (RFC 8058): the token in the URL.
    const one = await page.request.post(link(t), {
      form: { "List-Unsubscribe": "One-Click" },
    });
    expect(one.status()).toBe(200);
    // And the GET afterwards is still the confirm page: it never reports a state.
    await page.goto(link(t));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Stop emails from",
    );
  });

  test("a bad or tampered token shows the bad-link page, on GET and POST", async ({
    page,
  }, info) => {
    const good = mint(freshEmail("optout"));
    for (const t of [
      "",
      "nope",
      `${good.slice(0, -2)}xx`,
      `v2.${good.slice(3)}`,
    ]) {
      const res = await page.goto(link(t));
      expect(res?.status(), t).toBe(400);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "This link is not valid",
      );
      await expect(page.getByRole("button")).toHaveCount(0);
      const post = await page.request.post(`${APP}${PATH}`, { form: { t } });
      expect(post.status(), t).toBe(400);
    }
    await page.goto(link("nope"));
    await shot(page, info, "optout-bad-link");
  });

  test("the share email with its footer, at 390 wide", async ({
    page,
  }, info) => {
    const t = mint(freshEmail("optout"));
    // The server's own template, rendered from source.
    const src = new URL(
      "../../../server/src/email/templates.ts",
      import.meta.url,
    );
    const m = (await import(/* @vite-ignore */ src.href)) as {
      outsideShareEmail: (p: unknown) => { html: string };
    };
    const { html } = m.outsideShareEmail({
      inviter: "Sam Rivera",
      instance: "Acme Studio",
      recipient: "guest@example.org",
      appHost: "oa.example.com",
      signIn: ["email"],
      title: "Q3 launch plan",
      path: "/a/Zk3m9qLw",
      senderEmail: "sam@acme.test",
      optOutUrl: `https://oa.example.com${PATH}?t=${encodeURIComponent(t)}`,
    });
    await page.setContent(html);
    await expect(page.getByRole("link", { name: /again/ })).toBeVisible();
    await shot(page, info, "optout-email");
  });
});

/** The CSP header of a response, for the form-action check. */
const res_csp = (r: { headers: () => Record<string, string> }) =>
  r.headers()["content-security-policy"] ?? "";
