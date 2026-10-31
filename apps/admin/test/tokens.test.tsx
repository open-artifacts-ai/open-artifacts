import type { Token } from "@oa/shared/provisioning";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, it, vi } from "vitest";
import { fmtAgo } from "../src/components/labels";
import { tokens } from "../src/mocks/fixtures";
import {
  endsLabel,
  kindLabel,
  mcpUrlFor,
  TOKEN_LIVE_LIMIT,
} from "../src/pages/Tokens";
import { http, json, renderApp, seen, use, writes } from "./harness";

const serve = (items: Token[]) =>
  use(http.get("*/api/v1/tokens", () => json({ items })));
const live = (n: number): Token[] =>
  Array.from({ length: n }, (_, i) => ({
    ...tokens[0],
    id: `01JD7Z9W5Q8X3N4M2K1H0G9F${String(10 + i)}`,
    label: `bot-${i}`,
  }));

const openMint = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Mint token" }));
  return screen.findByRole("dialog");
};
const mintIn = async (dialog: HTMLElement, label = "ci run") => {
  fireEvent.change(within(dialog).getByLabelText("Label"), {
    target: { value: label },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Mint token" }));
};

it("lists only live tokens and agents, with Kind, Scopes, Ends and Last used", async () => {
  serve(tokens);
  renderApp("/tokens");
  await screen.findByRole("table");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(2);
  const ci = within(rows[0]);
  expect(ci.getByText("ci")).toBeInTheDocument();
  expect(ci.getByText("Token (oat_)")).toBeInTheDocument();
  expect(ci.getByText("installs:read")).toBeInTheDocument();
  expect(ci.getByText(/^in (59|60) min$/)).toBeInTheDocument();
  expect(ci.getByText("Never")).toBeInTheDocument();
  const claude = within(rows[1]);
  expect(claude.getByText("Claude Code")).toBeInTheDocument();
  expect(claude.getByText("Signed in (OAuth)")).toBeInTheDocument();
  expect(claude.getByText("installs:read installs:write")).toBeInTheDocument();
  expect(
    claude.getByText(/^With your session · (1 h|59 min|60 min)$/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("2 of 5 live. Every token ends with your admin session."),
  ).toBeInTheDocument();
});

it("formats Kind, Ends and Last used", () => {
  const now = 1_790_000_000_000;
  const t = (o: Partial<Token>): Token => ({ ...tokens[0], ...o });
  expect(kindLabel(t({ kind: "oauth" }))).toBe("Signed in (OAuth)");
  expect(kindLabel(t({ kind: "oat" }))).toBe("Token (oat_)");
  expect(
    endsLabel(t({ kind: "oauth", expiresAt: now + 6 * 3_600_000 }), now),
  ).toBe("With your session · 6 h");
  expect(endsLabel(t({ kind: "oat", expiresAt: now + 38 * 60_000 }), now)).toBe(
    "in 38 min",
  );
  expect(fmtAgo(null, now)).toBe("Never");
  expect(fmtAgo(now - 20_000, now)).toBe("just now");
  expect(fmtAgo(now - 2 * 60_000, now)).toBe("2 min ago");
  expect(fmtAgo(now - 3 * 3_600_000, now)).toMatch(/^\d\d:\d\d$/);
});

it("says there are no agents yet when there are none", async () => {
  renderApp("/tokens");
  expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Connect any AI agent above, or mint a token for a script.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText("0 of 5 live. Every token ends with your admin session."),
  ).toBeInTheDocument();
});

it("at the limit, Mint is off and the page says why", async () => {
  expect(TOKEN_LIVE_LIMIT).toBe(5);
  serve(live(5));
  renderApp("/tokens");
  expect(await screen.findByTestId("token-limit")).toHaveTextContent(
    "You have 5 live tokens and agents. Revoke one to add another.",
  );
  expect(screen.getByRole("button", { name: "Mint token" })).toBeDisabled();
  expect(screen.getByText(/^5 of 5 live\./)).toBeInTheDocument();
});

it("below the limit there is no limit notice", async () => {
  serve(live(4));
  renderApp("/tokens");
  await screen.findByRole("table");
  expect(screen.queryByTestId("token-limit")).toBeNull();
  expect(screen.getByRole("button", { name: "Mint token" })).toBeEnabled();
});

it("mints a token and shows the secret once in a dialog, with Copy; Done removes it", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  renderApp("/tokens");
  await mintIn(await openMint());
  const box = await screen.findByTestId("secret");
  expect(box).toHaveTextContent("Token minted");
  expect(box).toHaveTextContent("Copy it now. It won't be shown again.");
  expect(box).toHaveTextContent("oat_MOCK_not_a_token");
  expect(box).toHaveTextContent("Labelci run");
  expect(box).toHaveTextContent("Scopesinstalls:read");
  expect(box).toHaveTextContent("Endsin 15 min, or when you sign out");
  const [w] = writes();
  expect(w.path).toBe("/api/v1/tokens");
  expect(w.csrf).toBe("mock-csrf");
  expect(w.body).toMatchObject({
    label: "ci run",
    scopes: ["installs:read"],
    ttlMinutes: 15,
  });

  fireEvent.click(within(box).getByRole("button", { name: "Copy" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("oat_MOCK_not_a_token"),
  );
  expect(await within(box).findByText("Copied")).toBeInTheDocument();

  fireEvent.click(within(box).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByTestId("secret")).toBeNull());
  expect(document.body.textContent).not.toContain("oat_MOCK_not_a_token");
  // The list was refetched (the contract mock dates its tokens in the past, so
  // the new row itself is checked in the list tests).
  await waitFor(() =>
    expect(
      seen.filter((r) => r.path === "/api/v1/tokens" && r.method === "GET")
        .length,
    ).toBeGreaterThan(1),
  );
});

it("validates the label and needs a scope in the mint dialog", async () => {
  renderApp("/tokens");
  const dialog = await openMint();
  const go = within(dialog).getByRole("button", { name: "Mint token" });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Label"), {
    target: { value: "bad/label" },
  });
  expect(go).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Label"), {
    target: { value: "ok label" },
  });
  expect(go).toBeEnabled();
  fireEvent.click(within(dialog).getByLabelText("installs:read"));
  expect(go).toBeDisabled();
});

