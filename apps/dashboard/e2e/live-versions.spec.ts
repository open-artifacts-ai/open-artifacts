// Live version updates (mock, Design option B): a version published while
// the viewer is open swaps in when provably safe (following Current, the
// frame said hello and is untouched, nothing open), otherwise the chip.
import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { DEBOUNCE_MS } from "../src/viewer/useLiveVersions";

/** The debounce plus slack for a loaded runner: a deadline, not a budget. */
const LIVE_MS = DEBOUNCE_MS + 3_000;

const LANDING = "Cd5fGhJkLm6nPqRs"; // owned, private, v2 current

/** The artifact: says hello, and reports the first pointerdown like the runtime. */
const ARTIFACT = `<!doctype html><style>body{font:16px system-ui;margin:24px}</style>
<script>
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
  addEventListener("pointerdown", () =>
    parent.postMessage({ oa: 1, type: "interacted", nonce }, "*"), { once: true });
</script><h1>Q3 pipeline</h1><input aria-label="Note" value="Follow up with Ac">`;

test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: ARTIFACT }),
  );
});

/** Publishes a new version through the mock API, as an agent would. */
const publish = (page: Page, id = LANDING) =>
  page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/artifacts/${id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, format: "html", content: "<p>next</p>" }),
    });
    return ((await r.json()) as { version: number }).version;
  }, id);

const restore = (page: Page, v: number, id = LANDING) =>
  page.evaluate(
    async ({ id, v }) => {
      await fetch(`/api/v1/artifacts/${id}/versions/${v}/restore`, {
        method: "POST",
      });
    },
    { id, v },
  );

const del = (page: Page, id = LANDING) =>
  page.evaluate(async (id) => {
    await fetch(`/api/v1/artifacts/${id}`, { method: "DELETE" });
  }, id);

/** The frame said hello (the slow notice is off and the bridge is live). */
const loaded = async (page: Page) => {
  await expect(page.locator(".oa-vlayer iframe.oa-vframe")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __oaEvents: { connections(id: string): number };
          }
        ).__oaEvents.connections(location.pathname.split("/")[2] ?? ""),
      ),
    )
    .toBe(1);
  // Let the frame's hello land.
  await page.waitForTimeout(300);
};

const touchFrame = (page: Page) =>
  page.frameLocator("iframe.oa-vframe").getByRole("heading").click();

