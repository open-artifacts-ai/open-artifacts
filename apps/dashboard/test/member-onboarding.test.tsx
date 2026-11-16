// #2632 (member onboarding, slice 1): the PROVISIONAL /me adapter, a
// member's Library card (five steps, Hide; hidden isn't done), and a guest's
// note where a member would publish.
import type { Me } from "@oa/shared";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { firstName, fiveOf, mySteps } from "../src/library/mySetup";
import { calls, installHarness, mountHosted, page } from "./harness";

installHarness();

const onboarding = (over: object = {}) =>
  http.get("*/api/v1/onboarding", () =>
    HttpResponse.json({
      dismissed: false,
      completed: false,
      firstArtifact: null,
      ...over,
    }),
  );
const put = () =>
  http.put("*/api/v1/onboarding", async ({ request }) =>
    HttpResponse.json({
      dismissed: false,
      completed: false,
      ...((await request.json()) as object),
    }),
  );
const as =
  (role: Me["user"]["role"], extra: object = {}) =>
  (m: Me): Me =>
    ({ ...m, user: { ...m.user, role }, ...extra }) as Me;
const T = "2026-11-16T10:00:00.000Z";
const setup = (over: object = {}) => ({
  setup: {
    connectedAt: T,
    namedAt: null,
    publishedAt: null,
    mentionRepliedAt: null,
    askAnsweredAt: null,
    teammateCommentedAt: null,
    hiddenAt: null,
    completedAt: null,
    ...over,
  },
});
const card = () => document.querySelector("section[data-member]");
const empty = () => http.get("*/api/v1/artifacts", () => page([], null));

describe("mySetup (PROVISIONAL /me fields)", () => {
  it("reads the per-person times when the server sends them", () => {
    const s = mySteps(setup({ namedAt: T, teammateCommentedAt: T }).setup, {
      agentConnected: false,
    } as never);
    expect(fiveOf(s)).toEqual([true, true, false, false, false]);
    expect(s.teammate).toBe(true);
  });

  it("falls back to R.onboarding without them; the sixth is never done", () => {
    const s = mySteps(undefined, {
      dismissed: true,
      completed: false,
      agentConnected: true,
      firstArtifact: { id: "a", title: "A" },
    } as never);
    expect(fiveOf(s)).toEqual([true, false, true, false, false]);
    expect(s.hidden).toBe(true);
    expect(s.teammate).toBe(false);
  });

  it("a five-of-five count ignores the sixth step", () => {
    const s = mySteps(setup({ teammateCommentedAt: T }).setup, undefined);
    expect(fiveOf(s).filter(Boolean)).toHaveLength(1);
  });

  it("first name is the first word", () => {
    expect(firstName("  Ada Lovelace ")).toBe("Ada");
    expect(firstName("")).toBeNull();
    expect(firstName(null)).toBeNull();
  });
});

describe("a member's Library card", () => {
  it("shows the same five steps with the design's words, and Hide", async () => {
    mountHosted("/", true, as("member", setup()), [onboarding(), empty()]);
    await waitFor(() => expect(card()).not.toBeNull());
    const c = card() as HTMLElement;
    expect(c.textContent).toContain("1 of 5");
    for (const t of [
      "Name your agent",
      "Your agent will suggest a name. It's what you'll type after @ in comments.",
      "Your agent publishes one during setup. It's private until you share it.",
      "Open your first page, type @ in a comment and pick your agent. It replies in the thread.",
      "Your first page has a question from your agent. Pick an option.",
    ])
      expect(c.textContent).toContain(t);
    // The sixth step is the Welcome's, never the card's.
    expect(c.textContent).not.toContain("Also try");
  });

  it("Hide hides it (dismissed), and nothing marks it done", async () => {
    const puts = calls("PUT");
    mountHosted("/", true, as("member", setup()), [
      onboarding(),
      put(),
      empty(),
    ]);
    await waitFor(() => expect(card()).not.toBeNull());
    (await screen.findByRole("button", { name: "Hide" })).click();
    await waitFor(() =>
      expect(
        puts.filter((c) => c.path === "/api/v1/onboarding").map((c) => c.body),
      ).toEqual([{ dismissed: true }]),
    );
  });

  it("stays away once hidden (per person)", async () => {
    mountHosted("/", true, as("member", setup({ hiddenAt: T })), [
      onboarding(),
      empty(),
    ]);
    await screen.findByRole("heading", { name: "Library" });
    await new Promise((r) => setTimeout(r, 200));
    expect(card()).toBeNull();
  });

  it("an admin gets it too", async () => {
    mountHosted("/", true, as("admin", setup()), [onboarding(), empty()]);
    await waitFor(() => expect(card()).not.toBeNull());
  });
});

describe("a guest", () => {
  it("has no card, and sees the note where a member would publish", async () => {
    mountHosted(
      "/shared",
      true,
      as("guest", { instanceOwner: { name: "Bob Builder" } }),
      [onboarding()],
    );
    expect(
      await screen.findByText(
        "Guests can read and comment. To publish, ask Bob Builder to make you a member.",
      ),
    ).toBeTruthy();
    expect(card()).toBeNull();
  });

  it("without the owner's name, says the owner (PLACEHOLDER)", async () => {
    mountHosted("/shared", true, as("guest"), [onboarding()]);
    expect(
      await screen.findByText(
        "Guests can read and comment. To publish, ask the owner to make you a member.",
      ),
    ).toBeTruthy();
  });
});
