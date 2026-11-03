// ?mock=restricted: what Design shoots for a capped caller.
import { createHandlers } from "@oa/shared/mocks";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";
import { restrictedHandlers } from "../src/mockRestricted";
import { installHarness, lastClient, mount, server } from "./harness";

installHarness();

const go = (path: string, rows: boolean) => {
  const hosted = createHandlers({ hosted: {} });
  server.use(...restrictedHandlers(hosted, rows), ...hosted);
  return mount(path);
};
const tab = (name: string) =>
  within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).queryByRole("link", { name });

describe("?mock=restricted", () => {
  it("/me is a capped member", async () => {
    go("/settings/profile", false);
    await waitFor(() => expect(lastClient.getQueryData(qk.me)).toBeTruthy());
    expect(lastClient.getQueryData(qk.me)).toMatchObject({
      user: { role: "member" },
      auth: { readOnly: true, cap: "restricted" },
    });
  });

  it("empty Mine", async () => {
    go("/mine", false);
    expect(await screen.findByText("No artifacts yet")).toBeTruthy();
    expect(
      screen.getByText("Artifacts shared with you show up in Shared with me."),
    ).toBeTruthy();
  });

  it("restricted: both cards empty, so no tab, and Profile", async () => {
    const router = go("/settings/agents", false);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
    await waitFor(() => expect(tab("Agents")).toBeNull());
  });

  it("restricted-rows: both cards, revoke-only, and the tab", async () => {
    go("/settings/agents", true);
    expect(
      await screen.findByText(
        "You can't connect new agents. You can revoke these.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "You can't create new tokens. You can revoke these.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
    expect(tab("Agents")).not.toBeNull();
  });
});
