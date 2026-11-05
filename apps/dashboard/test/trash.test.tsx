// Review item 9: the dashboard Trash (Design's option A) on the P4 draft
// shapes, and the delete toast that now points at it.
import { type ArtifactSummary, type Me, viewerPath } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrashItem } from "../src/api/contract";
import {
  arts,
  calls,
  findVisibleToast,
  installHarness,
  intersect,
  mount,
  mountHosted,
  page,
  server,
} from "./harness";

installHarness();

// Radix tooltips measure their content; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;

const ENG = "SpEngNpQrSt2uVwX";
const PERSONAL = "Ab3dEfGhJk4mNpQr";
const base = arts[0] as ArtifactSummary;

// Midday on Oct 27 (local), so calendar-day counts never straddle midnight.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12));
});
afterEach(() => {
  vi.useRealTimers();
});

const day = (offset: number) => new Date(2026, 9, 27 + offset, 9).toISOString();
const item = (
  id: string,
  title: string,
  ago: number,
  space: TrashItem["space"] = { id: PERSONAL, name: "Ada", personal: true },
): TrashItem => ({
  ...base,
  id,
  title,
  deletedAt: day(-ago),
  purgeAt: day(30 - ago),
  space,
});
const eng = { id: ENG, name: "Engineering", personal: false };
const ROWS = [
  item("TrA1aaaaaaaaaaaa", "Q3 planning board", 0),
  item(base.id, "Launch checklist", 3, eng),
  item("TrA3aaaaaaaaaaaa", "Week ahead", 22),
  item("TrA4aaaaaaaaaaaa", "Poll: offsite dates", 23),
  item("TrA5aaaaaaaaaaaa", "Retro notes", 29),
  item("TrA6aaaaaaaaaaaa", "Old pricing draft", 30),
];

/** GET trash serves `rows`; a restore takes the row out, as the server would. */
const trashApi = (rows: TrashItem[], restored?: object) => {
  let left = rows;
  return [
    http.get("*/api/v1/trash", () => page(left, null)),
    http.post("*/api/v1/artifacts/:id/undelete", ({ params }) => {
      const it = left.find((r) => r.id === params.id);
      if (!it)
        return HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
      left = left.filter((r) => r !== it);
      return HttpResponse.json({
        ...base,
        id: it.id,
        title: it.title,
        deletedAt: null,
        space: it.space?.personal
          ? { id: PERSONAL, kind: "personal", name: "Ada", publicLinks: true }
          : { id: ENG, kind: "shared", name: "Engineering", publicLinks: true },
        ...restored,
      });
    }),
  ];
};
const row = async (title: string) =>
  (await screen.findByText(title)).closest("li") as HTMLElement;

it("rows: chip, deleted date and the countdown, warning at 7 days or less", async () => {
  mountHosted("/trash", true, undefined, trashApi(ROWS));
  expect(await screen.findByRole("heading", { name: "Trash" })).toBeVisible();
  screen.getByText(
    "Your deleted artifacts, and those in spaces you manage. Each is deleted for good 30 days after it was deleted.",
  );
  const expected: [string, string, string, string, boolean][] = [
    [
      "Q3 planning board",
      "Personal",
      "Deleted today",
      "Deletes in 30 days",
      false,
    ],
    [
      "Launch checklist",
      "Engineering",
      "Deleted Oct 24",
      "Deletes in 27 days",
      false,
    ],
    ["Week ahead", "Personal", "Deleted Oct 5", "Deletes in 8 days", false],
    [
      "Poll: offsite dates",
      "Personal",
      "Deleted Oct 4",
      "Deletes in 7 days",
      true,
    ],
    ["Retro notes", "Personal", "Deleted Sep 28", "Deletes tomorrow", true],
    ["Old pricing draft", "Personal", "Deleted Sep 27", "Deletes today", true],
  ];
  for (const [title, chip, deleted, left, warn] of expected) {
    const r = within(await row(title));
    r.getByText(chip);
    r.getByText(deleted);
    const count = r.getByText(left);
    expect(count.className.includes("--oa-warning")).toBe(warn);
    // The title isn't a link: a deleted artifact doesn't open.
    expect(r.queryByRole("link")).toBeNull();
    expect(
      r.getByRole("button", { name: `Restore ${title}` }),
    ).toHaveTextContent("Restore");
  }
});

