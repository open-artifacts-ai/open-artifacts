// #1100: the client side of the room's wire spec (artifact UkN5r8hpoXu9DYxG),
// against the mock room's flags: the hello frame's role, and the close codes
// 4401, 4403, 4404, 1007 and 1013.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { roomLog, startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
test.use({ viewport: { width: 1280, height: 800 } });

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

const open = async (
  page: Page,
  info: Parameters<typeof startRoom>[0],
  args: string[],
  query = "",
) => {
  room = await startRoom(info, page, args);
  await page.goto(`/a/${LANDING}?mock=doc${query}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
};

/** What the room printed: "conn n" per connection, "closing code" per close. */
const log = () => (room ? (roomLog.get(room) ?? []) : []);

/**
 * After the room closed a connection with `code`: a NEW socket opened (a log
 * line after the close), the doc is saved again, and nothing is shown.
 */
async function reconnectsAfter(page: Page, code: number) {
  const closing = (l: string) => l.startsWith(`closing ${code} `);
  await expect.poll(() => log().some(closing)).toBe(true);
  const at = log().findIndex(closing);
  await expect
    .poll(() =>
      log()
        .slice(at)
        .some((l) => l.startsWith("conn ")),
    )
    .toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
}

/**
 * The mock doc answers this currentVersion from ~600 ms in, before the room's
 * frame (1.2 s after connect), as the server would once it had saved: so the
 * pill can only tick if the page refetches on the event.
 */
const serverSavesAt = (page: Page, version: number) =>
  page.addInitScript((v) => {
    setTimeout(() => {
      (window as unknown as { __oaDocVersion: number }).__oaDocVersion = v;
    }, 600);
  }, version);
const pill = (page: Page, v: number) =>
  page.getByRole("button", { name: new RegExp(`^Version: v${v}\\b`) });
const prose = (page: Page) => page.locator(".ProseMirror");

test("hello read/access: a viewer reads only, no toolbar, no banner", async ({
  page,
}, info) => {
  await open(page, info, ["--hello", "read:access"]);
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await expect(page.getByText(/editing opens/)).toHaveCount(0);
});

test("hello edit: stays editable", async ({ page }, info) => {
  await open(page, info, ["--hello", "edit"]);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
  await expect(page.getByRole("toolbar")).toBeVisible();
});

test("hello read/room_full: reads only, says why, Try again reconnects", async ({
  page,
}, info) => {
  await open(page, info, ["--hello", "read:room_full"]);
  await expect(
    page.getByText("You can read; editing opens when someone leaves."),
  ).toBeVisible();
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  // Back in: the room greets again, still full.
  await expect(
    page.getByText("You can read; editing opens when someone leaves."),
  ).toBeVisible();
});

test("hello near the cap: warns and stays editable", async ({ page }, info) => {
  await open(page, info, ["--hello", "edit::1950000"]);
  await expect(
    page.getByText(
      "This doc is almost full (1.9 of 2 MB). Images take the most space.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("toolbar")).toBeVisible();
});

test("close 4403: no access, read-only, no retry", async ({ page }, info) => {
  await open(page, info, ["--close", "4403"]);
  await expect(page.getByRole("alert")).toHaveText(
    "You no longer have access.",
  );
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
});

test("close 4404: the doc is gone", async ({ page }, info) => {
  await open(page, info, ["--close", "4404"]);
  await expect(page.getByRole("alert")).toHaveText(
    "This doc was deleted. Its owner can restore it from Trash.",
  );
});

test("close 1007 once: resyncs and stays editable", async ({ page }, info) => {
  await open(page, info, ["--close-first", "1007"]);
  await reconnectsAfter(page, 1007);
});

test("close 1007 every time: stops after one resync and reports", async ({
  page,
}, info) => {
  await open(page, info, ["--close", "1007"]);
  await expect(page.getByRole("alert")).toHaveText(
    "This doc can't sync right now. Reload the page to try again. Copy any unsaved changes first.",
  );
});

test("close 4401 once: reconnects silently", async ({ page }, info) => {
  await open(page, info, ["--close-first", "4401"]);
  await reconnectsAfter(page, 4401);
});

test("close 1013 once: backs off and comes back", async ({ page }, info) => {
  await open(page, info, ["--close-first", "1013"]);
  await reconnectsAfter(page, 1013);
});

test("1013 on every connection: the reconnect gaps grow, not a steady 200 ms", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  // No jitter: the waits are exactly 750 ms, 1.5 s, 3 s, so a CI stall can
  // only stretch a gap, never reorder them.
  await page.addInitScript(() => {
    (window as unknown as { __oaJitter: number }).__oaJitter = 0;
  });
  await open(page, info, ["--close", "1013"]);
  // The room closes each settled connection 600 ms after it connected, and
  // stamps each close. The gap between two closes is 600 ms plus the wait the
  // client chose: 0.75 s, then 1.5 s, then 3 s (jitter fixed at 0).
  const closes = () =>
    log()
      .filter((l) => l.startsWith("closing 1013 "))
      .map((l) => Number(l.split(" ")[2]));
  await expect
    .poll(() => closes().length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(4);
  const t = closes();
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const [g1, g2, g3] = gaps;
  // Every gap is longer than y-websocket's own ~200 ms retry would give.
  expect(g1).toBeGreaterThan(600 + 700);
  expect(g2).toBeGreaterThan(g1);
  expect(g3).toBeGreaterThan(g2);
  // And each wait is well over the last (double, with the fixed 600 ms removed).
  expect(g2 - 600).toBeGreaterThan((g1 - 600) * 1.2);
  expect(g3 - 600).toBeGreaterThan((g2 - 600) * 1.2);
});

test("saved: the title bar says Saved as v5 for a moment and the version data refetches", async ({
  page,
}, info) => {
  let artifactGets = 0;
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      r.url().endsWith(`/api/v1/artifacts/${LANDING}`)
    )
      artifactGets++;
  });
  await open(page, info, ["--saved", "5"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  const before = artifactGets;
  await expect(
    page.getByRole("status").filter({ hasText: "Saved as v5" }),
  ).toBeVisible();
  await expect.poll(() => artifactGets).toBeGreaterThan(before);
  // And it goes back to plain Saved.
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible({ timeout: 8000 });
});

test("restored by someone else: says so, the pill ticks, the doc stays editable", async ({
  page,
}, info) => {
  await serverSavesAt(page, 7);
  await open(page, info, ["--restored", "3:7"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Restored v3 as v7" }),
  ).toBeVisible();
  await expect(pill(page, 7)).toBeVisible();
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a named save shows its name and the pill ticks", async ({
  page,
}, info) => {
  await serverSavesAt(page, 6);
  await open(page, info, ["--saved", "6:Before launch"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved as v6 (Before launch)" }),
  ).toBeVisible();
  await expect(pill(page, 6)).toBeVisible();
  if (process.env.SHOTS_DIR)
    await page.screenshot({
      path: `${process.env.SHOTS_DIR}/doc-titlebar-saved-named-1280.png`,
      clip: { x: 0, y: 0, width: 1280, height: 100 },
    });
});

test("an auto-save is quiet but the version pill still ticks", async ({
  page,
}, info) => {
  await serverSavesAt(page, 9);
  await open(page, info, ["--saved", "9::auto"]);
  await expect(pill(page, 9)).toBeVisible();
  // No note at all: the status line stays plain.
  await expect(page.getByText(/Saved as v9/)).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
});

test("without StrictMode the editor opens exactly one room socket", async ({
  page,
}, info) => {
  // The dev build's StrictMode mounts the editor twice, and the first room is
  // destroyed at once. Under the mock, MSW's passthrough still opens that
  // first socket a moment later (its stack is MSW's createConnection), which
  // is why two sockets show in dev. A build without StrictMode, as production
  // is, makes one.
  const created: string[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().endsWith("/doc")) created.push(ws.url());
  });
  await open(page, info, ["--hello", "edit"], "&strict=off");
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  // Rooms are created once (useDocRoom): the room log shows one connection.
  await expect
    .poll(() => log().filter((l) => l.startsWith("conn ")).length)
    .toBe(1);
  expect(created.length).toBe(1);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test("the restore note fits the title bar at 390", async ({ page }, info) => {
    await open(page, info, ["--restored", "3:7"]);
    // Where Share sits before the note: the note must not push it down a row.
    const shareY = async () =>
      (await page.getByRole("button", { name: "Share" }).boundingBox())?.y;
    const before = await shareY();
    const note = page
      .getByRole("status")
      .filter({ hasText: "Restored v3 as v7" });
    await expect(note).toBeVisible();
    expect(await shareY()).toBe(before);
    const box = await note.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    // The page does not scroll sideways, and the title bar's buttons stay in.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const name of [/Share/, /Comments/]) {
      const b = await page.getByRole("button", { name }).first().boundingBox();
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(390);
    }
    if (process.env.SHOTS_DIR)
      await page.screenshot({
        path: `${process.env.SHOTS_DIR}/doc-restore-note-390.png`,
      });
  });
});
