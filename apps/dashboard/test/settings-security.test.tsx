// #2864: there is no Settings › Security tab; the old route lands on Profile.

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installHarness, mount } from "./harness";

installHarness();

describe("Settings › Security is gone (#2864)", () => {
  it("has no Security tab", async () => {
    mount("/settings/profile");
    expect(
      await screen.findByRole("link", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
  });

  it("an old /settings/security link redirects to Profile, with no passkey UI", async () => {
    const router = mount("/settings/security");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
    expect(
      await screen.findByRole("link", { name: "Profile" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/passkey/i)).toBeNull();
  });
});
