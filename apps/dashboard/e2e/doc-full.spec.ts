// #1100: a doc at its limit offers New doc only to someone the Library would
// offer it to (docs on, may create), and always Version history. The room
// (e2e/doc-room.mjs --full) reports doc_too_large to every client.
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { roomLog, startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
test.use({ viewport: { width: 1280, height: 800 } });

let room: ChildProcess | undefined;
test.beforeEach(async ({ page }, info) => {
  room = await startRoom(info, page, ["--full"]);
});
test.afterEach(async () => {
  await stopRoom(room);
});

const open = async (page: import("@playwright/test").Page, query: string) => {
  await page.goto(`/a/${LANDING}?mock=doc${query}`);
  // Each step waits on its own signal, so a slow (cold) start fails on the
  // step that was slow: the editor mounted, the page reached the room, then
  // the room's doc_too_large (sent 150 ms after a connection) shows.
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect
    .poll(() =>
      (room ? (roomLog.get(room) ?? []) : []).some((l) =>
        l.startsWith("conn "),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("alert")).toHaveText("This doc is full (2 MB).");
  await expect(
    page.getByRole("button", { name: "Version history" }),
  ).toBeVisible();
};

test("a member sees New doc beside the full message", async ({ page }) => {
  await open(page, "");
  await expect(page.getByRole("button", { name: "New doc" })).toBeVisible();
});

test("a guest does not", async ({ page }) => {
  await open(page, "&role=guest");
  await expect(page.getByRole("button", { name: "New doc" })).toHaveCount(0);
});

test("a read-only cap does not", async ({ page }) => {
  await open(page, "&cap=plan");
  await expect(page.getByRole("button", { name: "New doc" })).toHaveCount(0);
});

test("an instance whose docs need Workers Paid does not", async ({ page }) => {
  await open(page, "&docs=needs_paid");
  await expect(page.getByRole("button", { name: "New doc" })).toHaveCount(0);
});
