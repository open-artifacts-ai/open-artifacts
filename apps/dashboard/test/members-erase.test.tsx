// #1222: Erase a removed person, from their row's ••• menu on the Removed list.
import { type Member, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import { ownedCount } from "../src/settings/EraseDialog";
import { restoreRefusal } from "../src/settings/Members";
import {
  calls,
  findVisibleToast,
  installHarness,
  mountHosted,
} from "./harness";

installHarness();

const GUS: Member = {
  id: "Gx0001AbCdEfGhIj",
  email: "gus@example.com",
  name: "Gus Gone",
  role: "member",
  lastSeenAt: null,
  status: "removed",
};
const ADMIN_GONE: Member = {
  ...GUS,
  id: "Gx0002AbCdEfGhIj",
  email: "alma@example.com",
  name: "Alma Admin",
  role: "admin",
};
const RELEASED: Member = {
  ...GUS,
  id: "Gx0003AbCdEfGhIj",
  email: "removed+Gx0003AbCdEfGhIj@invalid",
  name: null,
};
let removed: Member[] = [];
const list = http.get(`*${R.members}`, ({ request }) =>
  HttpResponse.json(
    new URL(request.url).searchParams.get("status")
      ? removed
      : fixtures.members,
  ),
);
const eraseAnswer = (status: number, body?: Record<string, unknown>) =>
  http.post("*/api/v1/members/:id/erase", () => {
    if (status === 204) {
      removed = removed.filter((m) => m.id !== GUS.id);
      return new HttpResponse(null, { status: 204 });
    }
    return HttpResponse.json(body, { status });
  });
const openRemoved = async () => {
  fireEvent.click(
    await screen.findByRole("button", { name: /^Removed \(\d+\)$/ }),
  );
  return screen.findByRole("list", { name: "Removed people" });
};
const rowOf = async (name: string) =>
  (await within(await openRemoved()).findByText(name)).closest(
    "li",
  ) as HTMLElement;
const openErase = async (name = "Gus Gone", title = `Erase ${name}?`) => {
  const row = await rowOf(name);
  fireEvent.pointerDown(
    within(row).getByRole("button", { name: `More for ${name}` }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Erase…" }));
  return screen.findByRole("dialog", { name: title });
};
const BODY = [
  "This deletes what's left of Gus's account: their name and email, sign-ins, agent connections and tokens, the shares they received, and their space roles. It can't be undone, and they can't be restored afterwards.",
  "What stays: work they published, shown as from a former member; shares they created; and the audit log.",
  "They can still come back as a new, empty account if your sign-in rules let them in. A Google account they used stays blocked until an admin resets its link.",
];

describe("Erase on the Removed list", () => {
  it("the dialog: title, three paragraphs, the typed field, Erase disabled until it matches", async () => {
    removed = [GUS];
    mountHosted("/settings/members", true, undefined, [list]);
    const d = await openErase();
    for (const p of BODY) expect(within(d).getByText(p)).toBeVisible();
    const field = within(d).getByLabelText('Type "erase" to confirm');
    const go = within(d).getByRole("button", { name: "Erase" });
    expect(go).toHaveAttribute("data-variant", "destructive");
    expect(within(d).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(go).toBeDisabled();
    for (const [v, ok] of [
      ["eras", false],
      ["erased", false],
      ["  ERASE ", true],
      ["Erase", true],
    ] as const) {
      fireEvent.change(field, { target: { value: v } });
      if (ok) expect(go).toBeEnabled();
      else expect(go).toBeDisabled();
    }
  });

  it("Erase posts, and the toast keeps the name the list no longer has", async () => {
    removed = [GUS];
    const seen = calls("POST");
    mountHosted("/settings/members", true, undefined, [list, eraseAnswer(204)]);
    const d = await openErase();
    fireEvent.change(within(d).getByLabelText('Type "erase" to confirm'), {
      target: { value: "erase" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Erase" }));
    await findVisibleToast("Erased Gus's account.");
    expect(seen.some((c) => c.path === R.memberErase(GUS.id))).toBe(true);
    await waitFor(() => expect(screen.queryByText("Gus Gone")).toBeNull());
  });

  it("409 member_owns_artifacts: the count and Transfer…, no typed field", async () => {
    removed = [GUS];
    mountHosted("/settings/members", true, undefined, [
      list,
      eraseAnswer(409, {
        error: {
          code: "member_owns_artifacts",
          message: "x",
          details: { live: 2, deleted: 1 },
        },
      }),
    ]);
    const d = await openErase();
    fireEvent.change(within(d).getByLabelText('Type "erase" to confirm'), {
      target: { value: "erase" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Erase" }));
    expect(
      await within(d).findByText(
        "Gus still owns 2 artifacts (and 1 in trash). Transfer them first, then erase.",
      ),
    ).toBeVisible();
    expect(within(d).queryByRole("textbox")).toBeNull();
    expect(within(d).queryByRole("button", { name: "Erase" })).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Transfer…" }));
    expect(
      await screen.findByRole("dialog", { name: /^Transfer Gus Gone's/ }),
    ).toBeVisible();
  });

  it.each([
    [2, 1, "2 artifacts (and 1 in trash)"],
    [0, 1, "1 artifact in trash"],
    [1, 0, "1 artifact"],
    [3, 0, "3 artifacts"],
  ])("ownedCount(%i, %i)", (live, deleted, want) => {
    expect(ownedCount(live, deleted)).toBe(want);
  });

  it("an admin's row has no Erase for an admin; the owner gets it", async () => {
    removed = [ADMIN_GONE];
    mountHosted("/settings/members", { actAs: "admin" }, undefined, [list]);
    const row = await rowOf("Alma Admin");
    expect(
      within(row).queryByRole("button", { name: "More for Alma Admin" }),
    ).toBeNull();
  });

  it("the owner sees Erase on an admin's row", async () => {
    removed = [ADMIN_GONE];
    mountHosted("/settings/members", true, undefined, [list]);
    expect(await openErase("Alma Admin")).toBeVisible();
  });

  it("a deleted account's row: Erase, as a former member; still no Restore", async () => {
    removed = [RELEASED];
    mountHosted("/settings/members", true, undefined, [list]);
    const d = await openErase("Former member", "Erase a former member?");
    const row = within(
      screen.getByRole("list", { name: "Removed people", hidden: true }),
    )
      .getByText("Former member")
      .closest("li") as HTMLElement;
    expect(
      within(row).queryByRole("button", { name: /^Restore/, hidden: true }),
    ).toBeNull();
    expect(
      within(d).getByText(
        "This deletes what's left of a former member's account: their name and email, sign-ins, agent connections and tokens, the shares they received, and their space roles. It can't be undone, and they can't be restored afterwards.",
      ),
    ).toBeVisible();
    expect(within(d).getByText(BODY[1] as string)).toBeVisible();
    expect(within(d).getByText(BODY[2] as string)).toBeVisible();
  });

  it("a former member's 409 and member_erased lines start with a capital", async () => {
    removed = [RELEASED];
    mountHosted("/settings/members", true, undefined, [
      list,
      eraseAnswer(409, {
        error: {
          code: "member_owns_artifacts",
          message: "x",
          details: { live: 2, deleted: 1 },
        },
      }),
    ]);
    const d = await openErase("Former member", "Erase a former member?");
    fireEvent.change(within(d).getByLabelText('Type "erase" to confirm'), {
      target: { value: "erase" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Erase" }));
    expect(
      await within(d).findByText(
        "A former member still owns 2 artifacts (and 1 in trash). Transfer them first, then erase.",
      ),
    ).toBeVisible();
    const erased = new ApiClientError("member_erased", "x", 409);
    expect(restoreRefusal(erased, "a former member", "A former member")).toBe(
      "A former member's account was erased, so it can't be restored. If they need access again, invite them.",
    );
  });

  it("Departed rows have no Erase", async () => {
    removed = [];
    mountHosted("/settings/members");
    const card = await screen.findByRole("region", { name: "Departed" });
    const row = (await within(card).findByText("Carol Departed")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More for Carol Departed" }),
      { button: 0, pointerType: "mouse" },
    );
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Erase…" })).toBeNull();
  });

  it("Restore on an erased account (a stale tab) says so inline", async () => {
    removed = [GUS];
    mountHosted("/settings/members", true, undefined, [
      list,
      http.post("*/api/v1/members/:id/restore", () =>
        HttpResponse.json(
          { error: { code: "member_erased", message: "x" } },
          { status: 409 },
        ),
      ),
    ]);
    const row = await rowOf("Gus Gone");
    fireEvent.click(
      within(row).getByRole("button", { name: "Restore Gus Gone" }),
    );
    const d = await screen.findByRole("alertdialog", {
      name: "Restore Gus Gone?",
    });
    fireEvent.click(within(d).getByRole("button", { name: "Restore" }));
    expect(
      await within(row).findByText(
        "Gus's account was erased, so it can't be restored. If they need access again, invite them.",
      ),
    ).toBeVisible();
  });
});
