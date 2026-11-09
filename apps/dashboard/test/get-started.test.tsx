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
    expect(screen.queryByText(/14-day trial of Business/)).toBeNull();
  });

  it("says the trial line on Solo, hosted", async () => {
    mountHosted(
      "/",
      true,
      (m) => {
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
            },
          } as Me["instance"],
        };
      },
      [none(), ...noTokens()],
    );
    await heading();
    expect(
      screen.getByText(
        "Inviting someone starts a 14-day trial of Business. Your Solo plan stays as it is.",
      ),
    ).toBeInTheDocument();
  });
});
