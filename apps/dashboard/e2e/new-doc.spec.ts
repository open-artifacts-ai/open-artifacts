// #1100: New doc in the Library (Design's docs mockup, step 1 and the
// self-hosted free-plan step). The created doc opens in the editor, served by a
// local doc room (e2e/doc-room.mjs). Writes PNGs to SHOTS_DIR when set.
import { type ChildProcess, spawn } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";

const PORT = Number(process.env.OA_DOC_PORT) || 1235;
const DIR = process.env.SHOTS_DIR;

test.describe.configure({ mode: "serial" });

let room: ChildProcess;
test.beforeEach(async () => {
  room = spawn(process.execPath, ["e2e/doc-room.mjs", "--blank"], {
    env: { ...process.env, OA_DOC_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    room.once("error", reject);
    room.once("exit", (code) => reject(new Error(`doc room exited ${code}`)));
    room.stdout?.on("data", (d) => {
      if (String(d).includes("ready")) resolve();
    });
  });
});
test.afterEach(async () => {
  room.removeAllListeners("exit");
  const closed = new Promise((r) => room.once("close", r));
  room.kill("SIGTERM");
  await closed;
});

const shot = async (page: Page, name: string) => {
  await page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
  if (DIR) await page.screenshot({ path: `${DIR}/${name}` });
};

for (const [scheme, width] of [
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
  ["dark", 390],
] as const) {
  test.describe(`${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 800 } });
    const tag = `${scheme}-${width}`;

    test("New doc opens a blank doc with the cursor in it", async ({
      page,
    }) => {
      await page.goto("/?mock=newdoc");
      await expect(
        page.getByText("Your agents can make docs too."),
      ).toBeVisible();
      await shot(page, `new-doc-library-${tag}.png`);
      await page.getByRole("button", { name: "New doc" }).click();
      await expect(page).toHaveURL(/\/a\/[^/?]+/);
      const prose = page.locator(".ProseMirror");
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      await expect(prose).toBeVisible();
      // The title opens focused with its text selected, and the toast says so.
      await expect(title).toBeFocused();
      await expect(title).toHaveValue("Untitled");
      expect(
        await title.evaluate((el: HTMLInputElement) => [
          el.selectionStart,
          el.selectionEnd,
        ]),
      ).toEqual([0, "Untitled".length]);
      await expect(
        page.getByText("Type a title, then press Enter to start writing."),
      ).toBeVisible();
      await expect(page.locator("p.oa-doc-empty")).toBeVisible();
      await shot(page, `new-doc-blank-${tag}.png`);
      // Typing replaces it; Enter moves to the body; it saves as the title.
      await page.keyboard.type("Launch plan");
      await page.keyboard.press("Enter");
      await expect(prose).toBeFocused();
      await expect(page.locator(".oa-viewer h1").first()).toHaveText(
        "Launch plan",
      );
      await page.keyboard.type("First line");
      await expect(prose).toContainText("First line");
      await shot(page, `new-doc-titled-${tag}.png`);
    });

    test("an existing doc opens with the cursor in the body", async ({
      page,
    }) => {
      await page.goto("/a/Cd5fGhJkLm6nPqRs?mock=doc");
      await expect(page.locator(".ProseMirror")).toBeFocused();
    });

    test("on a free self-host the note says why", async ({ page }) => {
      await page.goto("/?mock=newdoc-gate");
      const note = page.getByRole("region", {
        name: "Docs need Cloudflare's Workers Paid plan",
      });
      await expect(note).toBeVisible();
      // aria-disabled: Playwright would wait for it to enable; people can press it.
      await page
        .getByRole("button", { name: "New doc" })
        .click({ force: true });
      await expect(note).toBeFocused();
      await shot(page, `new-doc-gate-${tag}.png`);
    });
  });
}
