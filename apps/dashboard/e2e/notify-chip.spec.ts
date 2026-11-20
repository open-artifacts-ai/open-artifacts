// #2610 part 2: a new thread's box shows the page's agent it will notify
// (PROVISIONAL api/pageAgent.ts; mock ?pageagent=own|teammate), on a plain
// note, on selected text and on a pin; ✕ opts the thread out. At 1280 and
// 390, light and dark, with axe. Needs `pnpm --filter @oa/runtime build`
// (the pin case loads the real runtime). PNGs to SHOTS_DIR when set.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const DIR = process.env.SHOTS_DIR;
const DIST = join(process.cwd(), "../../packages/runtime/dist");
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
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
type Violation = { id: string; impact: string; nodes: { html: string }[] };
type Axe = {
  run: (ctx: unknown, opts: object) => Promise<{ violations: Violation[] }>;
};
async function checkAxe(page: Page) {
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: Axe }).axe;
    const opts = { resultTypes: ["violations"] };
    // Not the chip's: thread headers and participant buttons on main are
    // named past their text ("Show in page: comment"); the chip itself is
    // checked with every rule on below.
    const page_ = await axe.run(document, {
      ...opts,
      rules: { "label-content-name-mismatch": { enabled: false } },
    });
    const chips = document.querySelectorAll("[data-notify-chip]");
    const own = chips.length
      ? (await axe.run([...chips], opts)).violations
      : [];
    const r = { violations: [...page_.violations, ...own] };
    return r.violations
      .filter((x) => x.impact === "serious" || x.impact === "critical")
      .map(
        (x) =>
          `${x.id}: ${x.nodes.map((n) => n.html.slice(0, 140)).join(" | ")}`,
      );
  });
  expect(v).toEqual([]);
}
const chip = (page: Page) => page.locator("[data-notify-chip]");
async function openComments(page: Page, query: string) {
  await page.goto(`/a/${ID}?${query}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Comment on the whole page" }),
  ).toBeVisible();
}
/** The frame's runtime says "comment.select": replay it with the frame's nonce. */
async function select(page: Page) {
  const src = await page.locator("iframe").first().getAttribute("src");
  const nonce = new URLSearchParams((src ?? "").split("#")[1] ?? "").get("oa");
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame?.evaluate((n) => {
    parent.postMessage(
      {
        oa: 1,
        nonce: n,
        type: "comment.select",
        anchor: {
          kind: "text",
          exact: "Chat is great for asking, and bad for keeping.",
          prefix: "",
          suffix: "",
        },
      },
      "*",
    );
  }, nonce);
}
/** An image page with the real runtime, for placing a pin (as pin-bubbles). */
async function serveImage(page: Page) {
  const manifest = JSON.parse(
    readFileSync(join(DIST, "runtime.manifest.json"), "utf8"),
  );
  const chart = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="900" height="560" fill="#fff"/><rect x="80" y="200" width="700" height="260" fill="#2350d0" opacity=".8"/></svg>')}`;
  const hello = `import("/_oa/${manifest["src/schemas.ts"].file}").then(()=>setTimeout(()=>parent.postMessage({oa:1,type:"hello",protocol:6,kind:"image",nonce:window.__nonce},"*"),0))`;
  await page.context().route("https://content.example.com/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith("/_oa/")) {
      const name = u.pathname.endsWith("/runtime.js")
        ? manifest["src/index.ts"].file
        : u.pathname.split("/").pop();
      return r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(join(DIST, name ?? ""), "utf8"),
      });
    }
    return r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta name="oa-format" content="image"><body style="margin:0;background:#eceef1"><div class="oa-image" style="padding:16px"><img alt="chart" src="${chart}" style="display:block;max-width:100%;margin:auto"></div><script>window.__nonce=new URLSearchParams(location.hash.slice(1)).get("oa")</script><script src="/_oa/runtime.js"></script><script>${hello}</script>`,
    });
  });
}

test.beforeAll(() => {
  expect(existsSync(join(DIST, "runtime.manifest.json"))).toBe(true);
});

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width, height: width === 390 ? 844 : 800 },
      });

      test("a plain note: Notifying {agent} ✕, with its tooltip", async ({
        page,
      }, info) => {
        await openComments(page, "mock=agents&pageagent=own");
        await expect(chip(page)).toBeVisible();
        await expect(chip(page)).toContainText("Notifying");
        await expect(chip(page)).toContainText("OA Design");
        const x = chip(page).getByRole("button", {
          name: "Stop notifying OA Design",
        });
        await x.hover();
        await expect(
          page.getByRole("tooltip", {
            name: "Stop notifying OA Design in this thread",
          }),
        ).toBeVisible();
        await shot(page, info, `notify-note-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("removed: no chip, and the thread opts out", async ({
        page,
      }, info) => {
        await openComments(page, "mock=agents&pageagent=own");
        await chip(page)
          .getByRole("button", { name: "Stop notifying OA Design" })
          .click();
        await expect(chip(page)).toHaveCount(0);
        await page
          .getByRole("textbox", { name: "Comment on the whole page" })
          .fill("Just a note for people");
        await shot(page, info, `notify-removed-${scheme}-${width}.png`);
        const post = page.waitForRequest(
          (r) =>
            r.method() === "POST" &&
            new URL(r.url()).pathname === `/api/v1/artifacts/${ID}/comments`,
        );
        await page
          .getByRole("complementary", { name: "Comments" })
          .or(page.getByRole("dialog", { name: "Comments" }))
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        expect((await post).postDataJSON()).toMatchObject({
          notifyPageAgent: false,
        });
      });

      test("a teammate's agent: {agent} · {person}'s agent", async ({
        page,
      }, info) => {
        await openComments(page, "mock=agents&pageagent=teammate");
        await expect(chip(page)).toContainText("OA Design · Leo's agent");
        await shot(page, info, `notify-teammate-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("a comment on selected text", async ({ page }, info) => {
        await openComments(page, "mock=agents&pageagent=own");
        await select(page);
        const box = page.getByRole("textbox", { name: "Add a comment" });
        await box.fill("Shorter?");
        const card = page.locator("[data-oa-composing]", { has: box });
        await expect(card.locator("[data-notify-chip]")).toBeVisible();
        await shot(page, info, `notify-selection-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("a pin", async ({ page }, info) => {
        await serveImage(page);
        await page.goto(`/a/${ID}?mock=pins&pageagent=own`);
        await page.getByRole("button", { name: /^Comments/ }).click();
        await page.getByRole("button", { name: "Pin", exact: true }).click();
        // On a phone the list is a sheet: close it to tap the page (pin mode stays).
        if (width === 390)
          await page.getByRole("button", { name: "Close comments" }).click();
        const img = page.frameLocator("iframe.oa-vframe").getByAltText("chart");
        await img.click({ position: { x: 120, y: 90 } });
        const box = page.getByRole("textbox", { name: "Add a comment" });
        await expect(box).toBeVisible();
        const card = page.locator("[data-oa-composing]", { has: box });
        await expect(card.locator("[data-notify-chip]")).toBeVisible();
        await shot(page, info, `notify-pin-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("a guest: no chip", async ({ page }, info) => {
        await page.goto(`/a/${ID}?role=guest&pageagent=teammate`);
        await page.getByRole("button", { name: /^Comments/ }).click();
        await expect(
          page.getByRole("textbox", { name: "Comment on the whole page" }),
        ).toBeVisible();
        await page.waitForTimeout(300);
        await expect(chip(page)).toHaveCount(0);
        await shot(page, info, `notify-guest-${scheme}-${width}.png`);
        await checkAxe(page);
      });
    });
