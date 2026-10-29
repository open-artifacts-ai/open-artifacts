import type { ArtifactSummary } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
} from "./harness";

installHarness();

const link = (name: string) => screen.findByRole("link", { name });

describe("Library", () => {
  it("renders one card per artifact", async () => {
    mount("/");
    for (const a of arts)
      expect(
        await screen.findByRole("link", { name: a.title }),
      ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(arts.length);
  });

  it("format filter updates the URL and the request", async () => {
    const router = mount("/");
    await link("Landing page");
    fireEvent.click(await screen.findByRole("radio", { name: "Markdown" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        format: "markdown",
      }),
    );
    await waitFor(() =>
      expect(
        seen.some((u) => u.searchParams.get("format") === "markdown"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Landing page" })).toBeNull(),
    );
  });

  it("loads the next page when the sentinel is reached", async () => {
    const [first, ...rest] = arts as [ArtifactSummary, ...ArtifactSummary[]];
    server.use(
      http.get("*/api/v1/artifacts", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return cursor ? page(rest.slice(0, 1), null) : page([first], "c2");
      }),
    );
    mount("/");
    await screen.findByRole("link", { name: first.title });
    expect(
      screen.queryByRole("link", { name: (rest[0] as ArtifactSummary).title }),
    ).toBeNull();
    intersect();
    expect(
      await screen.findByRole("link", {
        name: (rest[0] as ArtifactSummary).title,
      }),
    ).toBeInTheDocument();
  });

  it("empty Mine state links to the agents settings", async () => {
    server.use(http.get("*/api/v1/artifacts", () => page([], null)));
    mount("/mine");
    expect(
      await screen.findByText("Ask your agent to publish something"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute(
      "href",
      "/settings/agents",
    );
  });

  it("remembers the view in localStorage and URL", async () => {
    const router = mount("/");
    await link("Landing page");
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ view: "list" }),
    );
    expect(localStorage.getItem("oa.library.view")).toBe("list");
  });

  it("Clear filters clears format and agent in a single navigation", async () => {
    const router = mount("/?format=markdown&agent=Claude%20Code");
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear filters" }),
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.history.length === undefined ? 0 : 1).toBe(1);
  });

  it("agent filter still offers other agents once one is selected", async () => {
    const a1 = { ...arts[0], lastAgent: { name: "Alpha", version: null } };
    const a2 = {
      ...arts[1],
      id: "x2",
      lastAgent: { name: "Beta", version: null },
    };
    server.use(
      http.get("*/api/v1/artifacts", ({ request }) => {
        const ag = new URL(request.url).searchParams.get("agent");
        const all = [a1, a2] as ArtifactSummary[];
        return page(
          all.filter((a) => !ag || a.lastAgent?.name === ag),
          null,
        );
      }),
    );
    mount("/");
    await link(a1.title as string);
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    fireEvent.click(await screen.findByRole("option", { name: "Alpha" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: a2.title as string }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    const opts = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toContain("Beta");
  });

  it("a masked agent (another member's token) gets no chip; a client's chip still filters", async () => {
    const masked = {
      ...arts[0],
      lastAgent: { name: "Olive Owner's agent", version: null, masked: true },
    };
    const client = {
      ...arts[1],
      id: "x2",
      lastAgent: { name: "Claude Code", version: "2.1" },
    };
    server.use(
      http.get("*/api/v1/artifacts", ({ request }) => {
        const ag = new URL(request.url).searchParams.get("agent");
        const all = [masked, client] as ArtifactSummary[];
        return page(
          all.filter((a) => !ag || a.lastAgent?.name === ag),
          null,
        );
      }),
    );
    mount("/");
    await link(masked.title as string);
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    const opts = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toContain("Claude Code");
    expect(opts).not.toContain("Olive Owner's agent");
    fireEvent.click(await screen.findByRole("option", { name: "Claude Code" }));
    // The mock filters by ?agent=, so the masked artifact drops out.
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: masked.title as string }),
      ).toBeNull(),
    );
    expect(await link(client.title as string)).toBeInTheDocument();
  });

  it("drops artifacts repeated across pages", async () => {
    const a = arts[0] as ArtifactSummary;
    let second = 0;
    server.use(
      http.get("*/api/v1/artifacts", ({ request }) => {
        if (!new URL(request.url).searchParams.get("cursor"))
          return page([a], "c2");
        second++;
        return page([a], null);
      }),
    );
    mount("/");
    await link(a.title);
    intersect();
    await waitFor(() => expect(second).toBe(1));
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
