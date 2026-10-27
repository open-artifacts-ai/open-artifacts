// Hosted P4 Task 6: spaces in the sidebar and the space marker (Design D1 to
// D3: Spaces A, G68RE4oKC9pH3cgr v7, plus Design's answers of 2026-10-22).
import type { Me, MySpace } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { sharedSpaceName } from "../src/spaces/label";
import { visibilityHint } from "../src/spaces/SpaceMarker";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

// Radix tooltips measure their content; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ENG = "SpEngNpQrSt2uVwX";
const EXEC = "SpExcNpQrSt3uVwX";
const PERSONAL = "Ab3dEfGhJk4mNpQr";
const nav = () => screen.findByRole("navigation", { name: "Spaces" });
const card = async (title: string) =>
  (await screen.findByText(title, { selector: "a" })).closest(
    "article",
  ) as HTMLElement;
const empty = http.get("*/api/v1/artifacts", () =>
  HttpResponse.json({ items: [], nextCursor: null }),
);
const many =
  (n: number) =>
  (m: Me): Me => ({
    ...m,
    spaces: Array.from(
      { length: n },
      (_, i): MySpace => ({
        id: `SpX${String(i).padStart(2, "0")}pQrSt2uVwXy`,
        kind: "shared",
        name: `Space ${String(i + 1).padStart(2, "0")}`,
        publicLinks: true,
        myRole: "viewer",
      }),
    ),
  });

// -- the sidebar

it("the Spaces section lists Personal, then my shared spaces by name", async () => {
  mountHosted("/");
  const sw = await nav();
  await waitFor(() =>
    expect(
      within(sw)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Personal", "Engineering", "Exec"]),
  );
  expect(within(sw).queryByText("Clients")).toBeNull();
  expect(within(sw).queryByText("Bob Builder")).toBeNull();
  expect(within(sw).queryByText("All spaces")).toBeNull();
});

it("choosing Engineering opens the Library filtered to it, and marks the link current", async () => {
  const router = mountHosted("/");
  fireEvent.click(
    within(await nav()).getByRole("link", { name: "Engineering" }),
  );
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ space: ENG }),
  );
  expect(router.state.location.pathname).toBe("/");
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "Spaces" })).getByRole(
        "link",
        { name: "Engineering" },
      ),
    ).toHaveAttribute("aria-current", "page"),
  );
  // The same active look as Library's link.
  expect(
    within(screen.getByRole("navigation", { name: "Spaces" })).getByRole(
      "link",
      { name: "Engineering" },
    ),
  ).toHaveAttribute("data-active", "true");
  expect(
    within(screen.getByRole("navigation", { name: "Spaces" })).getByRole(
      "link",
      { name: "Exec" },
    ),
  ).toHaveAttribute("data-active", "false");
  // Library itself is no longer current while a space is open.
  expect(
    within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
      "link",
      { name: "Library" },
    ),
  ).not.toHaveAttribute("aria-current");
});

it("over 8 spaces: the first 8, then Show all (N) expands in place", async () => {
  mountHosted("/", true, many(12));
  const sw = await nav();
  await waitFor(() => expect(within(sw).getAllByRole("link")).toHaveLength(9));
  const more = within(sw).getByRole("button", { name: "Show all (12)" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more);
  expect(within(sw).getAllByRole("link")).toHaveLength(13);
  expect(within(sw).queryByRole("button", { name: /Show all/ })).toBeNull();
});

it("no shared spaces: Personal, the empty note, and Set up spaces for admins", async () => {
  mountHosted("/", true, (m) => ({ ...m, spaces: [] }));
  const sw = await nav();
  await waitFor(() =>
    expect(
      within(sw)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Personal", "Set up spaces"]),
  );
  expect(
    within(sw).getByRole("link", { name: "Set up spaces" }),
  ).toHaveAttribute("href", "/settings/spaces");
  expect(sw).toHaveTextContent("No spaces yet");
});

it("no shared spaces, not an admin: the note without the button", async () => {
  mountHosted("/", true, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
    spaces: [],
  }));
  const sw = await nav();
  await waitFor(() => expect(sw).toHaveTextContent("No spaces yet"));
  expect(within(sw).queryByRole("link", { name: "Set up spaces" })).toBeNull();
});

it("self-hosted: no Spaces section", async () => {
  mount("/");
  await screen.findByRole("navigation", { name: "Primary" });
  expect(screen.queryByRole("navigation", { name: "Spaces" })).toBeNull();
});

