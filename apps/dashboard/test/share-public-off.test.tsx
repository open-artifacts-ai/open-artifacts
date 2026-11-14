// Hosted P4 Task 9: a space's public-links setting in the Share panel (Design
// D9 / Q7, G68RE4oKC9pH3cgr v7): "Public" stays visible but disabled with the
// reason; an artifact that is already public keeps working.
import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { findVisibleToast, installHarness, mount, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const art = fixtures.artifacts.find((a) => a.title === "Landing page") as {
  id: string;
  title: string;
  visibility: string;
};
const full = {
  edit: true,
  share: true,
  setVisibility: true,
  delete: true,
  transfer: false,
  move: true,
  dataWrite: true,
};
const exec = {
  id: "SpExcNpQrSt3uVwX",
  kind: "shared",
  name: "Exec",
  publicLinks: false,
};
const eng = {
  id: "SpEngNpQrSt2uVwX",
  kind: "shared",
  name: "Engineering",
  publicLinks: true,
};
const serve = (a: object) =>
  http.get(`*${R.artifact(art.id)}`, () => HttpResponse.json({ ...art, ...a }));
const open = (overrides: HttpHandler[] = []) => {
  server.use(...overrides);
  return mount(`${viewerPath(art.id)}?panel=open&tab=share`);
};
const group = () => screen.findByRole("radiogroup", { name: "General access" });
const REASON =
  "Sharing by link is off for Exec. A space manager can turn it on.";

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

it("Public stays visible but disabled in a public-off space, with the reason", async () => {
  open([
    serve({ access: "manager", space: exec, can: full, visibility: "team" }),
  ]);
  const g = await group();
  const pub = within(g).getByRole("radio", { name: "Anyone with the link" });
  expect(pub).toBeDisabled();
  expect(screen.getByText(REASON)).toBeVisible();
  // Its own line, then the reason.
  expect(pub).toHaveAccessibleDescription(
    `No login needed. It won't appear in search engines. ${REASON}`,
  );
  expect(within(g).getByRole("radio", { name: "Restricted" })).toBeEnabled();
  expect(
    within(g).getByRole("radio", { name: "Anyone at Acme Artifacts" }),
  ).toBeEnabled();
  // Sharing with people works as today.
  expect(screen.getByRole("heading", { name: "Add people" })).toBeVisible();
});

it("an artifact that's already public in a public-off space stays public: its link keeps working", async () => {
  open([
    serve({ access: "manager", space: exec, can: full, visibility: "public" }),
  ]);
  const g = await group();
  const pub = within(g).getByRole("radio", { name: "Anyone with the link" });
  expect(pub).toBeChecked();
  expect(screen.getByText(REASON)).toBeVisible();
  // Choosing Team stages it; Public can then be chosen back (nothing was saved).
  fireEvent.click(
    within(g).getByRole("radio", { name: "Anyone at Acme Artifacts" }),
  );
  expect(
    within(g).getByRole("radio", { name: "Anyone at Acme Artifacts" }),
  ).toBeChecked();
});

it("no space (self-hosted): the Share panel is unchanged", async () => {
  open();
  const g = await group();
  expect(
    within(g).getByRole("radio", { name: "Anyone with the link" }),
  ).toBeEnabled();
  expect(screen.queryByText(/A space manager can turn it on\./)).toBeNull();
});

it("a public-on space: Public is available and no reason shows", async () => {
  open([
    serve({ access: "manager", space: eng, can: full, visibility: "team" }),
  ]);
  const g = await group();
  expect(
    within(g).getByRole("radio", { name: "Anyone with the link" }),
  ).toBeEnabled();
  expect(screen.queryByText(/A space manager can turn it on\./)).toBeNull();
});

it("a 403 public_links_off from a stale tab shows the copy and keeps the old visibility", async () => {
  open([
    serve({ access: "manager", space: eng, can: full, visibility: "team" }),
    http.patch(`*${R.artifact(art.id)}`, () =>
      HttpResponse.json(
        { error: { code: "public_links_off", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  const g = await group();
  fireEvent.click(
    within(g).getByRole("radio", { name: "Anyone with the link" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
  await findVisibleToast(
    "Sharing by link is off for this space. A space manager can turn it on.",
  );
  expect(screen.queryByText("server text")).toBeNull();
  await waitFor(() =>
    expect(
      within(g).getByRole("radio", { name: "Anyone at Acme Artifacts" }),
    ).toBeChecked(),
  );
});

it("people can be shared without visibility rights (share true, setVisibility false)", async () => {
  open([
    serve({
      access: "editor",
      space: eng,
      can: { ...full, setVisibility: false, delete: false, move: false },
    }),
  ]);
  expect(
    await screen.findByRole("heading", { name: "Add people" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("radio", { name: "Anyone with the link" }),
  ).toBeNull();
});

it("an editor without share or setVisibility gets no Share button", async () => {
  server.use(
    serve({
      access: "editor",
      space: eng,
      can: {
        ...full,
        share: false,
        setVisibility: false,
        delete: false,
        move: false,
      },
    }),
  );
  mount(viewerPath(art.id));
  await screen.findByRole("heading", { name: art.title });
  expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
});

it("#2509: in a shared space Restricted keeps the space's wording; the others read the same everywhere", async () => {
  open([
    serve({ access: "manager", space: eng, can: full, visibility: "private" }),
  ]);
  const g = await group();
  expect(
    within(g).getByRole("radio", { name: "Restricted" }),
  ).toHaveAccessibleDescription(
    "People with access to Engineering, and anyone you add",
  );
  expect(
    within(g).getByRole("radio", { name: "Anyone at Acme Artifacts" }),
  ).toHaveAccessibleDescription("Every member of Acme Artifacts can open it.");
  expect(
    within(g).getByRole("radio", { name: "Anyone with the link" }),
  ).toHaveAccessibleDescription(
    "No login needed. It won't appear in search engines.",
  );
});

it("#2509: self-hosted lines are General access's own", async () => {
  open();
  const g = await group();
  expect(
    within(g).getByRole("radio", { name: "Restricted" }),
  ).toHaveAccessibleDescription("Only people you add can open it.");
});
