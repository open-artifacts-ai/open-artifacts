// #2632 (member onboarding, slice 1): the adapter (api/myOnboarding.ts), a member's Library card (five steps, Hide; hidden
// isn't done), and a guest's note where a member would publish.
import { type Me, OnboardingSchema } from "@oa/shared";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { firstName, fiveOf, mySteps } from "../src/api/myOnboarding";
import { calls, installHarness, mountHosted, page } from "./harness";

installHarness();
// Each test is its own session.
beforeEach(() => sessionStorage.clear());

const onboarding = (over: object = {}) =>
  http.get("*/api/v1/onboarding", () =>
    HttpResponse.json({
      dismissed: false,
      completed: false,
      firstArtifact: null,
      agentConnected: true,
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
// The contract: R.onboarding refuses a guest.
const refused = () =>
  http.get("*/api/v1/onboarding", () =>
    HttpResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    ),
  );
const refusedPut = () =>
  http.put("*/api/v1/onboarding", () =>
    HttpResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    ),
  );
const card = () => document.querySelector("section[data-member]");
const empty = () => http.get("*/api/v1/artifacts", () => page([], null));

describe("myOnboarding (the #2639 contract)", () => {
  it("reads the caller's own steps from R.onboarding", () => {
    const s = mySteps({
      dismissed: false,
      completed: false,
      agentConnected: true,
      agentNamed: true,
      firstArtifact: null,
      teamStep: true,
    });
    expect(fiveOf(s)).toEqual([true, true, false, false, false]);
    expect(s.team).toBe(true);
  });

  it("hidden is not done, and the sixth never counts", () => {
    const s = mySteps({ dismissed: true, completed: false, teamStep: true });
    expect(s.hidden).toBe(true);
    expect(s.completed).toBe(false);
    expect(fiveOf(s).some(Boolean)).toBe(false);
  });

  it("parses teamStep and invitedBy; an older server's answer still parses", () => {
    expect(
      OnboardingSchema.parse({
        dismissed: false,
        completed: false,
        teamStep: false,
        invitedBy: { name: "Bob Builder" },
      }).invitedBy?.name,
    ).toBe("Bob Builder");
    expect(
      OnboardingSchema.safeParse({ dismissed: false, completed: false })
        .success,
    ).toBe(true);
  });

  it("first name is the first word", () => {
    expect(firstName("  Ada Lovelace ")).toBe("Ada");
    expect(firstName("")).toBeNull();
    expect(firstName(null)).toBeNull();
  });
});

describe("a member's Library card", () => {
  // The results never wait on R.onboarding: the card's slot is held instead.
  it("the results render before R.onboarding answers, under a held slot", async () => {
    let answer: (over?: object) => void = () => {};
    const gate = new Promise<object>((r) => {
      answer = (over = {}) => r(over);
    });
    mountHosted("/", true, as("member"), [
      http.get("*/api/v1/onboarding", async () =>
        HttpResponse.json({
          dismissed: false,
          completed: false,
          firstArtifact: null,
          agentConnected: true,
          ...(await gate),
        }),
      ),
    ]);
    await waitFor(() =>
      expect(document.querySelector("article.lib-card")).not.toBeNull(),
    );
    const slot = document.querySelector("[data-member-slot]");
    expect(slot).not.toBeNull();
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(card()).toBeNull();
    answer();
    await waitFor(() => expect(card()).not.toBeNull());
    expect(document.querySelector("[data-member-slot]")).toBeNull();
  });

  it("a failed R.onboarding collapses the slot; the results stay", async () => {
    mountHosted("/", true, as("member"), [
      http.get("*/api/v1/onboarding", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    ]);
    await waitFor(() =>
      expect(document.querySelector("article.lib-card")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-member-slot]")).toBeNull(),
    );
    expect(card()).toBeNull();
  });

  it("a hidden card leaves no slot", async () => {
    mountHosted("/", true, as("member"), [onboarding({ dismissed: true })]);
    await waitFor(() =>
      expect(document.querySelector("article.lib-card")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-member-slot]")).toBeNull(),
    );
    expect(card()).toBeNull();
  });

  it("shows the same five steps with the design's words, and Hide", async () => {
    mountHosted("/", true, as("member"), [onboarding(), empty()]);
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
    mountHosted("/", true, as("member"), [onboarding(), put(), empty()]);
    await waitFor(() => expect(card()).not.toBeNull());
    (await screen.findByRole("button", { name: "Hide" })).click();
    await waitFor(() =>
      expect(
        puts.filter((c) => c.path === "/api/v1/onboarding").map((c) => c.body),
      ).toEqual([{ dismissed: true }]),
    );
  });

  // Today's server refuses a member's PUT: not saved, no error, still hidden.
  it("a refused Hide (403) hides it for the session, with no error", async () => {
    const puts = calls("PUT");
    mountHosted("/", true, as("member"), [onboarding(), refusedPut(), empty()]);
    await waitFor(() => expect(card()).not.toBeNull());
    (await screen.findByRole("button", { name: "Hide" })).click();
    await waitFor(() => expect(card()).toBeNull());
    await new Promise((r) => setTimeout(r, 200));
    expect(card()).toBeNull();
    expect(puts.filter((c) => c.path === "/api/v1/onboarding")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Couldn't save that.");
    // A fresh mount in the same session still keeps it hidden.
    cleanup();
    mountHosted("/", true, as("member"), [onboarding(), empty()]);
    await screen.findByRole("heading", { name: "Library" });
    await new Promise((r) => setTimeout(r, 200));
    expect(card()).toBeNull();
  });

  it("a refused done (403) shows no error", async () => {
    const puts = calls("PUT");
    mountHosted("/", true, as("member"), [
      onboarding({
        agentNamed: true,
        firstArtifact: { id: "a1", title: "A" },
        mentionReplied: true,
        askAnswered: true,
      }),
      refusedPut(),
      empty(),
    ]);
    await waitFor(() =>
      expect(
        puts.filter((c) => c.path === "/api/v1/onboarding").map((c) => c.body),
      ).toEqual([{ completed: true }]),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(card()).toBeNull();
    expect(document.body.textContent).not.toContain("Couldn't save that.");
  });

  it("stays away once hidden (per person)", async () => {
    mountHosted("/", true, as("member"), [
      onboarding({ dismissed: true }),
      empty(),
    ]);
    await screen.findByRole("heading", { name: "Library" });
    await new Promise((r) => setTimeout(r, 200));
    expect(card()).toBeNull();
  });

  it("an admin gets it too", async () => {
    mountHosted("/", true, as("admin"), [onboarding(), empty()]);
    await waitFor(() => expect(card()).not.toBeNull());
  });
});

describe("a guest", () => {
  it("has no card, and sees the note where a member would publish", async () => {
    mountHosted(
      "/shared",
      true,
      as("guest", { instanceOwner: { name: "Bob Builder" } }),
      [refused()],
    );
    expect(
      await screen.findByText(
        "Guests can read and comment. To publish, ask Bob Builder to make you a member.",
      ),
    ).toBeTruthy();
    expect(card()).toBeNull();
  });

  it("without the owner's name, says an owner", async () => {
    mountHosted("/shared", true, as("guest"), [refused()]);
    expect(
      await screen.findByText(
        "Guests can read and comment. To publish, ask an owner to make you a member.",
      ),
    ).toBeTruthy();
  });
});
