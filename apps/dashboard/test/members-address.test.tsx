// The server's name falls back to the email (effectiveName): the address shows
// once, as the label, unless there is a real name above it.
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { installHarness, mountHosted } from "./harness";

installHarness();

const GUEST = "guest1@outside.example";
const count = (el: HTMLElement, text: string) =>
  (el.textContent ?? "").split(text).length - 1;

it("a member row: the address once when the name is the address; both for a real name", async () => {
  mountHosted("/settings/members", { selfHosted: true, guestShares: 1 });
  const guest = (await screen.findByText(GUEST)).closest("li") as HTMLElement;
  expect(count(guest, GUEST)).toBe(1);
  expect(guest).not.toHaveTextContent(" · ");
  const bob = screen.getByText("Bob Builder").closest("li") as HTMLElement;
  expect(bob).toHaveTextContent("bob@example.com");
});

it("a removed row: the address once when the name is the address", async () => {
  const gone = {
    id: "Gx0001AbCdEfGhIj",
    email: "gus@outside.example",
    name: "gus@outside.example",
    role: "guest",
    lastSeenAt: null,
    status: "removed",
    identities: [],
    restriction: null,
  };
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.members}`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("status")
          ? [gone]
          : fixtures.members,
      ),
    ),
    http.get(`*${R.memberTransfer(gone.id)}`, () =>
      HttpResponse.json({ live: 0, deleted: 0 }),
    ),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Removed (1)" }));
  const list = await screen.findByRole("list", { name: "Removed people" });
  const row = within(list).getByText(gone.email).closest("li") as HTMLElement;
  expect(count(row, gone.email)).toBe(1);
});
