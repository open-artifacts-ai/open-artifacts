// #3029: a hidden Get started checklist (member or owner) comes back from Settings > Profile.
import type { Me } from "@oa/shared";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GET_STARTED_BACK_TOAST,
  GET_STARTED_ROW_BUTTON,
  GET_STARTED_ROW_LABEL,
} from "../src/settings/GetStartedRow";
import { installClock, settle } from "./clock";
import { calls, installHarness, mountHosted, page } from "./harness";

installHarness();
installClock();
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const as =
  (role: Me["user"]["role"]) =>
  (m: Me): Me =>
    ({ ...m, user: { ...m.user, role } }) as Me;

// A server that keeps its flags: PUT {dismissed:false} clears the hide.
const server = (state: { dismissed: boolean; completed?: boolean }) => [
  http.get("*/api/v1/onboarding", () =>
    HttpResponse.json({
      completed: false,
      firstArtifact: null,
      agentConnected: true,
      ...state,
    }),
  ),
  http.put("*/api/v1/onboarding", async ({ request }) => {
    Object.assign(state, await request.json());
    return HttpResponse.json({ completed: false, ...state });
  }),
  http.get("*/api/v1/artifacts", () => page([], null)),
];
const card = () => document.querySelector("section[data-member]");

describe.each(["member", "owner"] as const)("a %s", (role) => {
  it("sees the row only while hidden; Show it again brings the card back", async () => {
    const puts = calls("PUT");
    let key = "";
    mountHosted(
      "/settings/profile",
      true,
      (m) => {
        const me = as(role)(m);
        key = `oa.onboarding.no-card.${me.user.id}`;
        localStorage.setItem(key, "1");
        return me;
      },
      server({ dismissed: true }),
    );
    await screen.findByText(GET_STARTED_ROW_LABEL);
    screen.getByRole("button", { name: GET_STARTED_ROW_BUTTON }).click();
    await waitFor(() =>
      expect(
        puts.filter((c) => c.path === "/api/v1/onboarding").map((c) => c.body),
      ).toEqual([{ dismissed: false }]),
    );
    await screen.findByText(GET_STARTED_BACK_TOAST);
    await waitFor(() =>
      expect(screen.queryByText(GET_STARTED_ROW_LABEL)).toBeNull(),
    );
    expect(localStorage.getItem(key)).toBeNull();
    cleanup();
  });

  it("has no row while the checklist is showing or finished", async () => {
    mountHosted(
      "/settings/profile",
      true,
      as(role),
      server({ dismissed: false }),
    );
    await screen.findByLabelText("Display name");
    await settle(200);
    expect(screen.queryByText(GET_STARTED_ROW_LABEL)).toBeNull();
    cleanup();
    mountHosted(
      "/settings/profile",
      true,
      as(role),
      server({ dismissed: true, completed: true }),
    );
    await screen.findByLabelText("Display name");
    await settle(200);
    expect(screen.queryByText(GET_STARTED_ROW_LABEL)).toBeNull();
  });
});

it("the Library card is back after Show it again", async () => {
  mountHosted(
    "/settings/profile",
    true,
    as("member"),
    server({ dismissed: true }),
  );
  (await screen.findByRole("button", { name: GET_STARTED_ROW_BUTTON })).click();
  await screen.findByText(GET_STARTED_BACK_TOAST);
  (await screen.findByRole("link", { name: "Library" })).click();
  await waitFor(() => expect(card()).not.toBeNull());
});
