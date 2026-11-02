// A deleted Workspace account: its row's address is released
// (removed+<id>@invalid) and never shown (Design's ruling on #828).
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import {
  personFirst,
  personInSentence,
  personName,
} from "../src/layout/person";
import { initials, UserAvatar } from "../src/layout/UserAvatar";
import { findVisibleToast, installHarness, mountHosted } from "./harness";

// Until #829 relaxes the schema: without this the list doesn't parse at all.
vi.mock("@oa/shared", async (original) => {
  const shared = await original<typeof import("@oa/shared")>();
  const { z } = await import("zod");
  return {
    ...shared,
    MemberSchema: shared.MemberSchema.extend({ email: z.string() }),
  };
});

installHarness();

const released = (id: string, name: string | null) => ({
  id,
  email: `removed+${id}@invalid`,
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

it("the Departed row keeps Transfer, hides Restore, and shows the muted line", async () => {
  mountHosted("/settings/members", true, undefined, withGone(nameless(NONE)));
  const card = await departed();
  await within(card).findByRole("button", { name: "Transfer all to me" });
  expect(within(card).getByText(MANAGED)).toBeVisible();
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
