import type { Me } from "@oa/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mount, mountHosted, page, server } from "./harness";

installHarness();

const INSTRUCTION = () =>
  `Add this Open Artifacts instance: follow ${location.origin}/llms.txt. Never paste a token in chat.`;
const none = http.get("*/api/v1/artifacts", () => page([], null));
const empty = () => server.use(none);
const clipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
};

describe("AgentSetupCard", () => {
  it("shows on Settings > Agents with the origin's llms.txt, and copies it", async () => {
    const writeText = clipboard();
    mount("/settings/agents");
    expect(
      await screen.findByRole("heading", { name: "Set up with an agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste this into any AI agent to connect it to this instance.",
      ),
    ).toBeInTheDocument();
    const field = screen.getByLabelText("Setup instruction");
    expect(field).toHaveValue(INSTRUCTION());
    expect(field).toHaveAttribute("readonly");
    expect(INSTRUCTION()).toContain(`${location.origin}/llms.txt`);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTRUCTION()));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
  });

  it("a denied clipboard toasts the failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    mount("/settings/agents");
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await screen.findByText(/couldn't copy/i);
  });

  it("shows in the empty Mine library, keeping the Settings link", async () => {
    empty();
    mount("/mine");
    await screen.findByText("Ask your agent to publish something");
    expect(await screen.findByLabelText("Setup instruction")).toHaveValue(
      INSTRUCTION(),
    );
    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute(
      "href",
      "/settings/agents",
    );
  });

  it("not in a filtered empty state", async () => {
    empty();
    mount("/mine?format=markdown");
    await screen.findByText("No artifacts match these filters");
    expect(screen.queryByLabelText("Setup instruction")).toBeNull();
  });

  it("shows for a guest, as the MCP card does", async () => {
    mountHosted(
      "/mine",
      true,
      (m) => ({ ...m, user: { ...m.user, role: "guest" } }),
      [none],
    );
    expect(await screen.findByLabelText("Setup instruction")).toHaveValue(
      INSTRUCTION(),
    );
  });

  it("shows for a capped caller on both screens, as the MCP card does", async () => {
    const capped = (m: Me): Me => ({
      ...m,
      auth: m.auth ? { ...m.auth, cap: "restricted" } : m.auth,
    });
    mountHosted("/mine", true, capped, [none]);
    expect(await screen.findByLabelText("Setup instruction")).toBeTruthy();
    cleanup();
    mountHosted("/settings/agents", true, capped);
    await screen.findByRole("heading", { name: "MCP server" });
    expect(screen.getByLabelText("Setup instruction")).toBeTruthy();
  });

  it("hides with the MCP card when the instance has no MCP URL", async () => {
    const none_ = (m: Me): Me => ({
      ...m,
      instance: { ...m.instance, mcpUrl: "" },
    });
    mountHosted("/settings/agents", true, none_);
    await screen.findByRole("heading", { name: "Connected agents" });
    expect(screen.queryByRole("heading", { name: "MCP server" })).toBeNull();
    expect(screen.queryByLabelText("Setup instruction")).toBeNull();
  });

  it("has no em dash", () => {
    expect(INSTRUCTION()).not.toContain("—");
    expect(INSTRUCTION()).not.toContain("–");
  });
});
