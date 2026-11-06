import type { ArtifactSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
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
      await screen.findByRole("radio", { name: "Needs your answer" }),
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

  it("filters by Waiting on agents", async () => {
    const reqs = calls("GET");
    mount("/");
    fireEvent.click(
      await screen.findByRole("radio", { name: "Waiting on agents" }),
    );
    await waitFor(() =>
      expect(
        reqs.some((u) => u.search.get("filter") === "waiting_on_agents"),
      ).toBe(true),
    );
  });
});
