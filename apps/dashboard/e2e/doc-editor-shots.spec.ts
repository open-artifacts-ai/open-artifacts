// #1100: the collaborative doc editor, against a local doc room
// (e2e/doc-room.mjs) with two people and an agent as remote collaborators.
// Writes PNGs to SHOTS_DIR (default: the test output folder).
import { type ChildProcess, spawn } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const PORT = Number(process.env.OA_DOC_PORT) || 1235;
const DIR = process.env.SHOTS_DIR;

// One worker: each test gets a fresh room (and so a fresh doc) below.
test.describe.configure({ mode: "serial" });

let room: ChildProcess;
test.beforeEach(async () => {
  room = spawn(process.execPath, ["e2e/doc-room.mjs", "--fakes"], {
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

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const shot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await settle(page);
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
  });
};

async function openDoc(page: Page, mock: "doc" | "doc-readonly") {
  await page.goto(`/a/${LANDING}?mock=${mock}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.getByText("Launch plan")).toBeVisible();
  // Three remote cursors: two people, one agent.
  await expect(page.locator(".oa-doc-caret")).toHaveCount(3);
}

for (const [scheme, width] of [
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
] as const) {
  test.describe(`${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 800 } });

    test("two people and an agent, while editing", async ({ page }, info) => {
      await openDoc(page, "doc");
      await expect(page.getByRole("toolbar")).toBeVisible();
      await expect(page.locator('.oa-doc-flag[data-kind="agent"]')).toHaveText(
        "Docs agent",
      );
      await expect(page.locator('.oa-doc-flag[data-kind="user"]')).toHaveText([
        "Maya Chen",
        "Sam Okafor",
      ]);
      // Edit: add a sentence at the very end of the doc.
      const last = page.locator(".ProseMirror p").last();
      const box = await last.boundingBox();
      if (!box) throw new Error("no paragraph");
      // Bottom right of the last paragraph: the caret lands after its last word.
      await last.click({
        position: { x: box.width - 2, y: box.height - 2 },
      });
      await page.keyboard.type(" Questions go in the comments.");
      await expect(
        page.getByRole("status").filter({ hasText: /Saved|Saving/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: "Saved" }),
      ).toBeVisible();
      await shot(page, info, `doc-editor-${scheme}-${width}.png`);
    });
  });
}

test.describe("read-only viewer", () => {
  test.use({ colorScheme: "light", viewport: { width: 1280, height: 800 } });
  test("has no toolbar and cannot edit", async ({ page }, info) => {
    await openDoc(page, "doc-readonly");
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await shot(page, info, "doc-editor-readonly-light-1280.png");
  });
});
