// A query error never reads as "no results": each list says it couldn't load,
// with Retry, instead of an empty list or "No matching …".
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { GroupPicker } from "../src/settings/GroupPicker";
import { installHarness, mount, mountHosted, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const ENG = "SpEngNpQrSt2uVwX";
const ENG_PAGE = `/settings/spaces?space=${ENG}`;
const notFound = (path: string) =>
  http.get(`*${path}`, () =>
    HttpResponse.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404 },
    ),
  );
const region = (name: string) => screen.findByRole("region", { name });

// -- Part 1: Add people

it("Add people: a failed search shows the error with Retry, not No one found", async () => {
  mountHosted(ENG_PAGE, true, undefined, [notFound(R.spaceCandidates(ENG))]);
  fireEvent.click(
    within(await region("People")).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  const box = within(d).getByRole("combobox", { name: "People" });
  fireEvent.change(box, { target: { value: "da" } });
  const alert = await within(d).findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load the people you can add.");
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeVisible();
  // The search stays, so Retry runs it again.
  expect(box).toHaveValue("da");
  expect(within(d).queryByRole("option")).toBeNull();
  expect(d).not.toHaveTextContent("Pick at least one person.");
});

// -- Part 2: GroupPicker

it("GroupPicker: a failed search says so, not No matching groups", async () => {
  server.use(notFound(R.directoryGroups));
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <GroupPicker label="Add a group" onPick={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Add a group" }), {
    target: { value: "eng" },
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't search groups.");
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByText("No matching groups.")).toBeNull();
});

// -- Part 3: the sweep

it("Spaces: a failed list says so, not 0 shared spaces", async () => {
  mountHosted("/settings/spaces", true, undefined, [notFound(R.spaces)]);
  const card = await region("Spaces");
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't load spaces.",
  );
  expect(card).not.toHaveTextContent("0 shared spaces");
});

it("Every space: failed groups say so", async () => {
  mountHosted("/settings/spaces", true, undefined, [notFound(R.orgMappings)]);
  const card = await region("Every space");
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't load the groups for every space.",
  );
});

it("Who gets access: failed groups say so", async () => {
  mountHosted(ENG_PAGE, true, undefined, [notFound(R.spaceMappings(ENG))]);
  const card = await region("Who gets access");
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't load this space's groups.",
  );
});

it("Restricted groups: a failed list says so", async () => {
  mountHosted("/settings/directory", true, undefined, [
    notFound(R.restrictedGroups),
  ]);
  const card = await region("Restricted groups");
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't load restricted groups.",
  );
});

it("Share: failed shares say so, not only the owner", async () => {
  const OWNED = (
    fixtures.artifacts.find((a) => a.title === "Landing page") as {
      id: string;
    }
  ).id;
  server.use(notFound(R.shares(OWNED)));
  mount(`${viewerPath(OWNED)}?panel=open&tab=share`);
  expect(
    await screen.findByText("Couldn't load who it's shared with."),
  ).toBeVisible();
});

const CAROL = "Cr7tNpQrSt8uVwXy";
const openTransfer = async () => {
  const card = await region("Departed");
  const row = (await within(card).findByText("Carol Departed")).closest(
    "li",
  ) as HTMLElement;
  fireEvent.click(
    within(row).getByRole("button", {
      name: "Transfer Carol Departed's artifacts",
    }),
  );
  return screen.findByRole("dialog");
};

it("Transfer: failed spaces say so, not an empty picker", async () => {
  mountHosted("/settings/members", true, undefined, [notFound(R.spaces)]);
  const d = await openTransfer();
  fireEvent.click(within(d).getByRole("radio", { name: /To a space/ }));
  expect(await within(d).findByRole("alert")).toHaveTextContent(
    "Couldn't load spaces.",
  );
  expect(within(d).queryByRole("combobox", { name: "Space" })).toBeNull();
});

it("Transfer: failed people say so, not an empty picker", async () => {
  // Only the unfiltered list fails: the Departed card still loads.
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.members}`, ({ request }) =>
      new URL(request.url).searchParams.has("status")
        ? undefined
        : HttpResponse.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 },
          ),
    ),
    http.get(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json({ live: 2, deleted: 0 }),
    ),
  ]);
  const d = await openTransfer();
  expect(await within(d).findByRole("alert")).toHaveTextContent(
    "Couldn't load people.",
  );
  expect(
    within(d).queryByRole("combobox", { name: "Give them to" }),
  ).toBeNull();
});

// -- Part 4: Transfer loads every shared space

it("Transfer: the space picker offers spaces past the first page", async () => {
  // Page one is the mock's shared spaces; page two adds Zeta.
  const mocks = createHandlers({ hosted: true });
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.spaces}`, async ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor");
      url.searchParams.delete("cursor");
      const res = await getResponse(
        mocks,
        new Request(url, { headers: request.headers }),
      );
      const first = (await res?.json()) as {
        items: Record<string, unknown>[];
      };
      return cursor
        ? HttpResponse.json({
            items: [
              { ...first.items[0], id: "SpZetNpQrSt9uVwX", name: "Zeta" },
            ],
            nextCursor: null,
          })
        : HttpResponse.json({ items: first.items, nextCursor: "p2" });
    }),
  ]);
  const d = await openTransfer();
  fireEvent.click(within(d).getByRole("radio", { name: /To a space/ }));
  fireEvent.click(await within(d).findByRole("combobox", { name: "Space" }));
  expect(await screen.findByRole("option", { name: "Zeta" })).toBeVisible();
});