it("the countdown's tooltip gives the exact date and time", async () => {
  mountHosted("/trash", true, undefined, trashApi(ROWS.slice(1, 2)));
  const count = await screen.findByText("Deletes in 27 days");
  fireEvent.focus(count);
  expect(
    (await screen.findAllByText(/^Deleted for good Nov 23, 2026, 9:00/)).length,
  ).toBeGreaterThan(0);
});

it("Restore posts undelete, the row leaves, and the toast opens it", async () => {
  const posts = calls("POST");
  const router = mountHosted("/trash", true, undefined, trashApi(ROWS));
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore Launch checklist" }),
  );
  await findVisibleToast("Restored to Engineering.");
  expect(posts.map((c) => c.path)).toContain(
    `/api/v1/artifacts/${base.id}/undelete`,
  );
  await waitFor(() =>
    expect(screen.queryByText("Launch checklist")).toBeNull(),
  );
  screen.getByText("Q3 planning board");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/a/${base.id}`),
  );
});

it("a restore whose space is gone says Personal", async () => {
  mountHosted(
    "/trash",
    true,
    undefined,
    trashApi(ROWS.slice(1, 2), {
      space: { id: PERSONAL, kind: "personal", name: "Ada", publicLinks: true },
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore Launch checklist" }),
  );
  await findVisibleToast("Restored to Personal.");
});

it("a failed restore keeps the row and says to try again", async () => {
  // Ahead of trashApi's undelete: the first matching handler answers.
  mountHosted("/trash", true, undefined, [
    http.post("*/api/v1/artifacts/:id/undelete", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Boom" } },
        { status: 500 },
      ),
    ),
    ...trashApi(ROWS.slice(1, 2)),
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore Launch checklist" }),
  );
  await findVisibleToast(`Couldn't restore "Launch checklist". Try again.`);
  expect(
    screen.getByRole("button", { name: "Restore Launch checklist" }),
  ).toBeEnabled();
});

it("the empty state", async () => {
  mountHosted("/trash", true, undefined, trashApi([]));
  expect(await screen.findByText("Trash is empty")).toBeVisible();
  screen.getByText(
    "Artifacts deleted by you or any AI agent stay here for 30 days. Restore one to put it back where it was.",
  );
});

it("a failed listing is a load error with Retry, never an empty Trash", async () => {
  let fail = true;
  mountHosted("/trash", true, undefined, [
    http.get("*/api/v1/trash", () =>
      fail
        ? HttpResponse.json(
            { error: { code: "internal", message: "Boom" } },
            { status: 500 },
          )
        : page(ROWS.slice(0, 1), null),
    ),
  ]);
  expect(await screen.findByText("Couldn't load Trash.")).toBeVisible();
  expect(screen.queryByText("Trash is empty")).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Q3 planning board")).toBeVisible();
});

// A member who manages Engineering and only views Exec (#792: a shared
// space's trash is its managers', by space role only).
const asMemberManager = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
});

it("a member's space filter lists Personal and the spaces they manage, and sends spaceId", async () => {
  const gets = calls("GET");
  const router = mountHosted("/trash", true, asMemberManager, trashApi(ROWS));
  await screen.findByText("Q3 planning board");
  fireEvent.click(screen.getByRole("combobox", { name: "Space" }));
  // Engineering (manager) is listed; Exec (viewer) isn't.
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["All spaces", "Personal", "Engineering"]);
  fireEvent.click(screen.getByRole("option", { name: "Engineering" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ spaceId: ENG }),
  );
  await waitFor(() =>
    expect(
      gets.some(
        (c) => c.path === "/api/v1/trash" && c.search.get("spaceId") === ENG,
      ),
    ).toBe(true),
  );
});

it("an org admin's filter is by space role too: Exec, where they only view, isn't listed", async () => {
  mountHosted("/trash", true, undefined, trashApi(ROWS));
  await screen.findByText("Q3 planning board");
  fireEvent.click(screen.getByRole("combobox", { name: "Space" }));
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["All spaces", "Personal", "Engineering"]);
});

