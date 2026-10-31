import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { tokens } from "../src/mocks/fixtures";
import { mcpUrlFor } from "../src/pages/Tokens";
import { http, json, renderApp, use, writes } from "./harness";

const mint = async (label = "ci run") => {
  await screen.findByRole("form", { name: "Mint a token" });
  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: label },
  });
  fireEvent.click(screen.getByRole("button", { name: "Mint token" }));
};

it("mints a token, shows the secret once with a copy button, then it is gone", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  renderApp("/tokens");
  await mint();
  const box = await screen.findByTestId("secret");
  expect(box).toHaveTextContent("oat_MOCK_not_a_token");
  expect(box).toHaveTextContent("shown only once");
  const [w] = writes();
  expect(w.path).toBe("/api/v1/tokens");
  expect(w.csrf).toBe("mock-csrf");
  expect(w.body).toMatchObject({
    label: "ci run",
    scopes: ["installs:read"],
    ttlMinutes: 15,
  });

  fireEvent.click(within(box).getByRole("button", { name: "Copy token" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("oat_MOCK_not_a_token"),
  );
  expect(await within(box).findByText("Copied")).toBeInTheDocument();

  fireEvent.click(
    within(box).getByRole("button", { name: "I have copied it" }),
  );
  expect(screen.queryByTestId("secret")).toBeNull();
  expect(document.body.textContent).not.toContain("oat_MOCK_not_a_token");
  // The new token is in the list, without its secret.
  expect(await screen.findByText(/ci run/)).toBeInTheDocument();
});

it("validates the label and needs a scope", async () => {
  renderApp("/tokens");
  await screen.findByRole("form", { name: "Mint a token" });
  const go = screen.getByRole("button", { name: "Mint token" });
  expect(go).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "bad/label" },
  });
  expect(go).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "ok label" },
  });
  expect(go).toBeEnabled();
  fireEvent.click(screen.getByLabelText("installs:read"));
  expect(go).toBeDisabled();
});

it("lists both token kinds with their state and revokes one", async () => {
  use(http.get("*/api/v1/tokens", () => json({ items: tokens })));
  renderApp("/tokens");
  const items = await screen.findAllByRole("listitem");
  const byStatus = items.map((i) => i.getAttribute("data-status"));
  expect(byStatus).toEqual(["active", "active", "revoked", "expired"]);
  expect(items[1]).toHaveTextContent(/Claude Code.*oauth/);
  // Only active tokens can be revoked.
  expect(
    screen.getAllByRole("button", { name: /^Revoke (?!all)/ }),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Revoke ci" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    method: "DELETE",
    path: `/api/v1/tokens/${tokens[0].id}`,
    csrf: "mock-csrf",
  });
});

it("revoke all is type-to-confirm", async () => {
  renderApp("/tokens");
  fireEvent.click(await screen.findByRole("button", { name: "Revoke all" }));
  const dialog = await screen.findByRole("dialog");
  const go = within(dialog).getByRole("button", { name: "Revoke all" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "revoke all" },
  });
  expect(go).toBeEnabled();
  fireEvent.click(go);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    method: "DELETE",
    path: "/api/v1/tokens",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows the token_limit refusal in plain words", async () => {
  use(
    http.post("*/api/v1/tokens", () =>
      json({ error: { code: "token_limit", message: "x" } }, 409),
    ),
  );
  renderApp("/tokens");
  await mint();
  expect(await screen.findByRole("alert")).toHaveTextContent(/too many tokens/);
  expect(screen.queryByTestId("secret")).toBeNull();
});

it("has a Connect any AI agent card built from agentClients, named oa-admin", async () => {
  renderApp("/tokens");
  const card = await screen.findByRole("region", {
    name: "Connect any AI agent",
  });
  const url = "https://api.open-artifacts-staging.app/mcp";
  expect(card).toHaveTextContent(url);
  const snip = () => screen.getByTestId("snippet");
  // Default: Claude Code, browser sign-in.
  expect(snip()).toHaveTextContent(
    `claude mcp add --transport http oa-admin ${url}`,
  );
  expect(snip()).not.toHaveTextContent("open-artifacts ");
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "Generic" },
  });
  expect(snip()).toHaveTextContent(
    "list the oa-admin tools. You should see get_world.",
  );
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "Codex CLI" },
  });
  fireEvent.change(screen.getByLabelText(/Sign in with/), {
    target: { value: "token" },
  });
  expect(snip()).toHaveTextContent("[mcp_servers.oa-admin]");
  expect(snip()).toHaveTextContent("bearer_token_env_var");
  expect(snip()).toHaveTextContent("Restart Codex");
  expect(card).not.toHaveTextContent(String.fromCharCode(0x2014));
});

it("derives the MCP address from the admin host", () => {
  expect(mcpUrlFor("prod", "admin.open-artifacts.app")).toBe(
    "https://api.open-artifacts.app/mcp",
  );
  expect(mcpUrlFor("staging", "localhost")).toBe(
    "https://api.open-artifacts-staging.app/mcp",
  );
});