// -- Library across spaces, and inside one

it("across spaces, each card shows its space: the name, or Personal for mine", async () => {
  mountHosted("/");
  expect(
    within(await card("Meeting notes")).getByText("Engineering"),
  ).toBeVisible();
  expect(
    within(await card("Landing page")).getByText("Personal"),
  ).toBeVisible();
});

it("inside a space: its name and your role; tabs and format filter stay; no chip; Upload where you can publish", async () => {
  mountHosted(`/?space=${ENG}`);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Engineering" }),
  ).toBeVisible();
  expect(screen.getByText("You're a manager")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Shared with me" })).toBeVisible();
  const c = await card("Meeting notes");
  expect(within(c).queryByText("Engineering")).toBeNull();
  // Task 7: a manager can publish here, so the Upload pair shows.
  expect(
    await screen.findByRole("button", { name: "Upload files" }),
  ).toBeVisible();
});

it("across spaces the heading is Library and Upload stays", async () => {
  mountHosted("/");
  expect(
    await screen.findByRole("heading", { level: 1, name: "Library" }),
  ).toBeVisible();
  expect(
    await screen.findByRole("button", { name: "Upload files" }),
  ).toBeVisible();
});

it("inside Personal: the heading is Personal", async () => {
  mountHosted(`/?space=${PERSONAL}`);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Personal" }),
  ).toBeVisible();
});

