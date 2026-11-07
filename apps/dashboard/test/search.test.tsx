import { type ArtifactSummary, SNIPPET_MARK } from "@oa/shared";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import {
  arts,
  installHarness,
  intersect,
  mount,
  page,
  seen,
  server,
  wait,
} from "./harness";

installHarness();

const box = () => screen.findByRole("searchbox", { name: "Search artifacts" });
const searchReqs = () => seen.filter((u) => u.pathname.endsWith("/search"));

describe("Search", () => {
  it("renders hostile snippets as text and marks as <mark>", async () => {
    const a = arts[0] as ArtifactSummary;
    const { open, close } = SNIPPET_MARK;
    server.use(
      http.get("*/api/v1/search", () =>
        page(
          [
            {
              ...a,
              snippet: `<img src=x onerror=alert(1)> ${open}hit${close} [x]`,
            },
          ],
          null,
        ),
      ),
    );
    mount("/search?q=hit");
    const card = (await screen.findByRole("link", { name: a.title })).closest(
      "article",
    ) as HTMLElement;
    expect(card.querySelector("img[onerror]")).toBeNull();
    expect(
      within(card).getByText(/<img src=x onerror=alert\(1\)>/),
    ).toBeInTheDocument();
    expect(card.querySelector("mark")?.textContent).toBe("hit");
  });

  it("keeps ?q=007 as text", async () => {
    mount("/search?q=007");
    await waitFor(() => expect(searchReqs()).toHaveLength(1));
    expect(searchReqs()[0]?.searchParams.get("q")).toBe("007");
  });

  it("shows a no-results state", async () => {
    mount("/search?q=zzzzqqq");
    expect(await screen.findByText(/No results for/)).toBeInTheDocument();
  });

  it("whitespace-only ?q= shows the prompt and makes no request", async () => {
    mount("/search?q=%20%20");
    expect(
      await screen.findByText("Search your artifacts"),
    ).toBeInTheDocument();
    await wait(200);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(searchReqs()).toHaveLength(0);
  });

  it("loads further result pages through the sentinel", async () => {
    server.use(
      http.get("*/api/v1/search", ({ request }) => {
        const c = new URL(request.url).searchParams.get("cursor");
        const hit = (a: ArtifactSummary) => ({ ...a, snippet: a.title });
        return c
          ? page([hit(arts[1] as ArtifactSummary)], null)
          : page([hit(arts[0] as ArtifactSummary)], "c2");
      }),
    );
    mount("/search?q=x");
    await screen.findByRole("link", {
      name: (arts[0] as ArtifactSummary).title,
    });
    intersect();
    expect(
      await screen.findByRole("link", {
        name: (arts[1] as ArtifactSummary).title,
      }),
    ).toBeInTheDocument();
  });

  it("a pending debounced search does not hijack a later navigation", async () => {
    const router = mount("/");
    fireEvent.change(await box(), { target: { value: "notes" } });
    await act(() => router.navigate({ to: "/mine" } as never));
    await wait(400);
    expect(router.state.location.pathname).toBe("/mine");
  });

  it("refining a search replaces history instead of stacking entries", async () => {
    const router = mount("/");
    const input = await box();
    fireEvent.change(input, { target: { value: "no" } });
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    fireEvent.change(input, { target: { value: "notes" } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "notes" }),
    );
    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("clearing the box on /search returns to the full library (#1640)", async () => {
    const router = mount("/search?q=notes");
    fireEvent.change(await box(), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.searchStr).toBe("");
    // The library's own list is back, not the empty search prompt.
    expect(
      await screen.findByRole("link", { name: arts[0]?.title as string }),
    ).toBeInTheDocument();
  });
});
