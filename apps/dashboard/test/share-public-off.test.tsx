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
const group = () => screen.findByRole("radiogroup", { name: "Visibility" });
const REASON =
  "Public links are off for Exec. A space manager can turn them on.";

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

it("Public stays visible but disabled in a public-off space, with the reason", async () => {
  open([
    serve({ access: "manager", space: exec, can: full, visibility: "team" }),
  ]);
  const g = await group();
  const pub = within(g).getByRole("radio", { name: "Public" });
  expect(pub).toBeDisabled();
  expect(screen.getByText(REASON)).toBeVisible();
  expect(pub).toHaveAttribute("aria-describedby");
  expect(
    document.getElementById(pub.getAttribute("aria-describedby") as string),
  ).toHaveTextContent(REASON);
  expect(within(g).getByRole("radio", { name: "Private" })).toBeEnabled();
  expect(within(g).getByRole("radio", { name: "Team" })).toBeEnabled();
  // Sharing with people works as today.
  expect(screen.getByRole("heading", { name: "Add people" })).toBeVisible();
});

it("an artifact that's already public in a public-off space stays public: its link keeps working", async () => {
  open([
    serve({ access: "manager", space: exec, can: full, visibility: "public" }),
  ]);
  const g = await group();
  const pub = within(g).getByRole("radio", { name: "Public" });
  expect(pub).toBeChecked();
  expect(screen.getByText(REASON)).toBeVisible();
  // Choosing Team stages it; Public can then be chosen back (nothing was saved).
  fireEvent.click(within(g).getByRole("radio", { name: "Team" }));
  expect(within(g).getByRole("radio", { name: "Team" })).toBeChecked();
});

it("no space (self-hosted): the Share panel is unchanged", async () => {
  open();
  const g = await group();
  expect(within(g).getByRole("radio", { name: "Public" })).toBeEnabled();
  expect(screen.queryByText(/A space manager can turn them on\./)).toBeNull();
});

it("a public-on space: Public is available and no reason shows", async () => {
  open([
    serve({ access: "manager", space: eng, can: full, visibility: "team" }),
  ]);
  const g = await group();
  expect(within(g).getByRole("radio", { name: "Public" })).toBeEnabled();
  expect(screen.queryByText(/A space manager can turn them on\./)).toBeNull();
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
  fireEvent.click(within(g).getByRole("radio", { name: "Public" }));
  fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: /public/i,
    }),
  );
  await findVisibleToast(
    "Public links are off for this space. A space manager can turn them on.",
  );
  expect(screen.queryByText("server text")).toBeNull();
  await waitFor(() =>
    expect(within(g).getByRole("radio", { name: "Team" })).toBeChecked(),
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
  expect(screen.queryByRole("radio", { name: "Public" })).toBeNull();
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

it("hosted help text names the space on Private and the org on Team (D6 section 9)", async () => {
  open([
    serve({ access: "manager", space: eng, can: full, visibility: "private" }),
  ]);
  const g = await group();
  expect(
    screen.getByText("People with access to Engineering, and anyone you add"),
  ).toBeVisible();
  fireEvent.click(within(g).getByRole("radio", { name: "Team" }));
  expect(screen.getByText("Everyone at Acme Artifacts")).toBeVisible();
  fireEvent.click(within(g).getByRole("radio", { name: "Public" }));
  expect(screen.getByText("Anyone with the link, no sign-in")).toBeVisible();
});

it("self-hosted help text is unchanged", async () => {
  open();
  await group();
  expect(
    screen.getByText(
      /Only you and the people below can open it\.|Everyone in the workspace can open it\.|Anyone with the link can view\./,
    ),
  ).toBeVisible();
});
