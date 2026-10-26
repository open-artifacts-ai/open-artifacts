// Hosted P4 Task 8: move an artifact to another shared space (Design D3/D4,
// answers of 2026-10-22). The Details panel's Move opens a list of the spaces
// you can publish to (never Personal, never the current one); moving out of
// Personal is one-way; a public artifact moved into a public-off space asks
// first and becomes Team.
import { type ArtifactSummary, type Me, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import {
  calls,
  findVisibleToast,
  installHarness,
  mount,
  mountHosted,
  server,
} from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

const arts = fixtures.artifacts as ArtifactSummary[];
const byTitle = (t: string) =>
  arts.find((a) => a.title === t) as ArtifactSummary;
const NOTES = byTitle("Meeting notes").id;
const LANDING = byTitle("Landing page").id;
const ENG_REF = {
  id: "SpEngNpQrSt2uVwX",
  kind: "shared" as const,
  name: "Engineering",
  publicLinks: true,
};
const OPS = {
  id: "SpOpsNpQrSt5uVwX",
  kind: "shared" as const,
  name: "Ops",
  publicLinks: false,
  myRole: "editor" as const,
};
const OPS_REF = {
  id: OPS.id,
  kind: "shared" as const,
  name: "Ops",
  publicLinks: false,
};
const managerCan = {
  edit: true,
  share: true,
  setVisibility: true,
  delete: true,
  transfer: false,
  move: true,
  dataWrite: true,
};
const notes = (o: object = {}) => ({
  ...byTitle("Meeting notes"),
  access: "manager",
  space: ENG_REF,
  can: managerCan,
  ...o,
});
const withOps = (m: Me): Me => ({ ...m, spaces: [...(m.spaces ?? []), OPS] });
/** The Details panel's Space value (the dd after the "Space" dt). */
const spaceValue = () =>
  screen.getByText("Space", { selector: "dt" }).nextElementSibling;
const details = (id: string) => `/a/${id}?panel=open&tab=details`;
const openMove = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  return screen.findByRole("dialog");
};

it("self-hosted: no Move, even for the owner", async () => {
  mount(details(LANDING));
  expect(
    await screen.findByRole("button", { name: "Delete artifact" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
});

it("hosted: the panel shows the space, and Move when there's somewhere to go", async () => {
  mountHosted(details(LANDING));
  expect(await screen.findByRole("button", { name: "Move" })).toBeVisible();
  expect(spaceValue()).toHaveTextContent("Personal");
});

it("no eligible target: Move is hidden", async () => {
  // Meeting notes is in Engineering; Exec is view-only; Personal never counts.
  mountHosted(details(NOTES));
  await screen.findByRole("button", { name: "Delete artifact" });
  expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
});

it("targets: spaces you can publish to, with your role; never Personal or the current space", async () => {
  mountHosted(details(NOTES), true, withOps);
  const d = await openMove();
  expect(
    within(d).getByRole("heading", { name: 'Move "Meeting notes" to' }),
  ).toBeVisible();
  expect(
    within(d)
      .getAllByRole("radio")
      .map((r) => r.closest("label")?.textContent),
  ).toEqual(["OpsEditor"]);
});

it("space to space: who gains and who loses access", async () => {
  mountHosted(details(NOTES), true, withOps);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  expect(d).toHaveTextContent(
    "Ops members get access. People only in Engineering lose it.",
  );
});

it("out of Personal: one-way, with the space's name and member count", async () => {
  mountHosted(details(LANDING));
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Engineering/ }));
  expect(
    await within(d).findByText(
      /^Engineering's \d+ members? gets? access by their role\. You can't move it back to Personal\.$/,
    ),
  ).toBeVisible();
});

it("out of Personal, without a count: People in <target>", async () => {
  mountHosted(details(LANDING), true, undefined, [
    http.get("*/api/v1/spaces", () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Engineering/ }));
  expect(d).toHaveTextContent(
    "People in Engineering get access by their role. You can't move it back to Personal.",
  );
});

