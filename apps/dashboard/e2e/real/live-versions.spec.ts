import { R } from "@oa/shared";
import type { Page, WebSocket } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// Live version updates against the real server: the R.events socket tells
// an open viewer about a new version in about 2 s. Untouched, it swaps in
// (option B); touched, the chip.
const page1 = (n: number) =>
  `<!doctype html><h1 id="v">version ${n}</h1><input id="note" aria-label="Note">`;

/**
 * Resolves on the R.events hello for `id`: from then on the viewer hears about
 * new versions. Call it before the goto, so the socket can't open unseen.
 */
const helloOn = (page: Page, id: string) =>
  new Promise<void>((resolve) => {
    const onSocket = (ws: WebSocket) => {
      if (!ws.url().includes(R.events(id))) return;
      ws.on("framereceived", ({ payload }) => {
        try {
          if (JSON.parse(String(payload)).type !== "hello") return;
        } catch {
          return;
        }
        page.off("websocket", onSocket);
        resolve();
      });
    };
    page.on("websocket", onSocket);
  });

/**
 * The cross-fade has finished: one frame left. artifactFrame() is strict, so
 * reading it while the old frame fades out fails on two elements.
 */
const swapped = (page: Page) =>
  expect(page.locator("iframe.oa-vframe")).toHaveCount(1, { timeout: 15_000 });

/**
 * "Updated to vN" is on screen for NOTE_MS only, too short to catch by polling
 * on a loaded CI runner: twice in WebKit (#1230) v3 swapped in and kept row 52,
 * yet an 8 s wait never saw its note. The page records each note itself
 * instead: when it showed, visible, and when it left. Call it before the goto.
 */
const recordNotes = (page: Page) =>
  page.addInitScript(() => {
    // The shell only: the artifact's own frame stays as it is.
    if (window !== window.top) return;
    const w = window as unknown as {
      __oaNotes: Record<number, { shown: number; gone?: number }>;
    };
    w.__oaNotes = {};
    // Shown means in the DOM and visible, so the times hold however LiveChip
    // renders the note: mounted and unmounted (today), or toggled by class,
    // style or `hidden` on it or an ancestor (the preload layer hides by
    // data-preload), which the observer below also watches.
    const visible = (el: Element) =>
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden";
    const look = () => {
      const now = performance.now();
      const on = new Set<number>();
      for (const el of document.querySelectorAll(".oa-lchip")) {
        const m = /Updated to v(\d+)/.exec(el.textContent ?? "");
        if (m && visible(el)) on.add(Number(m[1]));
      }
      for (const v of on) w.__oaNotes[v] ??= { shown: now };
      for (const [v, n] of Object.entries(w.__oaNotes))
        if (!on.has(Number(v)) && n.gone === undefined) n.gone = now;
    };
    addEventListener("DOMContentLoaded", () =>
      new MutationObserver(look).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "data-preload"],
      }),
    );
  });
const note = (page: Page, n: number) =>
  page.evaluate(
    (v) =>
      (
        window as unknown as {
          __oaNotes: Record<number, { shown: number; gone?: number }>;
        }
      ).__oaNotes[v] ?? null,
    n,
  );
/** The swap to v<n> is done: shown, alone, announced by its note. */
const swappedTo = async (page: Page, n: number) => {
  // A generous deadline, not the 2 s target: CI runners are slower.
  await expect(
    page.getByRole("button", { name: `Version: v${n} · Current` }),
  ).toBeVisible({ timeout: 15_000 });
  await swapped(page);
  await expect(artifactFrame(page).locator("#v")).toHaveText(`version ${n}`);
  expect(await note(page, n), `"Updated to v${n}" was shown`).not.toBeNull();
};
const publishVersion = (pat: string, id: string, n: number) =>
  fetch(`${APP}${R.versions(id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, format: "html", content: page1(n) }),
  }).then((r) => {
    expect(r.ok).toBe(true);
  });

test("publish v2 while v1 is open: it swaps in within about 2 s", {
  tag: "@smoke",
}, async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: page1(1),
  });
  const hello = helloOn(page, id);
  await recordNotes(page);
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  await hello;
  await publishVersion(member.pat, id, 2);
  await swappedTo(page, 2);
});
