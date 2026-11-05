// Final copy: Design, 2026-10-21 (p4-error-copy.md), verbatim.
import type { ErrorCode } from "@oa/shared";
import { expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import { errorCopy, errorLink } from "../src/api/errorCopy";

it.each([
  [
    "space_forbidden",
    "You can't publish to this space. Ask a space manager to make you an editor.",
  ],
  [
    "space_personal",
    "Personal spaces can't be used here. Pick a shared space.",
  ],
  [
    "space_not_empty",
    "This space still has artifacts. Move or delete them first. Deleted ones stay in Trash for 30 days.",
  ],
  [
    "public_links_off",
    "Public links are off for this space. A space manager can turn them on.",
  ],
  ["use_move", "This artifact already exists. Use Move to change its space."],
  [
    "invalid_successor",
    "Pick an active member who isn't a guest or restricted.",
  ],
  [
    "member_active",
    "This person is active again, so their artifacts stay with them. Nothing was moved.",
  ],
  [
    "directory_sync_off",
    "Directory sync is off, so this isn't available right now.",
  ],
  ["turnstile_required", "Finish the check above, then send the code again."],
  ["turnstile_failed", "The check didn't go through. Try it again."],
  [
    "restrict_admin",
    "Owners and admins can't be restricted. Make them a member first.",
  ],
  [
    "reauth_required",
    "For your security, sign in with Google again to manage the directory.",
  ],
  // Design, 2026-10-28 (the upload refusals, #775).
  [
    "unsupported_format",
    "This type of file can't be opened yet. Upload a web page, Markdown, code or a PDF.",
  ],
  [
    "binary_entry",
    "This file isn't text, so it can't open as a web page, Markdown or code. Check that its file extension matches what it is.",
  ],
])("%s", (code, copy) => {
  expect(
    errorCopy(new ApiClientError(code as ErrorCode, "server text", 400), "x"),
  ).toBe(copy);
});

it("other codes fall back to the server message, then the fallback", () => {
  expect(
    errorCopy(new ApiClientError("not_found", "Not found", 404), "x"),
  ).toBe("Not found");
  expect(errorCopy(new Error("boom"), "Couldn't save.")).toBe("Couldn't save.");
});

it("a capped caller's space_forbidden says why asking won't help", () => {
  const e = new ApiClientError("space_forbidden", "server text", 403);
  expect(errorCopy(e, "x", { capped: true })).toBe(
    "Your account can only view, so you can't publish.",
  );
  expect(errorCopy(e, "x", { capped: false })).toBe(errorCopy(e, "x"));
});

it("directory_sync_off links to directory settings off the Directory page", () => {
  const e = new ApiClientError("directory_sync_off", "server text", 409);
  expect(errorLink(e)).toEqual({
    label: "Open directory settings",
    to: "/settings/directory",
  });
  expect(errorLink(e, { onDirectoryPage: false })).toEqual({
    label: "Open directory settings",
    to: "/settings/directory",
  });
  expect(errorLink(e, { onDirectoryPage: true })).toBeNull();
  expect(errorCopy(e, "x", { onDirectoryPage: false })).toBe(
    "Directory sync is off, so this isn't available right now.",
  );
});

it("no link for other errors", () => {
  expect(
    errorLink(new ApiClientError("space_forbidden", "server text", 403)),
  ).toBeNull();
  expect(errorLink(new Error("boom"))).toBeNull();
});

it("a HEIC refusal names the photo and says to export it", () => {
  const e = new ApiClientError("unsupported_format", "server text", 400, {
    path: "photos/IMG_0042.HEIC",
    reason: "heic",
  });
  expect(errorCopy(e, "x")).toBe(
    "IMG_0042.HEIC can't be opened here. Export it as JPEG or PNG, then upload it again.",
  );
});
