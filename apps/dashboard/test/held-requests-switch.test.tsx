// #2577, #3024: Settings → Connections no longer has a phone-only switch for
// held requests (they are part of the account's Needs you); the history stays.
import { createHandlers } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

describe("Held requests", () => {
  it("has no phone-only switch, and history rows say 'on your list'", async () => {
    server.use(...createHandlers({ events, agentAsks: true }));
    mount("/settings/connections");
    await screen.findByRole(
      "heading",
      { name: "Who asked what" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(
      screen.queryByRole("switch", { name: "Send held requests to my phone" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Held requests" })).toBeNull();
    await waitFor(() =>
      expect(document.body.textContent).toContain("yesterday · on your list"),
    );
  });
});
