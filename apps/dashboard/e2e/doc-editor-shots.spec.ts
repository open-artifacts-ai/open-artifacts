// #1100: the collaborative doc editor, against a local doc room
// (e2e/doc-room.mjs) with two people and an agent as remote collaborators.
// Writes PNGs to SHOTS_DIR (default: the test output folder).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const PORT = Number(process.env.OA_DOC_PORT) || 1235;
const DIR = process.env.SHOTS_DIR;

// One worker: each test gets a fresh room (and so a fresh doc) below.
test.describe.configure({ mode: "serial" });

let room: ChildProcess;
let roomArgs = ["--fakes"];
test.beforeEach(async ({ browserName: _b }, info) => {
  roomArgs = info.title.includes("size limit") ? ["--too-large"] : ["--fakes"];
  room = spawn(process.execPath, ["e2e/doc-room.mjs", ...roomArgs], {
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

const caretOf = (page: Page, name: string) =>
  page.locator(`.oa-doc-caret[data-key="${name}"]`);
const flagShown = (page: Page, name: string) =>
  caretOf(page, name)
    .locator(".oa-doc-flag")
    .evaluate((el) => getComputedStyle(el).opacity === "1");

const COMBOS = [
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
  ["dark", 390],
] as const;

for (const [scheme, width] of COMBOS) {
  test.describe(`${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 800 } });

    test("two people and an agent, while editing", async ({ page }, info) => {
      await openDoc(page, "doc");
      await expect(page.getByRole("toolbar")).toBeVisible();
      // Just arrived: every flag shows its name (round for people, square for the agent).
      await shot(page, info, `doc-editor-flags-open-${scheme}-${width}.png`);
      // Checklist items use the kit's checkboxes (one is ticked).
      await page
        .getByRole("heading", { name: "Checklist" })
        .scrollIntoViewIfNeeded();
      await shot(page, info, `doc-editor-checkboxes-${scheme}-${width}.png`);
      await expect(page.locator('.oa-doc-flag[data-kind="agent"]')).toHaveText(
        "Docs agent",
      );
      await expect(page.locator('.oa-doc-flag[data-kind="user"]')).toHaveText([
        "Maya Chen",
        "Sam Okafor",
      ]);
      // Bold and Heading 2 at the caret: bold the word "Checklist".
      await page
        .getByRole("heading", { name: "Checklist" })
        .click({ position: { x: 1, y: 8 } });
      for (let i = 0; i < "Checklist".length; i++)
        await page.keyboard.press("Shift+ArrowRight");
      await page.getByRole("button", { name: "Bold" }).click();
      await page
        .getByRole("heading", { name: "Checklist" })
        .click({ position: { x: 40, y: 8 } });
      await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        page.getByRole("button", { name: "Heading 2" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("status").filter({ hasText: "Saved" }),
      ).toBeVisible();
      // Flags open for 2 s after a move, then collapse to the caret and a dot.
      await page.waitForTimeout(2600);
      for (const n of ["Maya Chen", "Sam Okafor", "Docs agent"])
        expect(await flagShown(page, n), `${n} collapsed`).toBe(false);
      // Hovering a caret opens its flag; the others stay collapsed.
      const box = await caretOf(page, "Maya Chen").boundingBox();
      if (!box) throw new Error("no caret");
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await expect.poll(() => flagShown(page, "Maya Chen")).toBe(true);
      expect(await flagShown(page, "Sam Okafor")).toBe(false);
      expect(await flagShown(page, "Docs agent")).toBe(false);
      await shot(page, info, `doc-editor-${scheme}-${width}.png`);
      // The same, with the flags collapsed to dots (the pointer moved off).
      await page.mouse.move(2, 400);
      await page.waitForTimeout(2600);
      await shot(page, info, `doc-editor-flags-dots-${scheme}-${width}.png`);
    });
  });
}

for (const [scheme, width] of COMBOS) {
  test.describe(`details ${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 800 } });

    test("link popover with its error line", async ({ page }, info) => {
      await openDoc(page, "doc");
      await page.locator(".ProseMirror p").first().click();
      for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
      await page.getByRole("button", { name: "Link" }).click();
      const input = page.getByLabel("Link URL");
      await input.fill("javascript:alert(1)");
      await input.press("Enter");
      await expect(
        page.getByRole("alert").filter({ hasText: "Links must" }),
      ).toBeVisible();
      await shot(page, info, `doc-editor-link-error-${scheme}-${width}.png`);
    });

    test("a tooltip names the button and its shortcut", async ({
      page,
    }, info) => {
      await openDoc(page, "doc");
      await page.getByRole("button", { name: "Heading 1" }).hover();
      await expect(page.getByRole("tooltip")).toHaveText(
        /Heading 1\s*(Ctrl|⌘)/,
      );
      // Below the button, so it never covers the title or the Comments button.
      const button = await page
        .getByRole("button", { name: "Heading 1" })
        .boundingBox();
      const tip = await page
        .locator('[data-slot="tooltip-content"]')
        .boundingBox();
      if (!button || !tip) throw new Error("no boxes");
      expect(tip.y).toBeGreaterThanOrEqual(button.y + button.height - 1);
      await shot(page, info, `doc-editor-tooltip-${scheme}-${width}.png`);
    });

    test("shows the size limit and goes read-only", async ({ page }, info) => {
      await page.goto(`/a/${LANDING}?mock=doc`);
      await expect(page.locator(".ProseMirror")).toBeVisible();
      await page.getByText("Rollout").last().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" More text.");
      await expect(page.getByRole("alert")).toHaveText(
        "This doc is at its size limit for your plan.",
      );
      await expect(page.locator(".ProseMirror")).toHaveAttribute(
        "contenteditable",
        "false",
      );
      await expect(page.getByRole("toolbar")).toHaveCount(0);
      await shot(page, info, `doc-editor-size-limit-${scheme}-${width}.png`);
    });
  });
}

