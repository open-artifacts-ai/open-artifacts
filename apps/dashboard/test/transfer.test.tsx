// Hosted P4 Task 13: transfer a departed person's personal artifacts (Design
// D7, answers of 2026-10-22). A "Departed" card above Members and a
// "Transfer…" row-menu item open the same dialog; counts only, never titles.
import { type Me, R } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { runAll } from "../src/settings/Transfer";
import {
  calls,
  findVisibleToast,
  installHarness,
  mount,
  mountHosted,
} from "./harness";

installHarness();

const CAROL = "Cr7tNpQrSt8uVwXy";
const ENG = "SpEngNpQrSt2uVwX";
const departed = () => screen.findByRole("region", { name: "Departed" });
const carolRow = async () =>
  (await within(await departed()).findByText("Carol Departed")).closest(
    "li",
  ) as HTMLElement;
const openFromCard = async () => {
  fireEvent.click(
    within(await carolRow()).getByRole("button", {
      name: "Transfer Carol Departed's artifacts",
    }),
  );
  return screen.findByRole("dialog");
};
const chooseOption = async (label: string, option: string) => {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("self-hosted: no Departed card and no status request", async () => {
  const seen = calls("GET");
  mount("/settings/members");
  await screen.findByText("Bob Builder");
  expect(screen.queryByRole("region", { name: "Departed" })).toBeNull();
  expect(seen.some((c) => c.search.get("status") !== null)).toBe(false);
});

it("the Departed card lists Carol with counts, never titles", async () => {
  const seen = calls("GET");
  mountHosted("/settings/members");
  const card = await departed();
  expect(card).toHaveTextContent(
    "1 person left with personal artifacts to transfer.",
  );
  const row = await carolRow();
  await waitFor(() =>
    expect(row).toHaveTextContent(
      "2 personal artifacts (plus 1 in trash) · their space artifacts stay put",
    ),
  );
  expect(row).toHaveTextContent("Suspended");
  // Counts only: never her artifacts or her personal space.
  expect(
    seen.some(
      (c) =>
        c.path === "/api/v1/artifacts" ||
        c.path === "/api/v1/search" ||
        c.search.get("spaceId") === CAROL,
    ),
  ).toBe(false);
});

it("departed people with nothing to transfer are hidden (and so is the card)", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json({ live: 0, deleted: 0 }),
    ),
  ]);
  await screen.findByText("Bob Builder");
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Departed" })).toBeNull(),
  );
});

it("the dialog: title with the count, the trash note, and the choices", async () => {
  mountHosted("/settings/members");
  const d = await openFromCard();
  expect(
    await within(d).findByRole("heading", {
      name: "Transfer Carol Departed's 2 personal artifacts",
    }),
  ).toBeVisible();
  expect(d).toHaveTextContent(
    "Plus 1 in trash: it moves too and keeps its trash timer.",
  );
  expect(within(d).getByRole("radio", { name: /To a person/ })).toBeChecked();
  expect(
    within(d).getByRole("radio", { name: /To a space/ }),
  ).not.toBeChecked();
  expect(within(d).getByRole("button", { name: "Transfer 2" })).toBeDisabled();
  expect(within(d).getByRole("button", { name: "Later" })).toBeVisible();
});

