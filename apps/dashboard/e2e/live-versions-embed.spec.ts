// Live version updates in an embed (mock): anonymous, public only, framed by
// another site. Not safe to swap: only the collapsed pill, which opens
// /a/<id> in a new tab; never a name; gone is a non-link pill, no banner.
import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const PORT = process.env.PW_PORT ?? "5199";
const APP = `http://localhost:${PORT}`;
const ATTACKER = `http://127.0.0.1:${PORT}/__attacker`;
const POLL = "Gh9kLmNpQrAsTuVx"; // public

// The attacker page is fulfilled by a route, so Chrome counts it as public and
// would block it from framing a loopback address.
test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** The artifact: says hello, and reports the first pointerdown like the runtime. */
const ARTIFACT = `<!doctype html><style>body{font:16px system-ui;margin:24px}</style>
<script>
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
  addEventListener("pointerdown", () =>
    parent.postMessage({ oa: 1, type: "interacted", nonce }, "*"), { once: true });
</script><h1>Q3 pipeline</h1><input aria-label="Note" value="Follow up with Ac">`;

/** Attached to the report; also saved to $SHOTS_DIR (the PR's shots). */
const shot = async (page: Page, name: string) => {
  // Past the 200 ms enter animation.
  await page.waitForTimeout(250);
  const body = await page.screenshot();
  await test.info().attach(name, { body, contentType: "image/png" });
  if (process.env.SHOTS_DIR)
    writeFileSync(`${process.env.SHOTS_DIR}/${name}.png`, body);
};

test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: ARTIFACT }),
  );
});

test.describe("embed", () => {
  test.beforeEach(async ({ context }) => {
    await context.route(
      (u) => u.href.startsWith(ATTACKER),
      (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>attacker</title><iframe src="${APP}/a/${POLL}/full" style="width:800px;height:600px;border:0"></iframe>`,
        }),
    );
  });

  for (const theme of ["light", "dark"] as const)
    test(`the pill opens a new tab, never names (${theme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(ATTACKER);
      const app = page.frameLocator("iframe");
      await expect(app.locator("iframe.oa-vframe")).toBeVisible();
      const frame = page.frames().find((f) => f.url().startsWith(`${APP}/a/`));
      if (!frame) throw new Error("no app frame");
      await expect
        .poll(() =>
          frame.evaluate(
            (id) =>
              (
                window as unknown as {
                  __oaEvents: { connections(id: string): number };
                }
              ).__oaEvents.connections(id),
            POLL,
          ),
        )
        .toBe(1);
      // Framed, the events socket always says embed=1 (cookies ride on
      // WebSockets, so the server must treat it as anonymous).
      const urls = await frame.evaluate(
        () =>
          (window as unknown as { __oaEventsUrls: string[] }).__oaEventsUrls,
      );
      const ev = urls.filter((u) => u.includes(`/artifacts/${POLL}/events`));
      expect(ev.length).toBeGreaterThan(0);
      for (const u of ev)
        expect(new URL(u).searchParams.get("embed")).toBe("1");
      await page.waitForTimeout(300);
      await app.frameLocator("iframe.oa-vframe").getByRole("heading").click();
      await frame.evaluate(
        (id) =>
          (
            window as unknown as {
              __oaEvents: {
                emitVersion(
                  id: string,
                  e: { version: number; by: { kind: string; name: string } },
                ): number;
              };
            }
          ).__oaEvents.emitVersion(id, {
            version: 2,
            by: { kind: "agent", name: "Secret Agent" },
          }),
        POLL,
      );
      const pill = app.getByRole("link", {
        name: "Version 2 available, open Team poll in a new tab",
      });
      await expect(pill).toBeVisible({ timeout: 2_000 });
      // #2189: the pill is always open in the compact floating group.
      await expect(pill).toHaveAttribute("data-open", "true");
      await expect(pill).toHaveAttribute("target", "_blank");
      await expect(pill).toHaveAttribute("rel", "noopener");
      await expect(app.getByText("Secret Agent")).toHaveCount(0);
      await shot(page, `embed-collapsed-${theme}`);
      await pill.hover();
      await expect(pill).toContainText("v2 available · Open ↗");
      await shot(page, `embed-hover-${theme}`);
      // Made private by its owner: the anonymous embed can't read it now.
      await frame.evaluate(async (id) => {
        await fetch(`/api/v1/artifacts/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visibility: "private" }),
        });
      }, POLL);
      const gone = app.getByText("No longer available", { exact: true });
      await expect(gone).toBeVisible();
      await expect(
        app.getByRole("link", { name: /No longer available/ }),
      ).toHaveCount(0);
      await expect(app.locator("iframe.oa-vframe")).toHaveCount(1);
      await shot(page, `embed-gone-${theme}`);
    });
});