it("Load more: the next page is asked for with the cursor", async () => {
  const gets = calls("GET");
  mountHosted("/trash", true, undefined, [
    http.get("*/api/v1/trash", ({ request }) =>
      new URL(request.url).searchParams.get("cursor") === "c2"
        ? page(ROWS.slice(1, 2), null)
        : page(ROWS.slice(0, 1), "c2"),
    ),
  ]);
  await screen.findByText("Q3 planning board");
  intersect();
  expect(await screen.findByText("Launch checklist")).toBeVisible();
  expect(
    gets.some(
      (c) => c.path === "/api/v1/trash" && c.search.get("cursor") === "c2",
    ),
  ).toBe(true);
});

it("hosted: the sidebar has Trash, current on /trash", async () => {
  const router = mountHosted("/", true, undefined, trashApi([]));
  const nav = await screen.findByRole("navigation", { name: "Trash" });
  fireEvent.click(within(nav).getByRole("link", { name: "Trash" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/trash"));
  await waitFor(() =>
    expect(within(nav).getByRole("link", { name: "Trash" })).toHaveAttribute(
      "aria-current",
      "page",
    ),
  );
});

// -- self-hosted (spaces off): the same Trash, without spaces

/** Spaces off: every row's space is Personal, and the restore has no space. */
const bare = (r: TrashItem): TrashItem => ({
  ...r,
  space: { id: PERSONAL, name: "Personal", personal: true },
});

it("self-hosted: the sidebar has Trash", async () => {
  server.use(...trashApi([]));
  const router = mount("/");
  const nav = await screen.findByRole("navigation", { name: "Trash" });
  fireEvent.click(within(nav).getByRole("link", { name: "Trash" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/trash"));
  expect(await screen.findByText("Trash is empty")).toBeVisible();
});

it("self-hosted: no space filter and no chips; Restore says Restored.", async () => {
  const gets = calls("GET");
  server.use(
    // No `space` on the restore response (undefined drops out of the JSON).
    ...trashApi([bare(ROWS[0] as TrashItem), bare(ROWS[1] as TrashItem)], {
      space: undefined,
    }),
  );
  mount("/trash?spaceId=SpEngNpQrSt2uVwX");
  const r = within(await row("Launch checklist"));
  screen.getByText(
    "Your deleted artifacts. Each is deleted for good 30 days after it was deleted.",
  );
  expect(screen.queryByRole("combobox", { name: "Space" })).toBeNull();
  expect(r.queryByText("Engineering")).toBeNull();
  expect(r.queryByText("Personal")).toBeNull();
  r.getByText("Deleted Oct 24");
  // No filter to send: a stray ?spaceId= is ignored.
  expect(
    gets
      .filter((c) => c.path === "/api/v1/trash")
      .map((c) => c.search.get("spaceId")),
  ).not.toContain(ENG);
  fireEvent.click(r.getByRole("button", { name: "Restore Launch checklist" }));
  await findVisibleToast("Restored.");
  expect(screen.queryByText(/^Restored to/)).toBeNull();
  screen.getByRole("button", { name: "Open" });
});

const deleteLanding = async (hosted: boolean) => {
  const landing = (
    arts.find((a) => a.title === "Landing page") as ArtifactSummary
  ).id;
  const path = `${viewerPath(landing)}?panel=open&tab=details`;
  const router = hosted ? mountHosted(path) : mount(path);
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete artifact" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  return router;
};

const NOTE = "Deleted. It stays in Trash for 30 days.";
/** The note itself (its text runs across the Trash link). */
const note = (_: string, el: Element | null) =>
  el?.textContent === NOTE && el.querySelector(":scope > a") !== null;

for (const hosted of [true, false])
  it(`the delete toast says it stays in Trash, linked (${hosted ? "hosted" : "self-hosted"})`, async () => {
    await deleteLanding(hosted);
    const t = await findVisibleToast(note);
    expect(within(t).getByRole("link", { name: "Trash" })).toHaveAttribute(
      "href",
      "/trash",
    );
    screen.getByRole("button", { name: "Undo" });
  });

// Against the shared mock (#792's R.trash and undelete), no handler of our own:
// what was deleted is in Trash, and Restore takes it out again.
it.each([
  ["hosted", true],
  ["self-hosted", false],
] as const)(
  "%s: a deleted artifact is in Trash, and Restore puts it back (shared mock)",
  async (_, hosted) => {
    const posts = calls("POST");
    const router = await deleteLanding(hosted);
    await router.navigate({ to: "/trash" } as never);
    const row = (await screen.findByText("Landing page")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "Restore Landing page" }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/undelete"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("Landing page")).toBeNull());
  },
);
