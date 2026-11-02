// A deleted Workspace account: its row's address is released
// (removed+<id>@invalid) and never shown (Design's ruling on #828).
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import {
  personFirst,
  personFirstAtStart,
  personInSentence,
  personName,
  personNameAtStart,
} from "../src/layout/person";
import { initials, UserAvatar } from "../src/layout/UserAvatar";
import { findVisibleToast, installHarness, mountHosted } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

// The members list lowercases addresses; the stored row keeps the id's case.
const released = (id: string, name: string | null) => ({
  id,
  email: `removed+${id.toLowerCase()}@invalid`,
  name,
  role: "member" as const,
  lastSeenAt: null,
  status: "removed" as const,
});
/** No name of their own: the server's name falls back to the address. */
const nameless = (id: string) => released(id, `removed+${id}@invalid`);
const PAT = "Pa7tNpQrSt8uVwXy";
const NONE = "No7tNpQrSt8uVwXy";
const MANAGED =
  "This person's Google Workspace account was deleted, so they can't be restored. Invite them instead.";

const withGone = (gone: ReturnType<typeof released>) => [
  http.get(`*${R.members}`, ({ request }) =>
    HttpResponse.json(
      new URL(request.url).searchParams.get("status")
        ? [gone]
        : fixtures.members,
    ),
  ),
  http.get(`*${R.memberTransfer(gone.id)}`, () =>
    HttpResponse.json({ live: 2, deleted: 0 }),
  ),
];
const departed = () => screen.findByRole("region", { name: "Departed" });
const openRemoved = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Removed (1)" }));
  return screen.findByRole("list", { name: "Removed people" });
};