it("successors exclude Carol, guests and restricted Dan; an active admin counts", async () => {
  mountHosted("/settings/members");
  await openFromCard();
  fireEvent.click(
    await screen.findByRole("combobox", { name: "Give them to" }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Ada Lovelace", "Bob Builder", "Erin Admin"]);
});

it("to a person: the helper names both, and the transfer posts the user", async () => {
  const seen = calls("POST");
  mountHosted("/settings/members");
  const d = await openFromCard();
  await chooseOption("Give them to", "Bob Builder");
  expect(d).toHaveTextContent(
    "You won't see titles or contents. Bob Builder gets them in their Personal, with Carol Departed's shares kept.",
  );
  fireEvent.click(await within(d).findByRole("button", { name: "Transfer 2" }));
  await waitFor(() =>
    expect(seen.find((c) => c.path === R.memberTransfer(CAROL))?.body).toEqual({
      to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" },
    }),
  );
  await findVisibleToast("Moved 2 artifacts (and 1 in trash) to Bob Builder.");
});

it("to a space: the helper says who can open them, and it posts the space", async () => {
  const seen = calls("POST");
  mountHosted("/settings/members");
  const d = await openFromCard();
  fireEvent.click(within(d).getByRole("radio", { name: /To a space/ }));
  await chooseOption("Space", "Engineering");
  expect(d).toHaveTextContent(
    "Everyone with access to Engineering can open them, by their role.",
  );
  fireEvent.click(await within(d).findByRole("button", { name: "Transfer 2" }));
  await waitFor(() =>
    expect(seen.find((c) => c.path === R.memberTransfer(CAROL))?.body).toEqual({
      to: { kind: "space", spaceId: ENG },
    }),
  );
  await findVisibleToast("Moved 2 artifacts (and 1 in trash) to Engineering.");
});

it("the row menu's Transfer… opens the same dialog", async () => {
  mountHosted("/settings/members");
  const row = await carolRow();
  fireEvent.pointerDown(
    within(row).getByRole("button", { name: "More for Carol Departed" }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Transfer…" }));
  expect(
    await screen.findByRole("heading", {
      name: "Transfer Carol Departed's 2 personal artifacts",
    }),
  ).toBeVisible();
});

it("runAll loops until nextCursor is null and reports progress", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ moved: 100, remaining: 20, nextCursor: "c1" })
    .mockResolvedValueOnce({ moved: 20, remaining: 0, nextCursor: null });
  const progress = vi.fn();
  await expect(
    runAll(run, { kind: "space", spaceId: ENG }, progress),
  ).resolves.toBe(120);
  expect(run.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1"]);
  expect(progress.mock.calls).toEqual([
    [100, 20],
    [120, 0],
  ]);
});

it("a partial failure shows inline with Retry, which moves only the rest", async () => {
  let n = 0;
  const bodies: unknown[] = [];
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json(
        n === 0 ? { live: 150, deleted: 0 } : { live: 50, deleted: 0 },
      ),
    ),
    http.post(`*${R.memberTransfer(CAROL)}`, async ({ request }) => {
      bodies.push(await request.json());
      n++;
      if (n === 1)
        return HttpResponse.json({
          moved: 100,
          remaining: 50,
          nextCursor: "c1",
        });
      if (n === 2)
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      return HttpResponse.json({ moved: 50, remaining: 0, nextCursor: null });
    }),
  ]);
  const d = await openFromCard();
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(
    await within(d).findByRole("button", { name: "Transfer 150" }),
  );
  const alert = await within(d).findByRole("alert");
  expect(alert).toHaveTextContent("Moved 100 of 150. 50 didn't move.");
  expect(screen.queryByText("boom")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await findVisibleToast("Moved 150 artifacts to Bob Builder.");
  // Retry starts over from what's left: no stale cursor.
  expect(bodies.at(-1)).toEqual({
    to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" },
  });
});

it("progress reads Transferring… <done> of <n>", async () => {
  // The gate exists before the request does: releasing early can't be lost.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  mountHosted("/settings/members", true, undefined, [
    http.post(`*${R.memberTransfer(CAROL)}`, async () => {
      await gate;
      return HttpResponse.json({ moved: 3, remaining: 0, nextCursor: null });
    }),
  ]);
  const d = await openFromCard();
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(await within(d).findByRole("button", { name: "Transfer 2" }));
  expect(
    await within(d).findByText("Transferring… 0 of 3, including trash."),
  ).toBeVisible();
  release();
});

it("400 invalid_successor shows the copy", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.post(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json(
        { error: { code: "invalid_successor", message: "server text" } },
        { status: 400 },
      ),
    ),
  ]);
  const d = await openFromCard();
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(await within(d).findByRole("button", { name: "Transfer 2" }));
  expect(
    await within(d).findByText(
      "Pick an active member who isn't a guest or restricted.",
    ),
  ).toBeVisible();
});

it("the Settings and Members dots show while someone still has artifacts", async () => {
  mountHosted("/settings/members");
  await departed();
  const nav = screen.getByRole("navigation", { name: "Primary" });
  await waitFor(() =>
    expect(
      within(nav).getByRole("link", { name: /^Settings/ }),
    ).toHaveAccessibleName("Settings, needs attention"),
  );
  expect(
    within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).getByRole("link", { name: /^Members/ }),
  ).toHaveAccessibleName("Members, needs attention");
});

it("no dots when nobody departed has artifacts", async () => {
  // Nothing else lights Settings either: no held directory sweep (D13 B).
  const quiet = (m: Me): Me => ({
    ...m,
    instance: {
      ...m.instance,
      directory: m.instance.directory && {
        ...m.instance.directory,
        heldSweeps: 0,
      },
    },
  });
  mountHosted("/settings/members", true, quiet, [
    http.get(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json({ live: 0, deleted: 0 }),
    ),
  ]);
  await screen.findByText("Bob Builder");
  const nav = screen.getByRole("navigation", { name: "Primary" });
  await waitFor(() =>
    expect(
      within(nav).getByRole("link", { name: /^Settings/ }),
    ).toHaveAccessibleName("Settings"),
  );
});

it("no trash: plain progress and toast", async () => {
  // The gate exists before the request does: releasing early can't be lost.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${R.memberTransfer(CAROL)}`, () =>
      HttpResponse.json({ live: 2, deleted: 0 }),
    ),
    http.post(`*${R.memberTransfer(CAROL)}`, async () => {
      await gate;
      return HttpResponse.json({ moved: 2, remaining: 0, nextCursor: null });
    }),
  ]);
  const d = await openFromCard();
  await chooseOption("Give them to", "Bob Builder");
  fireEvent.click(await within(d).findByRole("button", { name: "Transfer 2" }));
  expect(await within(d).findByText("Transferring… 0 of 2")).toBeVisible();
  release();
  await findVisibleToast("Moved 2 artifacts to Bob Builder.");
});
