// Connections: Disconnect Google Workspace for a frozen directory (#2149).
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import {
  calls,
  findVisibleToast,
  installHarness,
  mountHosted,
} from "./harness";

installHarness();

const TEAM = {
  tier: "team" as const,
  status: "active" as const,
  trialEndsAt: null,
  graceUntil: null,
  creatorsThisMonth: 4,
  readOnly: false,
};
const FROZEN = { directory: "frozen" as const, billing: TEAM };
const BUTTON = { name: "Disconnect Google Workspace" };
const asMember = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
});

it("frozen Team owner: the row shows with the button", async () => {
  mountHosted("/settings/connections", FROZEN);
  expect(
    await screen.findByRole("heading", { name: "Google Workspace" }),
  ).toBeVisible();
  expect(screen.getByRole("button", BUTTON)).toBeVisible();
  // Product's copy: "Business" links to the Plan page.
  expect(screen.getByRole("link", { name: "Business" })).toHaveAttribute(
    "href",
    "/settings/plan",
  );
});

it("a member does not see it", async () => {
  mountHosted("/settings/connections", FROZEN, asMember);
  await screen.findByRole("heading", { name: "MCP server" });
  expect(screen.queryByRole("button", BUTTON)).toBeNull();
});

it("Business does not show it: the Directory tab owns it", async () => {
  mountHosted("/settings/connections", { directory: "frozen" });
  await screen.findByRole("heading", { name: "MCP server" });
  expect(screen.queryByRole("button", BUTTON)).toBeNull();
});

it("no binding (mode off): hidden", async () => {
  mountHosted("/settings/connections", { directory: "off", billing: TEAM });
  await screen.findByRole("heading", { name: "MCP server" });
  expect(screen.queryByRole("button", BUTTON)).toBeNull();
});

it("Disconnect confirms, calls DELETE /directory, and the row goes", async () => {
  const sent = calls("DELETE");
  mountHosted("/settings/connections", FROZEN);
  fireEvent.click(await screen.findByRole("button", BUTTON));
  const d = await screen.findByRole("alertdialog", {
    name: "Disconnect Google Workspace?",
  });
  expect(d).toHaveTextContent(
    "Group sync stays off and Open Artifacts loses access to your directory. People and roles already here stay as they are.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(sent.map((c) => c.path)).toContain("/api/v1/directory"),
  );
  await waitFor(() => expect(screen.queryByRole("button", BUTTON)).toBeNull());
  await findVisibleToast("Google Workspace disconnected.");
});

it("Cancel sends nothing", async () => {
  const sent = calls("DELETE");
  mountHosted("/settings/connections", FROZEN);
  fireEvent.click(await screen.findByRole("button", BUTTON));
  const d = await screen.findByRole("alertdialog");
  fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(sent).toHaveLength(0);
  expect(screen.getByRole("button", BUTTON)).toBeVisible();
});

it("a failed disconnect toasts and keeps the row", async () => {
  mountHosted("/settings/connections", FROZEN, undefined, [
    http.delete("*/api/v1/directory", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "boom" } },
        { status: 500 },
      ),
    ),
  ]);
  fireEvent.click(await screen.findByRole("button", BUTTON));
  const d = await screen.findByRole("alertdialog");
  fireEvent.click(within(d).getByRole("button", { name: "Disconnect" }));
  await findVisibleToast(/Couldn't disconnect/);
  expect(screen.getByRole("button", BUTTON)).toBeVisible();
});
