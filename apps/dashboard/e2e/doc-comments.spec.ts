// #1100: comments on a doc. (a) Page-level comments work with no frame
// bridge and no pins: the list opens, a new comment with an @-mention posts,
// an ask's pick posts. (b) "Comment" on a selection puts it in the
// whole-page composer as a Markdown quote, then a blank line, then the
// cursor; several lines become one quoted paragraph each. At 1280 and 390,
// light and dark, with axe. Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { expect, type Page, type Request, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

let room: ChildProcess | undefined;
let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
});
test.afterEach(async () => {
  await stopRoom(room);
  expect(errors).toEqual([]);
});

const shot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (x) =>
          x.playState !== "running" ||
          x.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
  });
};
async function axe(page: Page) {
  // A just-posted comment's tint fades in: measuring mid-way reads blended
  // colours.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (x) =>
          x.playState !== "running" ||
          x.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, {
      resultTypes: ["violations"],
      // Not the doc's: every artifact's thread header reads "Whole page" but
      // is named "Show in page: comment" (reported to the lead).
      rules: { "label-content-name-mismatch": { enabled: false } },
    });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; nodes: { html: string }[] }) =>
          `${x.id}: ${x.nodes.map((n) => n.html.slice(0, 160)).join(" | ")}`,
      );
  });
  expect(v).toEqual([]);
}

const open = async (
  page: Page,
  info: Parameters<typeof startRoom>[0],
  query: string,
) => {
  room = await startRoom(info, page, []);
  await page.goto(`/a/${LANDING}?mock=doc${query}`);
  // The room has synced the doc's text.
  await expect(page.locator(".ProseMirror")).toContainText("We ship");
};
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Comment on the whole page" });

/** Selects from the start of block `from` to the end of block `to` (or part of one). */
const select = (
  page: Page,
  from: string,
  to: string,
  part?: [number, number],
) =>
  page.evaluate(
    ({ from, to, part }) => {
      const blocks = [
        ...document.querySelectorAll<HTMLElement>(".ProseMirror > *"),
      ];
      // includes: a checklist's text starts with its boxes' hidden labels.
      const a = blocks.find((b) => b.textContent?.includes(from));
      const b = blocks.find((x) => x.textContent?.includes(to));
      if (!a || !b) throw new Error("no block");
      const r = document.createRange();
      if (part) {
        const t = document.createTreeWalker(a, NodeFilter.SHOW_TEXT).nextNode();
        if (!t) throw new Error("no text");
        r.setStart(t, part[0]);
        r.setEnd(t, part[1]);
      } else {
        r.setStart(a, 0);
        r.setEnd(b, b.childNodes.length);
      }
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    },
    { from, to, part },
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("(a) page-level comments: post with an @-mention, pick an ask, no pins", async ({
        page,
      }, info) => {
        await open(page, info, "&asks=1");
        // The list opens from the title bar (a column, or a sheet on a phone).
        await page.getByRole("button", { name: /^Comments/ }).click();
        const box = composer(page);
        await expect(box).toBeVisible();
        // A doc has no pins.
        await expect(page.getByRole("button", { name: /^Pin/ })).toHaveCount(0);
        const posted = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" &&
            r.url().endsWith(`/api/v1/artifacts/${LANDING}/comments`),
        );
        await box.click();
        await page.keyboard.type("Please check this @Cla");
        await page.getByRole("option", { name: /Claude Code/ }).click();
        await page.keyboard.type("thanks");
        await page
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        const body = (await posted).postDataJSON();
        expect(body).toMatchObject({
          anchor: { kind: "note" },
          mentions: [{ key: "agent:claude-code" }],
        });
        expect(body.body).toContain("@Claude Code");
        await expect(page.getByText(/Please check this/).first()).toBeVisible();
        // An ask for me: pick B.
        const picked = page.waitForRequest(
          (r: Request) => r.method() !== "GET" && /\/comments\//.test(r.url()),
        );
        await page.getByRole("button", { name: /Compact hero/ }).click();
        await picked;
        await expect(
          page.getByRole("button", { name: "Change" }),
        ).toBeVisible();
        await shot(page, info, `doc-comments-${scheme}-${width}.png`);
        await axe(page);
      });

      test("(b) Comment on a selection: a quote, a blank line, then the cursor", async ({
        page,
      }, info) => {
        await open(page, info, "");
        // Part of one line: "landing page".
        await select(page, "We ship", "We ship", [16, 28]);
        const button = page.locator(".oa-doc-selcomment").getByRole("button", {
          name: "Comment",
        });
        await expect(button).toBeVisible();
        await shot(page, info, `doc-comment-selection-${scheme}-${width}.png`);
        await button.click();
        const box = composer(page);
        await expect(box).toBeFocused();
        await expect(box).toHaveValue("> landing page\n\n");
        // The cursor is after the blank line: typing goes there.
        await page.keyboard.type("Is this the right name?");
        await expect(box).toHaveValue(
          "> landing page\n\nIs this the right name?",
        );
        await shot(page, info, `doc-comment-quoted-${scheme}-${width}.png`);
        const posted = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" &&
            r.url().endsWith(`/api/v1/artifacts/${LANDING}/comments`),
        );
        await page
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        expect((await posted).postDataJSON()).toMatchObject({
          anchor: { kind: "note" },
          body: "> landing page\n\nIs this the right name?",
        });
        await axe(page);
      });

      test("(b) several lines become one quoted paragraph each, ahead of anything typed", async ({
        page,
      }, info) => {
        await open(page, info, "");
        // Where the list sits beside the doc (1280), a note typed first
        // stays after the quote; on a phone the sheet covers the doc, so
        // the selection comes first there.
        const beside = width > 600;
        if (beside) {
          await page.getByRole("button", { name: /^Comments/ }).click();
          await composer(page).click();
          await page.keyboard.type("Typed first.");
        }
        await select(page, "Checklist", "Final copy");
        await page
          .locator(".oa-doc-selcomment")
          .getByRole("button", { name: "Comment" })
          .click();
        await expect(composer(page)).toHaveValue(
          `> Checklist\n>\n> Final copy reviewed\n>\n> Hero image exported\n>\n> Analytics events checked\n\n${beside ? "Typed first." : ""}`,
        );
        await expect(composer(page)).toBeFocused();
      });

      test("(b) a reader can comment on a selection too", async ({
        page,
      }, info) => {
        await open(page, info, "-readonly");
        await select(page, "We ship", "We ship", [16, 28]);
        await page
          .locator(".oa-doc-selcomment")
          .getByRole("button", { name: "Comment" })
          .click();
        await expect(composer(page)).toHaveValue("> landing page\n\n");
      });
    });