it("Move sends the target and the panel shows the new space, with a toast", async () => {
  const seen = calls("POST");
  mountHosted(details(LANDING));
  const d = await openMove();
  expect(within(d).getByRole("button", { name: "Move" })).toBeDisabled();
  fireEvent.click(within(d).getByRole("radio", { name: /^Engineering/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  await waitFor(() =>
    expect(seen.find((c) => c.path === R.moveArtifact(LANDING))?.body).toEqual({
      spaceId: ENG_REF.id,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await findVisibleToast("Moved to Engineering.");
  await waitFor(() => expect(spaceValue()).toHaveTextContent("Engineering"));
});

it("a public artifact into a public-off space asks first, then becomes Team", async () => {
  const seen = calls("POST");
  mountHosted(details(NOTES), true, withOps, [
    http.get(`*${R.artifact(NOTES)}`, () =>
      HttpResponse.json(notes({ visibility: "public" })),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  const c = await screen.findByRole("alertdialog");
  expect(
    within(c).getByRole("heading", { name: 'Move "Meeting notes" to Ops?' }),
  ).toBeVisible();
  expect(c).toHaveTextContent(
    "Public links are off in Ops, so this link stops working and the artifact becomes visible to everyone at Acme Artifacts.",
  );
  expect(seen.some((x) => x.path === R.moveArtifact(NOTES))).toBe(false);
  server.use(
    http.get(`*${R.artifact(NOTES)}`, () =>
      HttpResponse.json(notes({ visibility: "team", space: OPS_REF })),
    ),
    http.post(`*${R.moveArtifact(NOTES)}`, () =>
      HttpResponse.json(notes({ visibility: "team", space: OPS_REF })),
    ),
  );
  fireEvent.click(
    within(c).getByRole("button", { name: "Move and turn off link" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(spaceValue()).toHaveTextContent("Ops"));
});

it("a team artifact into a public-off space needs no confirm", async () => {
  mountHosted(details(NOTES), true, withOps, [
    http.post(`*${R.moveArtifact(NOTES)}`, () =>
      HttpResponse.json(notes({ space: OPS_REF })),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("space_forbidden keeps the dialog open with the copy, and no toast", async () => {
  mountHosted(details(NOTES), true, withOps, [
    http.post(`*${R.moveArtifact(NOTES)}`, () =>
      HttpResponse.json(
        { error: { code: "space_forbidden", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  expect(
    await within(d).findByText(
      "You can't publish to this space. Ask a space manager to make you an editor.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Couldn't move the artifact.")).toBeNull();
});

it("409 conflict: a status in the open dialog, no alert, no toast; Move is the retry, choosing again clears it", async () => {
  // A second target, so there is something else to choose.
  const withOpsAndDesign = (m: Me): Me => {
    const two = withOps(m);
    return {
      ...two,
      spaces: [
        ...(two.spaces ?? []),
        { ...OPS, id: "SpDesNpQrSt7uVwXy", name: "Design" },
      ],
    };
  };
  mountHosted(details(NOTES), true, withOpsAndDesign, [
    http.post(`*${R.moveArtifact(NOTES)}`, () =>
      HttpResponse.json(
        { error: { code: "conflict", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  const note = await within(d).findByText(
    "This artifact just changed. Check it and try again.",
  );
  expect(note).toHaveAttribute("role", "status");
  expect(within(d).queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Couldn't move the artifact.")).toBeNull();
  expect(screen.queryByText("server text")).toBeNull();
  // The dialog stays open and Move is the retry.
  expect(within(d).getByRole("button", { name: "Move" })).toBeEnabled();
  // Choosing another space clears the line.
  fireEvent.click(within(d).getByRole("radio", { name: /^Design/ }));
  expect(
    within(d).queryByText(
      "This artifact just changed. Check it and try again.",
    ),
  ).toBeNull();
});

it("space_personal (defensive) shows its copy", async () => {
  mountHosted(details(NOTES), true, withOps, [
    http.post(`*${R.moveArtifact(NOTES)}`, () =>
      HttpResponse.json(
        { error: { code: "space_personal", message: "server text" } },
        { status: 400 },
      ),
    ),
  ]);
  const d = await openMove();
  fireEvent.click(within(d).getByRole("radio", { name: /^Ops/ }));
  fireEvent.click(within(d).getByRole("button", { name: "Move" }));
  expect(
    await within(d).findByText(
      "Personal spaces can't be used here. Pick a shared space.",
    ),
  ).toBeVisible();
});
