import type { Me } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mount, mountHosted, page, server } from "./harness";

installHarness();

const none = () => http.get("*/api/v1/artifacts", () => page([], null));
const noTokens = () => [
  http.get("*/api/v1/tokens", () => HttpResponse.json([])),
  http.get("*/api/v1/oauth-clients", () => HttpResponse.json([])),
  http.get("*/api/v1/members", () =>
    HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
  ),
];
const owner = (m: Me): Me => ({ ...m, user: { ...m.user, role: "owner" } });
const seedFirst = (v: "1" | "0" = "1") =>
  localStorage.setItem(`oa.getStarted.first.${fixtures.me.user.id}`, v);
const billing = (over: Record<string, unknown>) => (m: Me) => {
  const o = owner(m);
  return {
    ...o,
    instance: {
      ...o.instance,
      billing: {
        tier: "solo",
        status: "active",
        trialEndsAt: null,
        graceUntil: null,
        readOnly: false,
        reason: "solo",
        ...over,
      },
    } as Me["instance"],
  };
};
const trialLine = /14-day trial of Business/;
const heading = () => screen.findByRole("heading", { name: "Get started" });

describe("Get started checklist", () => {
  it("shows the three steps to the owner with the setup prompt", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
    expect(screen.getByText("Connect your agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup prompt")).toHaveValue(
      `Set up Open Artifacts for me: follow ${location.origin}/llms.txt\nSign in through the browser. Never ask me to paste a token into this chat.`,
    );
    expect(screen.getByText("Waiting for your agent…")).toBeInTheDocument();
    expect(screen.getByText("Publish your first artifact")).toBeInTheDocument();
  });

  it("ticks the connection from a token, then the artifact", async () => {
    seedFirst();
    server.use(
      none(),
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Your agent is connected.")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for the first artifact…"),
    ).toBeInTheDocument();
  });

  it("is not shown to invited members", async () => {
    mountHosted(
      "/",
      true,
      (m) => ({ ...m, user: { ...m.user, role: "member" } }),
      [none(), ...noTokens()],
    );
    await screen.findByText("No artifacts yet");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("ticks the invite once someone else is a member", async () => {
    seedFirst();
    server.use(none(), ...noTokens());
    server.use(
      http.get("*/api/v1/members", () => HttpResponse.json(fixtures.members)),
    );
    mount("/");
    await heading();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invite people" })).toBeNull();
  });

  it("hides on Hide and stays hidden", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull(),
    );
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith("oa.getStarted.hidden"),
      ),
    ).toBe(true);
  });

  it("leaves on its own once all three steps are done", async () => {
    mount("/");
    await screen.findByRole("link", { name: fixtures.artifacts[0]?.title });
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("omits the trial line off Solo (self-hosted)", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  const hosted = (over: Record<string, unknown>) =>
    mountHosted("/", true, billing(over), [none(), ...noTokens()]);

  it("says the trial line on Solo and free when a trial can start", async () => {
    hosted({});
    await heading();
    expect(
      screen.getByText(
        "Inviting someone starts a 14-day trial of Business. Your Solo plan stays as it is.",
      ),
    ).toBeInTheDocument();
  });

  it("says the trial line on the free tier", async () => {
    hosted({ tier: "free" });
    await heading();
    expect(screen.getByText(trialLine)).toBeInTheDocument();
    expect(screen.queryByText(/Solo plan/)).toBeNull();
  });

  it("marks the current step", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    const cur = document.querySelector('[aria-current="step"]');
    expect(cur).toHaveTextContent("Connect your agent");
    expect(cur).toHaveTextContent("(current step)");
  });

  it("is not first run when another member already exists", async () => {
    server.use(
      none(),
      http.get("*/api/v1/tokens", () => HttpResponse.json([])),
      http.get("*/api/v1/oauth-clients", () => HttpResponse.json([])),
      http.get("*/api/v1/members", () => HttpResponse.json(fixtures.members)),
    );
    mount("/");
    await screen.findByText("No artifacts yet");
    await waitFor(() =>
      expect(
        localStorage.getItem(`oa.getStarted.first.${fixtures.me.user.id}`),
      ).toBe("0"),
    );
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("omits the trial line once a trial was used", async () => {
    hosted({ trialEndsAt: "2026-01-01T00:00:00.000Z" });
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  it("omits the trial line when paused or read-only", async () => {
    hosted({ readOnly: true, status: "lapsed", reason: "solo_unpaid" });
    await heading();
    expect(screen.queryByText(trialLine)).toBeNull();
  });

  it("offers Invite people and Not now only at step 3", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(screen.queryByRole("link", { name: "Invite people" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("Not now hides the checklist once the first artifact exists", async () => {
    seedFirst();
    mount("/");
    // Default fixtures: a token and artifacts, but only the owner as member.
    server.use(
      http.get("*/api/v1/members", () =>
        HttpResponse.json(fixtures.members.filter((m) => m.role === "owner")),
      ),
    );
    await heading();
    expect(
      screen.getByRole("link", { name: "Invite people" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull(),
    );
  });

  it("is first-run only: an owner who already has a connection never sees it", async () => {
    mount("/");
    await screen.findByRole("link", { name: fixtures.artifacts[0]?.title });
    await waitFor(() =>
      expect(
        localStorage.getItem(`oa.getStarted.first.${fixtures.me.user.id}`),
      ).toBe("0"),
    );
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("records the first run when shown, and keeps showing after connecting", async () => {
    server.use(none(), ...noTokens());
    mount("/");
    await heading();
    expect(
      localStorage.getItem(`oa.getStarted.first.${fixtures.me.user.id}`),
    ).toBe("1");
  });

  it("stays away when decided not first-run, even with an empty Library", async () => {
    seedFirst("0");
    server.use(none(), ...noTokens());
    mount("/");
    await screen.findByText("No artifacts yet");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });
});
