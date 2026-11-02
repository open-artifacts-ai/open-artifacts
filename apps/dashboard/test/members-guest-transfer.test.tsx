// A guest with personal artifacts: Transfer from their Members row, for good,
// after "Got it" has taken the notice away.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { installHarness, mountHosted } from "./harness";

installHarness();

const OWNER = "owner1@outside.example";
const GUEST = "guest1@outside.example";
const ITEM = "Transfer their artifacts";
const more = (who: string) =>
  screen.findByRole("button", { name: `More for ${who}` });
const openMore = async (who: string) => {
  const b = await more(who);
  fireEvent.keyDown(b, { key: "Enter" });
  return screen.findByRole("menu");
};

it("spaces off: the menu shows for a guest with artifacts and opens the dialog; gone once moved", async () => {
  mountHosted("/settings/members", {
    selfHosted: true,
    guestShares: 1,
    guestOwners: 1,
  });
  const menu = await openMore(OWNER);
  fireEvent.click(within(menu).getByRole("menuitem", { name: ITEM }));
  const d = await screen.findByRole("dialog", {
    name: `Transfer ${OWNER}'s 1 artifact`,
  });
  fireEvent.click(within(d).getByRole("combobox", { name: "Give them to" }));
  fireEvent.click(await screen.findByRole("option", { name: "Bob Builder" }));
  fireEvent.click(within(d).getByRole("button", { name: "Transfer 1" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: `More for ${OWNER}` }),
    ).toBeNull(),
  );
});

it("spaces off: a guest with no artifacts has no menu, only Remove", async () => {
  mountHosted("/settings/members", {
    selfHosted: true,
    guestShares: 1,
    guestOwners: 1,
  });
  await more(OWNER);
  expect(
    screen.queryByRole("button", { name: `More for ${GUEST}` }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: `Remove ${GUEST}` })).toBeTruthy();
});

it("spaces on: a guest with no artifacts has the menu, without the item", async () => {
  mountHosted("/settings/members", {
    selfHosted: true,
    guestShares: 1,
    guestOwners: 1,
    spaces: true,
  });
  const menu = await openMore(GUEST);
  expect(within(menu).queryByRole("menuitem", { name: ITEM })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: "Remove…" })).toBeTruthy();
});

it("the item stays after the notice is dismissed", async () => {
  mountHosted("/settings/members", { selfHosted: true, guestOwners: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull(),
  );
  const menu = await openMore(OWNER);
  expect(within(menu).getByRole("menuitem", { name: ITEM })).toBeTruthy();
});

it("no warning on Got it", async () => {
  mountHosted("/settings/members", { selfHosted: true, guestOwners: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull(),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
