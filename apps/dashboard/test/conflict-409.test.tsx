// 409 conflict (#534's compare-and-set): the artifact changed between read and
// write. Design: "This artifact just changed. Check it and try again." inline,
// small warning text, role=status; the artifact is refetched; it clears on the
// next edit or a successful save.
import { type ArtifactSummary, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

const COPY = "This artifact just changed. Check it and try again.";
const LANDING = (
  (fixtures.artifacts as ArtifactSummary[]).find(
    (a) => a.title === "Landing page",
  ) as ArtifactSummary
).id;
const conflict = (method: "patch" | "post", path: string) =>
  http[method](path, () =>
    HttpResponse.json(
      { error: { code: "conflict", message: "server text" } },
      { status: 409 },
    ),
  );
const refetched = (gets: { path: string }[]) =>
  gets.filter((c) => c.path === R.artifact(LANDING)).length;

it("Details: a 409 keeps your edits, says so above Save, refetches; typing clears it", async () => {
  const gets = calls("GET");
  mount(`/a/${LANDING}?panel=open&tab=details`);
  const title = await screen.findByRole("textbox", { name: "Title" });
  // conflict on save
  const { server } = await import("./harness");
  server.use(conflict("patch", `*${R.artifact(LANDING)}`));
  fireEvent.change(title, { target: { value: "Landing page, mine" } });
  const before = refetched(gets);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const note = await screen.findByText(COPY);
  expect(note).toHaveAttribute("role", "status");
  expect(title).toHaveValue("Landing page, mine");
  expect(screen.queryByText("server text")).toBeNull();
  await waitFor(() => expect(refetched(gets)).toBeGreaterThan(before));
  fireEvent.change(title, { target: { value: "Landing page, mine!" } });
  expect(screen.queryByText(COPY)).toBeNull();
});

it("Move: a 409 keeps the dialog open with the note above its buttons, and refetches", async () => {
  const gets = calls("GET");
  mountHosted(`/a/${LANDING}?panel=open&tab=details`, true, undefined, [
    conflict("post", `*${R.moveArtifact(LANDING)}`),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  const d = await screen.findByRole("dialog");
  fireEvent.click(within(d).getByRole("radio", { name: /^Engineering/ }));
  const before = refetched(gets);
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  const note = await within(d).findByText(COPY);
  expect(note).toHaveAttribute("role", "status");
  expect(screen.getByRole("dialog")).toBeVisible();
  await waitFor(() => expect(refetched(gets)).toBeGreaterThan(before));
  // Move is the retry: picking again clears it.
  fireEvent.click(within(d).getByRole("radio", { name: /^Engineering/ }));
});

it("Share: a 409 puts the toggle back to the server's value, with the note under it", async () => {
  const gets = calls("GET");
  mount(`/a/${LANDING}?panel=open&tab=share`);
  const group = await screen.findByRole("radiogroup", { name: "Visibility" });
  const { server } = await import("./harness");
  server.use(conflict("patch", `*${R.artifact(LANDING)}`));
  fireEvent.click(within(group).getByRole("radio", { name: /Team/ }));
  const before = refetched(gets);
  fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
  const note = await screen.findByText(COPY);
  expect(note).toHaveAttribute("role", "status");
  await waitFor(() =>
    expect(
      within(group).getByRole("radio", { name: /Private/ }),
    ).toHaveAttribute("aria-checked", "true"),
  );
  expect(screen.queryByText("server text")).toBeNull();
  await waitFor(() => expect(refetched(gets)).toBeGreaterThan(before));
  // Picking again clears it.
  fireEvent.click(within(group).getByRole("radio", { name: /Public/ }));
  expect(screen.queryByText(COPY)).toBeNull();
});
