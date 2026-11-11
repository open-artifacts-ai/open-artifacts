import type { ArtifactSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { arts, calls, installHarness, mount, page, server } from "./harness";

installHarness();

describe("Library: asks for you", () => {
  it("badges artifacts with asks and filters by Needs your answer", async () => {
    const [first, ...rest] = arts as [ArtifactSummary, ...ArtifactSummary[]];
    server.use(
      http.get(`*${R.artifacts}`, ({ request }) => {
        const f = new URL(request.url).searchParams.get("filter");
        return f === "needs_answer"
          ? page([{ ...first, asksForYou: 2 }], null)
          : page([{ ...first, asksForYou: 2 }, ...rest], null);
      }),
    );
    const reqs = calls("GET");
    const router = mount("/");
    expect(await screen.findByText("2 asks for you")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Needs your answer" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        filter: "needs_answer",
      }),
    );
    await waitFor(() =>
      expect(reqs.some((u) => u.search.get("filter") === "needs_answer")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  });

  it("has no Waiting on agents filter and ignores a stale one in the URL", async () => {
    const reqs = calls("GET");
    mount("/?filter=waiting_on_agents");
    await screen.findByRole("button", { name: "Needs your answer" });
    expect(
      screen.queryByRole("button", { name: "Waiting on agents" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      reqs.some((u) => u.search.get("filter") === "waiting_on_agents"),
    ).toBe(false);
  });

  it("marks the active chip and says which asks are missing when empty", async () => {
    server.use(http.get(`*${R.artifacts}`, () => page([], null)));
    mount("/");
    const chip = await screen.findByRole("button", {
      name: "Needs your answer",
    });
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(chip);
    await waitFor(() => expect(chip).toHaveAttribute("aria-pressed", "true"));
    expect(
      await screen.findByText("No asks need your answer."),
    ).toBeInTheDocument();
  });
});
