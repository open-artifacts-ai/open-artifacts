/// <reference types="node" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { artifactFrame, expect, test, uniq } from "./fixtures";

const INDEX =
  '<!doctype html><link rel="stylesheet" href="style.css"><h1 id="t">Styled</h1>';
const STYLE = "#t { color: rgb(255, 0, 0); }";

/** Names the artifact in the open upload dialog, creates it and checks the style applied. */
async function createAndCheck(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Create artifact" });
  await expect(dialog).toContainText("2 files selected");
  const title = `Site ${uniq()}`;
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/a\/[^/]+\/v\/1$/);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(artifactFrame(page).locator("#t")).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );
}

test("a folder with index.html and style.css uploads and the style applies", {
  tag: "@smoke",
}, async ({ page, member: _ }) => {
  const dir = mkdtempSync(join(tmpdir(), "oa-e2e-upload-"));
  const site = join(dir, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), INDEX);
  writeFileSync(join(site, "style.css"), STYLE);
  try {
    await page.goto("/");
    // WebKit occasionally never resolves a directory setInputFiles even though
    // the change event fired (seen once in ~170 runs; the dialog was open).
    // The dialog below is the real signal, so don't block on the call itself.
    const picking = page
      .getByTestId("upload-folder")
      .setInputFiles(site)
      .catch(() => {});
    await createAndCheck(page);
    void picking;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
