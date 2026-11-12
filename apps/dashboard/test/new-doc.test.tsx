import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { AGENT_LINE } from "../src/library/NewDoc";
import { isFresh } from "../src/viewer/doc/fresh";
import { calls, events, installHarness, mount, server } from "./harness";

installHarness();

const useDocs = (docs?: "on" | "needs_paid") =>
  server.use(...createHandlers({ events, docs }), ...events.handlers);

describe("New doc (#1100)", () => {
  it("is absent while docs are off", async () => {
    mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(screen.queryByRole("button", { name: "New doc" })).toBeNull();
    expect(screen.queryByText(AGENT_LINE)).toBeNull();
  });

  it("is not offered to a guest", async () => {
    useDocs("on");
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role: "guest" },
          instance: { ...fixtures.me.instance, docs: "on" },
        }),
      ),
    );
    mount("/shared");
    await screen.findByRole("link", { name: "Shared draft" });
    expect(screen.queryByRole("button", { name: "New doc" })).toBeNull();
  });

  it("creates a blank doc and opens it", async () => {
    useDocs("on");
    const router = mount("/");
    const posts = calls("POST");
    expect(await screen.findByText(AGENT_LINE)).toBeVisible();
    expect(screen.getByRole("button", { name: "New doc" })).not.toHaveAttribute(
      "aria-disabled",
    );
    fireEvent.click(await screen.findByRole("button", { name: "New doc" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/a\/.+/),
    );
    // The creation toast, and the doc is marked new (its title opens selected).
    expect(
      await screen.findByText(
        "Type a title, then press Enter to start writing.",
      ),
    ).toBeVisible();
    expect(isFresh(router.state.location.pathname.slice("/a/".length))).toBe(
      true,
    );
    expect(posts[0]?.path).toBe("/api/v1/artifacts");
    expect(posts[0]?.body).toMatchObject({
      format: "doc",
      title: "Untitled",
      content: "",
    });
  });

  it("on a free self-host shows the note, and the button points to it", async () => {
    useDocs("needs_paid");
    const router = mount("/");
    const note = await screen.findByRole("region", {
      name: "Docs need Cloudflare's Workers Paid plan",
    });
    expect(screen.queryByText(AGENT_LINE)).toBeNull();
    expect(
      screen.getByRole("link", { name: "How to turn on Workers Paid" }),
    ).toHaveAttribute(
      "href",
      "https://open-artifacts.com/docs/self-hosting-costs",
    );
    expect(
      screen.getByRole("link", { name: "See hosted plans" }),
    ).toHaveAttribute("href", "https://open-artifacts.com");
    const posts = calls("POST");
    const button = screen.getByRole("button", { name: "New doc" });
    // Off, but still pressable: aria-disabled with the disabled look, not disabled.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button.className).toContain("aria-disabled:opacity-50");
    fireEvent.click(button);
    await waitFor(() => expect(note).toHaveFocus());
    expect(
      await screen.findByText(
        "New doc is off on this instance. The note says why.",
      ),
    ).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(router.state.location.pathname).toBe("/");
  });
});