for (const [scheme, width] of COMBOS) {
  test.describe(`overlay ${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 800 } });
    test("the editing column sits on the rendered Markdown", async ({
      page,
    }, info) => {
      const ref = JSON.parse(
        execFileSync(process.execPath, ["e2e/md-ref.mjs"], {
          encoding: "utf8",
        }),
      ) as { html: string; css: string };
      await openDoc(page, "doc-readonly");
      await page.evaluate(({ html, css }) => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
        const scroll = document.querySelector<HTMLElement>(".oa-doc-scroll");
        if (!scroll) throw new Error("no scroll area");
        scroll.style.position = "relative";
        const el = document.createElement("div");
        el.className = "oa-ref";
        el.id = "md-ref";
        el.style.cssText =
          "position:absolute;top:0;left:0;right:0;margin:0 auto;opacity:.5;pointer-events:none;background:transparent";
        el.innerHTML = html;
        scroll.append(el);
      }, ref);
      // The title field sits above the doc's first block in the editor, so
      // slide the rendered copy down by that much, then compare.
      await page.evaluate(() => {
        const ed = document.querySelector(".ProseMirror h1");
        const ref = document.querySelector("#md-ref h1");
        const el = document.querySelector<HTMLElement>("#md-ref");
        if (!ed || !ref || !el) throw new Error("no h1");
        el.style.top = `${ed.getBoundingClientRect().top - ref.getBoundingClientRect().top}px`;
      });
      // Same top, height and left edge for the same blocks, both ways.
      const rects = (root: string) =>
        page.evaluate((sel) => {
          const r = document.querySelector(sel);
          const rect = (e: Element) => {
            const b = e.getBoundingClientRect();
            return [b.top, b.height, b.left, b.width].map(
              (n) => Math.round(n * 10) / 10,
            );
          };
          return [
            "h1",
            "p",
            "h2",
            "li",
            "code",
            ":scope > p:nth-of-type(2)",
          ].map((t) => {
            const e = r?.querySelector(t);
            return e ? rect(e) : null;
          });
        }, root);
      const a = await rects(".ProseMirror");
      const b = await rects("#md-ref");
      console.log("editor", JSON.stringify(a), "\nrender", JSON.stringify(b));
      a.forEach((x, i) => {
        const y = b[i];
        expect(x && y, `block ${i}`).toBeTruthy();
        if (!x || !y) return;
        // Top and height within 1 px; left and width within 1 px.
        for (let k = 0; k < 4; k++)
          expect(
            Math.abs(x[k] - y[k]),
            `block ${i} field ${k}`,
          ).toBeLessThanOrEqual(1.5);
      });
      await shot(page, info, `doc-editor-overlay-${scheme}-${width}.png`);
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