it("revokes a live token", async () => {
  serve(tokens);
  renderApp("/tokens");
  await screen.findByRole("table");
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

it("shows the token_limit refusal in plain words and no secret", async () => {
  use(
    http.post("*/api/v1/tokens", () =>
      json({ error: { code: "token_limit", message: "x" } }, 409),
    ),
  );
  renderApp("/tokens");
  const dialog = await openMint();
  await mintIn(dialog);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    /too many tokens/,
  );
  expect(screen.queryByTestId("secret")).toBeNull();
});

it("the Connect any AI agent card: variant toggle and agent tabs drive the snippet", async () => {
  renderApp("/tokens");
  const card = await screen.findByRole("region", {
    name: "Connect any AI agent",
  });
  const url = "https://api.open-artifacts-staging.app/mcp";
  expect(card).toHaveTextContent(
    `It signs in through you and gets only the access you approve. Server ${url}`,
  );
  expect(card).toHaveTextContent(
    "Claude.ai: Settings, Connectors, Add custom connector, same server address.",
  );
  const snip = () => screen.getByTestId("snippet");
  const tab = (name: string) => within(card).getByRole("tab", { name });
  const pressed = (name: string) =>
    within(card).getByRole("button", { name }).getAttribute("aria-pressed");

  // Default: Claude Code, browser sign-in.
  expect(tab("Claude Code")).toHaveAttribute("aria-selected", "true");
  expect(pressed("Sign in with browser")).toBe("true");
  expect(snip()).toHaveTextContent(
    `claude mcp add --transport http oa-admin ${url}`,
  );
  expect(snip()).toHaveTextContent(
    "pick oa-admin and sign in with your browser",
  );
  expect(snip()).toHaveTextContent("Start a new Claude Code session");

  // Another agent tab.
  fireEvent.click(tab("Codex CLI"));
  expect(tab("Codex CLI")).toHaveAttribute("aria-selected", "true");
  expect(snip()).toHaveTextContent("[mcp_servers.oa-admin]");
  expect(snip()).toHaveTextContent("~/.codex/config.toml");
  expect(snip()).not.toHaveTextContent("bearer_token_env_var");

  // The token variant of the same agent.
  fireEvent.click(within(card).getByRole("button", { name: "Use a token" }));
  expect(pressed("Use a token")).toBe("true");
  expect(snip()).toHaveTextContent("bearer_token_env_var");
  expect(snip()).toHaveTextContent("Restart Codex");

  // Generic names the tool to look for.
  fireEvent.click(tab("Generic"));
  expect(snip()).toHaveTextContent(
    "list the oa-admin tools. You should see get_world.",
  );
  expect(card).not.toHaveTextContent(String.fromCharCode(0x2014));
});

it("Copy puts the snippet on the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  renderApp("/tokens");
  const snip = await screen.findByTestId("snippet");
  fireEvent.click(within(snip).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toContain("claude mcp add");
  expect(await within(snip).findByText("Copied")).toBeInTheDocument();
});

it("derives the MCP address from the admin host", () => {
  expect(mcpUrlFor("prod", "admin.open-artifacts.app")).toBe(
    "https://api.open-artifacts.app/mcp",
  );
  expect(mcpUrlFor("staging", "localhost")).toBe(
    "https://api.open-artifacts-staging.app/mcp",
  );
});

it("a network failure on mint keeps the request id for the same form and drops it once the form changes", async () => {
  use(http.post("*/api/v1/tokens", () => HttpResponse.error()));
  renderApp("/tokens");
  const dialog = await openMint();
  await mintIn(dialog, "first");
  const ids = () =>
    writes().map((w) => (w.body as { requestId: string }).requestId);
  const go = () => within(dialog).getByRole("button", { name: "Mint token" });
  await waitFor(() => expect(writes()).toHaveLength(1));
  await waitFor(() => expect(go()).toBeEnabled());
  fireEvent.click(go());
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(ids()[1]).toBe(ids()[0]);
  fireEvent.change(within(dialog).getByLabelText("Label"), {
    target: { value: "second" },
  });
  await waitFor(() => expect(go()).toBeEnabled());
  fireEvent.click(go());
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(ids()[2]).not.toBe(ids()[1]);
});