it("an empty space you can publish to says how, with Copy prompt", async () => {
  mountHosted(`/?space=${ENG}`, true, undefined, [empty]);
  expect(await screen.findByText("Nothing in Engineering yet")).toBeVisible();
  expect(
    screen.getByText(
      'Ask any AI agent to publish here, for example "publish this to Engineering".',
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy prompt" })).toBeVisible();
});

it("an empty space you can only view says so", async () => {
  mountHosted(`/?space=${EXEC}`, true, undefined, [empty]);
  expect(await screen.findByText("Nothing in Exec yet")).toBeVisible();
  expect(
    screen.getByText(
      "You can view this space. What its editors publish shows up here.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
});

it("an empty Personal space explains who can see it", async () => {
  mountHosted(`/?space=${PERSONAL}`, true, undefined, [empty]);
  expect(await screen.findByText("Your personal space")).toBeVisible();
  expect(
    screen.getByText(
      "Only you can see what's here until you share it or move it to a space.",
    ),
  ).toBeVisible();
});

// -- scoped search

it("inside a space the search reads Search Engineering with a chip; removing it searches everywhere", async () => {
  const router = mountHosted(`/?space=${ENG}`);
  const box = await screen.findByRole("searchbox", {
    name: "Search in Engineering",
  });
  await waitFor(() =>
    expect(box).toHaveAttribute("placeholder", "Search Engineering"),
  );
  expect(screen.getByText("in Engineering")).toBeVisible();
  fireEvent.change(box, { target: { value: "notes" } });
  await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
  expect(router.state.location.search).toEqual({ q: "notes", space: ENG });
  expect(screen.getByText("in Engineering")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Search everywhere" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ q: "notes" }),
  );
  expect(screen.queryByText("in Engineering")).toBeNull();
  expect(box).toHaveAttribute("placeholder", "Search titles and content");
  expect(box).toHaveAccessibleName("Search artifacts");
});

it("Backspace on an empty scoped search removes the chip", async () => {
  mountHosted(`/?space=${ENG}`);
  const box = await screen.findByRole("searchbox", {
    name: "Search in Engineering",
  });
  await screen.findByText("in Engineering");
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(screen.queryByText("in Engineering")).toBeNull();
  expect(box).toHaveAttribute("placeholder", "Search titles and content");
  expect(box).toHaveAccessibleName("Search artifacts");
});

it("across spaces there is no chip", async () => {
  mountHosted("/");
  const box = await screen.findByRole("searchbox", {
    name: "Search artifacts",
  });
  expect(box).toHaveAttribute("placeholder", "Search titles and content");
  expect(
    screen.queryByRole("button", { name: "Search everywhere" }),
  ).toBeNull();
});

// -- visibility hints (interim, Design 2026-10-22)

it("visibilityHint", () => {
  const eng = { id: ENG, kind: "shared" as const, name: "Engineering" };
  const mine = { id: PERSONAL, kind: "personal" as const, name: "Ada" };
  // Design D6 section 9: the space on Private, the org on Team.
  expect(visibilityHint("team", eng, "Acme")).toBe("Everyone at Acme");
  expect(visibilityHint("team", mine, "Acme")).toBe("Everyone at Acme");
  expect(visibilityHint("private", eng, "Acme")).toBe(
    "People with access to Engineering, and anyone you add",
  );
  expect(visibilityHint("private", mine, "Acme")).toBe(
    "Only you, and anyone you add",
  );
  expect(visibilityHint("public", eng, "Acme")).toBe(
    "Anyone with the link, no sign-in",
  );
  expect(visibilityHint("team", undefined, "Acme")).toBeNull();
});

it("hovering Team on a card shows Everyone at <install name>", async () => {
  mountHosted("/");
  const team = within(await card("Meeting notes")).getByText("Team");
  fireEvent.pointerMove(team);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Everyone at Acme Artifacts",
  );
});

it("inside a space, the tabs keep the space; there is no Team tab", async () => {
  const router = mountHosted(`/?space=${ENG}`);
  await screen.findByRole("heading", { level: 1, name: "Engineering" });
  expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
  const tab = screen.getByRole("tab", { name: "Shared with me" });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
  expect(router.state.location.search).toEqual({ space: ENG });
  expect(
    screen.getByRole("heading", { level: 1, name: "Engineering" }),
  ).toBeVisible();
});

// Review item 20: the server's scope=mine is the personal space, so Mine in a
// shared space is scope=space&spaceId=<id>&owner=me (P3).
it("a shared space's Mine tab lists the caller's artifacts there (scope=space, owner=me)", async () => {
  const list = calls("GET");
  mountHosted(`/?space=${ENG}`);
  await screen.findByRole("heading", { level: 1, name: "Engineering" });
  const tab = screen.getByRole("tab", { name: "Mine" });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await waitFor(() =>
    expect(
      list.some(
        (c) =>
          c.path === "/api/v1/artifacts" &&
          c.search.get("scope") === "space" &&
          c.search.get("spaceId") === ENG &&
          c.search.get("owner") === "me",
      ),
    ).toBe(true),
  );
  // Never scope=mine with a shared spaceId: P3 refuses it (400).
  expect(
    list.some(
      (c) =>
        c.path === "/api/v1/artifacts" &&
        c.search.get("scope") === "mine" &&
        c.search.get("spaceId") === ENG,
    ),
  ).toBe(false);
});

it("the personal space keeps its Mine tab", async () => {
  mountHosted(`/?space=${PERSONAL}`);
  expect(await screen.findByRole("tab", { name: "Mine" })).toBeVisible();
});

it("below 640px the chip drops 'in' and the placeholder is just Search", async () => {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...real(query),
    matches: query.includes("max-width: 639px"),
    media: query,
  })) as typeof window.matchMedia;
  try {
    mountHosted(`/?space=${ENG}`);
    const box = await screen.findByRole("searchbox", {
      name: "Search in Engineering",
    });
    await waitFor(() => expect(box).toHaveAttribute("placeholder", "Search"));
    expect(
      screen.getByText("Engineering", { selector: "[data-scope-chip] *" }),
    ).toBeVisible();
    expect(screen.queryByText("in Engineering")).toBeNull();
  } finally {
    window.matchMedia = real;
  }
});

// A shared space named "Personal" (made before #770 reserved the name) stays
// listed and reachable, labelled so it isn't the built-in Personal.
it("a shared space named Personal reads Personal (shared), next to the built-in Personal", async () => {
  const legacy: MySpace = {
    id: "SpOldPersonal0001",
    kind: "shared",
    name: " personal ",
    publicLinks: true,
    myRole: "manager",
  };
  mountHosted(
    "/",
    true,
    (m: Me): Me => ({
      ...m,
      spaces: [...(m.spaces ?? []), legacy],
    }),
  );
  const spaces = await nav();
  expect(within(spaces).getByRole("link", { name: "Personal" })).toBeVisible();
  const shared = within(spaces).getByRole("link", {
    name: "personal (shared)",
  });
  expect(shared).toHaveAttribute(
    "href",
    expect.stringContaining(`space=${legacy.id}`),
  );
});

it("sharedSpaceName labels only the reserved name", () => {
  expect(sharedSpaceName("Personal")).toBe("Personal (shared)");
  expect(sharedSpaceName(" PERSONAL ")).toBe("PERSONAL (shared)");
  expect(sharedSpaceName("Personal stuff")).toBe("Personal stuff");
  expect(sharedSpaceName("Engineering")).toBe("Engineering");
});
