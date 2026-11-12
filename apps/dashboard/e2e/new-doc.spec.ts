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
      await expect(prose).toBeVisible();
      await expect(prose).toBeFocused();
      await expect(page.locator("p.oa-doc-empty")).toBeVisible();
      await shot(page, `new-doc-blank-${tag}.png`);
    });

    test("on a free self-host the note says why", async ({ page }) => {
      await page.goto("/?mock=newdoc-gate");
      const note = page.getByRole("region", {
        name: "Docs need Cloudflare's Workers Paid plan",
      });
      await expect(note).toBeVisible();
      await page.getByRole("button", { name: "New doc" }).click();
      await expect(note).toBeFocused();
      await shot(page, `new-doc-gate-${tag}.png`);
    });
  });
}