/** Attached to the report; also saved to $SHOTS_DIR (the PR's shots). */
const shot = async (page: Page, name: string) => {
  // Past the 200 ms enter animation.
  await page.waitForTimeout(250);
  const body = await page.screenshot();
  await test.info().attach(name, { body, contentType: "image/png" });
  if (process.env.SHOTS_DIR)
    writeFileSync(`${process.env.SHOTS_DIR}/${name}.png`, body);
};

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    const tag = `${width}-${theme}`;
    test.describe(`${tag}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 720 });
      });

      test(`dashboard: untouched swaps quietly within 2 s (${tag})`, async ({
        page,
      }) => {
        await page.goto(`/a/${LANDING}`);
        await loaded(page);
        const before = await page
          .locator("iframe.oa-vframe")
          .getAttribute("src");
        const v = await publish(page);
        const note =
          width < 640
            ? page.getByText("Updated", { exact: true })
            : page.getByText(`Updated to v${v}`);
        await expect(note).toBeVisible({ timeout: LIVE_MS });
        await expect(
          page.getByRole("button", { name: `Version: v${v} · Current` }),
        ).toBeVisible();
        // Design (option C): a brief "Updated to vN", no Undo, gone in about 3 s.
        await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(
          0,
        );
        await expect(note).toHaveCount(0, { timeout: 5_000 });
        await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
        const after = await page
          .locator("iframe.oa-vframe")
          .getAttribute("src");
        expect(after?.split("#oa=")[1]).not.toBe(before?.split("#oa=")[1]);
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: `Updated to version ${v}.` }),
        ).toHaveCount(1);
        await shot(page, `swapped-dashboard-${tag}`);
      });

      test(`dashboard: touched shows the chip, View swaps (${tag})`, async ({
        page,
      }) => {
        await page.goto(`/a/${LANDING}`);
        await loaded(page);
        await touchFrame(page);
        const before = await page
          .locator("iframe.oa-vframe")
          .getAttribute("src");
        const v = await publish(page);
        const view = page.getByRole("button", { name: `View version ${v}` });
        await expect(view).toBeVisible({ timeout: LIVE_MS });
        await expect(
          page.getByText(width < 640 ? `v${v}` : `v${v} available`, {
            exact: true,
          }),
        ).toBeVisible();
        // Never swapped: same frame load.
        expect(await page.locator("iframe.oa-vframe").getAttribute("src")).toBe(
          before,
        );
        if (width >= 640)
          await expect(page.getByTestId("versions-dot").first()).toBeVisible();
        await shot(page, `chip-dashboard-${tag}`);
        await view.click();
        await expect(view).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: `Version: v${v} · Current` }),
        ).toBeVisible();
        await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
      });

      test(`/full: untouched swaps, touched gets the pill (${tag})`, async ({
        page,
      }) => {
        await page.goto(`/a/${LANDING}/full`);
        await loaded(page);
        let v = await publish(page);
        await expect(page.getByText(`Updated to v${v}`)).toBeVisible({
          timeout: LIVE_MS,
        });
        await shot(page, `swapped-full-${tag}`);
        await expect(page.getByText(`Updated to v${v}`)).toHaveCount(0, {
          timeout: 5_000,
        });
        await touchFrame(page);
        v = await publish(page);
        const pill = page.getByRole("button", { name: `View version ${v}` });
        await expect(pill).toBeVisible({ timeout: LIVE_MS });
        await expect(pill).toHaveText(`v${v} available · View`);
        await shot(page, `chip-full-${tag}`);
        // Collapses to the 32px circle after 4 s.
        await expect(pill).toHaveAttribute("data-open", "false", {
          timeout: 6_000,
        });
        // The width transitions: measure once it has finished.
        await expect
          .poll(async () => (await pill.boundingBox())?.width)
          .toBe(32);
        await pill.click();
        await expect(pill).toHaveCount(0);
      });

      test(`restore while touched, then while untouched (${tag})`, async ({
        page,
      }) => {
        await page.goto(`/a/${LANDING}`);
        await loaded(page);
        await touchFrame(page);
        await restore(page, 1);
        const view = page.getByRole("button", { name: "View version 3" });
        await expect(view).toBeVisible({ timeout: LIVE_MS });
        if (width >= 640)
          await expect(page.getByText("v1 restored as v3")).toBeVisible();
        await view.click();
        await expect(view).toHaveCount(0);
        await page.waitForTimeout(300);
        await restore(page, 2);
        const note = page
          .locator(".oa-lchip")
          .getByText("Restored v2", { exact: true })
          .filter({ visible: true });
        await expect(note).toBeVisible({ timeout: LIVE_MS });
        await expect(
          page.getByRole("button", { name: "Version: v4 · Current" }),
        ).toBeVisible();
        await shot(page, `restored-${tag}`);
      });

      test(`deleted while open keeps the frame (${tag})`, async ({ page }) => {
        await page.goto(`/a/${LANDING}`);
        await loaded(page);
        // Deleted elsewhere (an agent): the mock emits gone "deleted".
        await del(page);
        await expect(
          page.locator(".oa-lgone").getByText("You deleted this artifact."),
        ).toBeVisible();
        await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
        await expect(
          page.getByRole("heading", { name: "Page not found" }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Restore" }),
        ).toBeVisible();
        if (width >= 640) {
          await expect(
            page.getByRole("button", { name: /^Version: v/ }),
          ).toBeDisabled();
          await expect(
            page.getByRole("button", { name: "Full screen" }),
          ).toBeDisabled();
        }
        await expect(
          page.getByRole("button", { name: "Share" }),
        ).toBeDisabled();
        await shot(page, `gone-dashboard-${tag}`);
      });

      test(`/full when gone: No longer available · Exit (${tag})`, async ({
        page,
      }) => {
        await page.goto(`/a/${LANDING}/full`);
        await loaded(page);
        // Deleted elsewhere (an agent): the mock emits gone, then 404s.
        await del(page);
        await expect(
          page.getByRole("link", { name: "No longer available · Exit" }),
        ).toBeVisible();
        await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
        await shot(page, `gone-full-${tag}`);
      });
    });
  }

test("an explicit version never swaps: Current is vN selects Current", async ({
  page,
}) => {
  await page.goto(`/a/${LANDING}/v/1`);
  await loaded(page);
  const hint = page.getByRole("button", { name: "Current is v2" });
  await expect(hint).toBeVisible();
  const v = await publish(page);
  await expect(
    page.getByRole("button", { name: `Current is v${v}` }),
  ).toBeVisible({
    timeout: LIVE_MS,
  });
  await expect(page.getByRole("button", { name: /View version/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Version: v1" })).toBeVisible();
  await page.getByRole("button", { name: `Current is v${v}` }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${LANDING}$`));
  await expect(
    page.getByRole("button", { name: `Version: v${v} · Current` }),
  ).toBeVisible();
});

test("an open menu means the chip, which stays until View", async ({
  page,
}) => {
  await page.goto(`/a/${LANDING}`);
  await loaded(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const v = await publish(page);
  // The menu is modal (the rest is aria-hidden): the chip shows under it.
  await expect(page.locator(".oa-lchip")).toContainText(`v${v} available`, {
    timeout: LIVE_MS,
  });
  await page.keyboard.press("Escape");
  const view = page.getByRole("button", { name: `View version ${v}` });
  await expect(view).toBeVisible();
  // Design: a version shown as a chip never auto-swaps later.
  await page.waitForTimeout(1_500);
  await expect(view).toBeVisible();
  await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
});

test("a burst of versions: one chip with the newest number", async ({
  page,
}) => {
  await page.goto(`/a/${LANDING}`);
  await loaded(page);
  await touchFrame(page);
  await publish(page);
  await publish(page);
  const v = await publish(page);
  await expect(
    page.getByRole("button", { name: `View version ${v}` }),
  ).toBeVisible({
    timeout: LIVE_MS,
  });
  await expect(page.getByRole("button", { name: /View version/ })).toHaveCount(
    1,
  );
});