it("one released row parses, and doesn't take the Departed list down", async () => {
  const carol = {
    id: "Cr7tNpQrSt8uVwXy",
    email: "carol@example.com",
    name: "Carol Departed",
    role: "member" as const,
    lastSeenAt: null,
    status: "removed" as const,
  };
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.members}`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("status")
          ? [carol, nameless(NONE)]
          : fixtures.members,
      ),
    ),
    http.get("*/api/v1/members/:id/transfer", () =>
      HttpResponse.json({ live: 2, deleted: 0 }),
    ),
  ]);
  const card = await departed();
  await within(card).findByText("Carol Departed");
  await within(card).findByText("Former member");
  expect(card).toHaveTextContent("2 people left");
  expect(card).not.toHaveTextContent(/load/);
  expect(
    await screen.findByRole("button", { name: "Removed (2)" }),
  ).toBeVisible();
});

it("names: the name, else Former member, never the address", () => {
  const gone = { email: `removed+${PAT}@invalid` };
  expect(personName({ ...gone, name: "Pat Deleted" })).toBe("Pat Deleted");
  expect(personName({ ...gone, name: null })).toBe("Former member");
  // The server's name falls back to the email.
  expect(personName({ ...gone, name: gone.email })).toBe("Former member");
  expect(personInSentence({ ...gone, name: null })).toBe("a former member");
  expect(personInSentence({ ...gone, name: "Pat Deleted" })).toBe(
    "Pat Deleted",
  );
  expect(personFirst({ ...gone, name: "Pat Deleted" })).toBe("Pat");
  expect(personFirst({ ...gone, name: null })).toBe("a former member");
  // Anyone else is as before.
  expect(personName({ email: "bo@example.com", name: null })).toBe(
    "bo@example.com",
  );
  expect(personFirst({ email: "bo@example.com", name: null })).toBe("bo");
});

it("the avatar reads FM with no name, and never names the address", async () => {
  const email = `removed+${NONE}@invalid`;
  render(<UserAvatar name={null} email={email} />);
  const avatar = screen.getByRole("img", { name: "Former member" });
  expect(avatar).toHaveTextContent("FM");
  expect(initials("Bob Builder", "bob@example.com")).toBe("BB");
});

it("a named row keeps the name and drops the address line", async () => {
  mountHosted(
    "/settings/members",
    true,
    undefined,
    withGone(released(PAT, "Pat Deleted")),
  );
  const card = await departed();
  await within(card).findByText("Pat Deleted");
  const list = await openRemoved();
  expect(within(list).getByText("Pat Deleted")).toBeVisible();
  expect(document.body).not.toHaveTextContent("@invalid");
});

it("a nameless row reads Former member, and the page never shows the address", async () => {
  mountHosted("/settings/members", true, undefined, withGone(nameless(NONE)));
  const card = await departed();
  await within(card).findByText("Former member");
  const list = await openRemoved();
  expect(within(list).getByText("Former member")).toBeVisible();
  expect(document.body).not.toHaveTextContent("@invalid");
});

it("Restore is hidden on the Removed row, with the muted line", async () => {
  mountHosted("/settings/members", true, undefined, withGone(nameless(NONE)));
  const list = await openRemoved();
  const line = within(list).getByText(MANAGED);
  expect(line).toBeVisible();
  expect(line).not.toHaveAttribute("role", "alert");
  expect(within(list).queryByRole("button", { name: /^Restore/ })).toBeNull();
});

it("the Departed row keeps Transfer and hides Restore, with no muted line", async () => {
  mountHosted("/settings/members", true, undefined, withGone(nameless(NONE)));
  const card = await departed();
  await within(card).findByRole("button", { name: "Transfer all to me" });
  expect(within(card).queryByText(MANAGED)).toBeNull();
  fireEvent.pointerDown(
    within(card).getByRole("button", { name: "More for Former member" }),
    { button: 0, pointerType: "mouse" },
  );
  await screen.findByRole("menuitem", { name: "Transfer to someone else…" });
  expect(screen.queryByRole("menuitem", { name: "Restore…" })).toBeNull();
});

it("sentences say a former member: title, toast and failure", async () => {
  const gone = nameless(NONE);
  mountHosted("/settings/members", true, undefined, [
    ...withGone(gone),
    http.post(`*${R.memberTransfer(gone.id)}`, () =>
      HttpResponse.json({ moved: 2, remaining: 0, nextCursor: null }),
    ),
  ]);
  const card = await departed();
  fireEvent.click(
    await within(card).findByRole("button", { name: "Transfer all to me" }),
  );
  await findVisibleToast("Moved 2 artifacts from a former member to you.");
});

it("a failed run says Couldn't move a former member's artifacts", async () => {
  const gone = nameless(NONE);
  mountHosted("/settings/members", true, undefined, [
    ...withGone(gone),
    http.post(`*${R.memberTransfer(gone.id)}`, () =>
      HttpResponse.json(
        { error: { code: "internal", message: "" } },
        { status: 500 },
      ),
    ),
  ]);
  const card = await departed();
  fireEvent.click(
    await within(card).findByRole("button", { name: "Transfer all to me" }),
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't move a former member's artifacts. Try again.",
  );
});

it("the dialog's title says a former member", async () => {
  mountHosted("/settings/members", true, undefined, withGone(nameless(NONE)));
  const card = await departed();
  await within(card).findByText("Former member");
  fireEvent.pointerDown(
    within(card).getByRole("button", { name: "More for Former member" }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Transfer to someone else…" }),
  );
  const d = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(
      within(d).getByRole("heading", {
        name: "Transfer a former member's 2 personal artifacts",
      }),
    ).toBeVisible(),
  );
});

it("a named person keeps their first name in a failure", async () => {
  const gone = released(PAT, "Pat Deleted");
  mountHosted("/settings/members", true, undefined, [
    ...withGone(gone),
    http.post(`*${R.memberTransfer(gone.id)}`, () =>
      HttpResponse.json(
        { error: { code: "internal", message: "" } },
        { status: 500 },
      ),
    ),
  ]);
  const card = await departed();
  fireEvent.click(
    await within(card).findByRole("button", { name: "Transfer all to me" }),
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Couldn't move Pat's artifacts. Try again.",
  );
});

const GONE_EMAIL = `removed+${NONE}@invalid`;
const goneRef = { id: NONE, email: GONE_EMAIL, name: GONE_EMAIL };
/** Every UserRef in `v` that `pick` matches becomes the released person. */
const swap = (
  v: unknown,
  keys: string[],
  pick: (u: { email?: string }) => boolean,
): unknown => {
  if (Array.isArray(v)) return v.map((x) => swap(x, keys, pick));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      // A version's agent takes the row's name; here the person should show.
      k === "agent"
        ? null
        : keys.includes(k) && x && pick(x as { email?: string })
          ? goneRef
          : swap(x, keys, pick),
    ]),
  );
};
/** The hosted mock's GETs under `url`, with those UserRefs swapped. */
const releasedRefs = (
  url: RegExp,
  keys: string[],
  pick = (_: { email?: string }) => true,
) => {
  const hosted = createHandlers({ hosted: true });
  return http.get(url, async ({ request }) => {
    const res = await getResponse(hosted, request);
    if (!res?.ok) return res;
    return HttpResponse.json(swap(await res.json(), keys, pick) as never);
  });
};
const ARTIFACTS = /\/api\/v1\/artifacts/;
const LANDING = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const noAddress = () => expect(document.body).not.toHaveTextContent("@invalid");
const noAddressAnywhere = () =>
  expect(document.body.innerHTML).not.toContain("@invalid");

it("a library card's owner avatar never names the address", async () => {
  mountHosted("/", true, undefined, [releasedRefs(ARTIFACTS, ["owner"])]);
  const avatars = await screen.findAllByRole("img", { name: "Former member" });
  expect(avatars[0]).toHaveTextContent("FM");
  noAddressAnywhere();
});

it("Details names the owner, and the personal space, without the address", async () => {
  mountHosted(
    `${viewerPath(LANDING)}?panel=open&tab=details`,
    true,
    undefined,
    [releasedRefs(ARTIFACTS, ["owner", "createdBy"])],
  );
  await screen.findByText("Former member");
  noAddress();
});

it("Details starts someone else's personal space with A former member", async () => {
  const hosted = createHandlers({ hosted: true });
  mountHosted(
    `${viewerPath(LANDING)}?panel=open&tab=details`,
    true,
    undefined,
    [
      http.get(ARTIFACTS, async ({ request }) => {
        const res = await getResponse(hosted, request);
        if (!res?.ok) return res;
        const body = swap(await res.json(), ["owner", "createdBy"], () => true);
        return HttpResponse.json(
          (body && typeof body === "object" && "space" in body
            ? {
                ...body,
                space: {
                  id: NONE,
                  kind: "personal",
                  name: "Personal",
                  publicLinks: true,
                },
              }
            : body) as never,
        );
      }),
    ],
  );
  expect(
    await screen.findByText("A former member's personal space"),
  ).toBeVisible();
});

it("a named owner's personal space keeps their name", () => {
  expect(
    personNameAtStart({ email: `removed+${PAT}@invalid`, name: "Pat Deleted" }),
  ).toBe("Pat Deleted");
  expect(personNameAtStart({ email: "bo@example.com", name: null })).toBe(
    "bo@example.com",
  );
});

it("Share's owner row names the person without the address", async () => {
  mountHosted(`${viewerPath(LANDING)}?panel=open&tab=share`, true, undefined, [
    releasedRefs(ARTIFACTS, ["owner", "createdBy"]),
  ]);
  await screen.findByText("Former member");
  noAddressAnywhere();
});

it("Versions names the creator without the address", async () => {
  mountHosted(
    `${viewerPath(LANDING)}?panel=open&tab=versions`,
    true,
    undefined,
    [releasedRefs(ARTIFACTS, ["owner", "createdBy"])],
  );
  const list = await screen.findByRole("list", { name: "Versions" });
  await waitFor(() => expect(list).toHaveTextContent("Former member"));
  noAddress();
});

it("space People names a released member, with no address line", async () => {
  mountHosted("/settings/spaces?space=SpEngNpQrSt2uVwX", true, undefined, [
    releasedRefs(
      /\/api\/v1\/spaces\/[^/]+\/members/,
      ["user"],
      (u) => u.email === "bob@example.com",
    ),
  ]);
  const people = await screen.findByRole("region", { name: "People" });
  await within(people).findByText("Former member");
  noAddressAnywhere();
});

it("a sentence's start capitalises: A former member", () => {
  expect(personFirstAtStart({ email: GONE_EMAIL, name: null })).toBe(
    "A former member",
  );
  expect(personFirstAtStart({ email: "bo@example.com", name: null })).toBe(
    "bo",
  );
  expect(personFirstAtStart({ email: "b@x.io", name: "Bob B" })).toBe("Bob");
});
