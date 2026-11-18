import type { ArtifactSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { arts, installHarness, mount, page, server } from "./harness";

installHarness();

describe("waiting mark through the real query path (#1910, #2778)", () => {
  it("Library card shows the mark when the list response carries `waiting`", async () => {
    const [first, ...rest] = arts as [ArtifactSummary, ...ArtifactSummary[]];
    const since = new Date(Date.now() - 4 * 60_000).toISOString();
    server.use(
      http.get(`*${R.artifacts}`, () =>
        page(
          [{ ...first, waiting: { count: 1, oldestSince: since } }, ...rest],
          null,
        ),
      ),
    );
    mount("/");
    expect(await screen.findByText(/1 waiting 4 min/)).toBeInTheDocument();
    expect(screen.getAllByText(/waiting \d/)).toHaveLength(1);
  });
});
